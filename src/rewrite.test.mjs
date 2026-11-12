import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PDFDocument, PDFDict, PDFName, StandardFonts, decodePDFRawStream } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { applyEdits } from './rewrite.js';

async function runsOf(bytes) {
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
  const { items } = await (await pdf.getPage(1)).getTextContent();
  return items
    .filter((i) => i.str?.trim())
    .map((i) => ({ str: i.str, size: +Math.hypot(i.transform[2], i.transform[3]).toFixed(2) }));
}

async function docWithText(line) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.TimesRoman);
  doc.addPage([400, 120]).drawText(line, { x: 20, y: 60, size: 13, font });
  return PDFDocument.load(await doc.save());
}

test('replaces the text and leaves font and size alone', async () => {
  const doc = await docWithText('Acme Corp bills Acme Corp');
  const { bytes, failed } = await applyEdits(doc, [
    { id: 'a', pageIndex: 0, from: 'Acme Corp bills Acme Corp', to: 'Globex Ltd bills Globex Ltd' },
  ]);
  assert.deepEqual(failed, []);
  const runs = await runsOf(bytes);
  assert.equal(runs[0].str, 'Globex Ltd bills Globex Ltd');
  assert.equal(runs[0].size, 13); // unchanged
  // the original characters are gone, not painted over
  assert.equal(runs.filter((r) => r.str.includes('Acme')).length, 0);
});

test('handles a match spanning a kerned TJ array', async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([400, 120]);
  page.drawText('seed', { x: 0, y: 0, size: 1, font }); // puts the font in Resources
  const ctx = page.node.context;
  const key = [...page.node.Resources().lookup(PDFName.of('Font'), PDFDict).keys()][0];
  const src = `BT ${key.toString()} 14 Tf 20 60 Td [(Ac) -35 (me ) 18 (Corp) -10 ( here)] TJ ET`;
  page.node.set(
    PDFName.of('Contents'),
    ctx.register(ctx.flateStream(Uint8Array.from(src, (c) => c.charCodeAt(0)))),
  );
  const loaded = await PDFDocument.load(await doc.save());
  const { bytes, failed } = await applyEdits(loaded, [
    { id: 'a', pageIndex: 0, from: 'Acme Corp', to: 'Globex Ltd' },
  ]);
  assert.deepEqual(failed, []);
  const text = (await runsOf(bytes)).map((r) => r.str).join('');
  assert.match(text, /Globex Ltd here/);
});

test('reports edits the font cannot encode instead of mangling them', async () => {
  const doc = await docWithText('Total due now');
  const { bytes, failed } = await applyEdits(doc, [
    { id: 'bad', pageIndex: 0, from: 'Total due now', to: '合計 now' },
  ]);
  assert.deepEqual(failed, ['bad']);
  assert.equal((await runsOf(bytes))[0].str, 'Total due now'); // left untouched
});

test('reports a run it cannot find', async () => {
  const doc = await docWithText('Hello');
  const { failed } = await applyEdits(doc, [
    { id: 'x', pageIndex: 0, from: 'Not in this file', to: 'y' },
  ]);
  assert.deepEqual(failed, ['x']);
});

test('keeps a longer replacement inside the space it had', async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([400, 100]);
  page.drawText('1', { x: 100, y: 50, size: 11, font }); // narrow cell
  page.drawText('4500', { x: 200, y: 50, size: 11, font }); // next column
  const loaded = await PDFDocument.load(await doc.save());

  const { bytes, failed } = await applyEdits(loaded, [
    {
      id: 'a',
      pageIndex: 0,
      from: '1',
      to: '200,000,000.00 USD',
      geom: { x: 100, size: 11, pageRight: 400, neighbours: [200] },
    },
  ]);
  assert.deepEqual(failed, []);

  const pdf = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
  const runs = (await (await pdf.getPage(1)).getTextContent()).items.filter((i) => i.str?.trim());
  const edited = runs.find((r) => r.str.includes('200,000,000.00'));
  assert.ok(edited, 'replacement is on the page');
  assert.equal(+Math.hypot(edited.transform[2], edited.transform[3]).toFixed(1), 11); // size untouched
  const next = runs.find((r) => r.transform[4] >= 199 && r.str.includes('4500'));
  if (next) assert.ok(edited.transform[4] + edited.width <= next.transform[4] + 0.5, 'does not reach the next column');
});

test('leaves a replacement that already fits alone', async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([400, 100]).drawText('1', { x: 100, y: 50, size: 11, font });
  const loaded = await PDFDocument.load(await doc.save());
  const { bytes } = await applyEdits(loaded, [
    { id: 'a', pageIndex: 0, from: '1', to: '27', geom: { x: 100, size: 11, pageRight: 400, neighbours: [300] } },
  ]);
  const raw = Buffer.from(bytes).toString('latin1');
  assert.ok(!raw.includes('Tz'), 'no squeeze when there is room');
});

// A right-aligned column: every amount shares a right edge, nothing else.
async function rightAlignedDoc(values, right = 250) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([300, 300]);
  values.forEach((v, i) => {
    page.drawText('Label', { x: 30, y: 260 - i * 30, size: 12, font });
    page.drawText(v, { x: right - font.widthOfTextAtSize(v, 12), y: 260 - i * 30, size: 12, font });
  });
  return { doc: await PDFDocument.load(await doc.save()), right };
}

function geomFor(runs, it, view) {
  const size = Math.hypot(it.transform[2], it.transform[3]);
  const x = it.transform[4];
  const y = it.transform[5];
  let onLeft = 0;
  let onRight = 0;
  for (const o of runs) {
    if (o === it) continue;
    if (Math.abs(o.transform[4] - x) <= 1) onLeft += 1;
    if (Math.abs(o.transform[4] + o.width - (x + it.width)) <= 1) onRight += 1;
  }
  const sameLine = runs.filter((o) => o !== it && Math.abs(o.transform[5] - y) <= size * 0.35);
  return {
    x, size, rightAligned: onRight > onLeft, pageRight: view[2],
    leftLimit: sameLine.map((o) => o.transform[4] + o.width).filter((r) => r <= x + 0.5)
      .reduce((a, b) => Math.max(a, b), view[0]),
    neighbours: sameLine.map((o) => o.transform[4]).sort((a, b) => a - b),
  };
}

async function editInColumn(values, target, to) {
  const { doc, right } = await rightAlignedDoc(values);
  const probe = await pdfjs.getDocument({ data: await doc.save() }).promise;
  const page = await probe.getPage(1);
  const runs = (await page.getTextContent()).items.filter((i) => i.str?.trim());
  const it = runs.find((r) => r.str === target);
  const fresh = await PDFDocument.load(await (await rightAlignedDoc(values)).doc.save());
  const { bytes, failed } = await applyEdits(fresh, [
    { id: 'a', pageIndex: 0, from: target, to, geom: geomFor(runs, it, page.view) },
  ]);
  assert.deepEqual(failed, []);
  const after = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
  const got = (await (await after.getPage(1)).getTextContent()).items.filter((i) => i.str?.trim());
  // a squeezed run can read back merged with its label, so match on the tail
  const reloaded = await PDFDocument.load(bytes);
  const stream = decodePDFRawStream(reloaded.getPages()[0].node.Contents()).decode();
  return {
    run: got.find((r) => r.str.endsWith(to)),
    right,
    ops: Buffer.from(stream).toString('latin1'),
  };
}

const VALUES = ['225.00', '9.00', '14.00', '8.00', '10.00', '6.92', '20.00'];

test('a longer value in a right-aligned column keeps its right edge', async () => {
  const { run, right } = await editInColumn(VALUES, '9.00', '200.00');
  assert.ok(run, 'replacement is on the page');
  assert.ok(Math.abs(run.transform[4] + run.width - right) < 1, `right edge held at ${right}`);
  assert.equal(+Math.hypot(run.transform[2], run.transform[3]).toFixed(1), 12);
});

test('a shorter value keeps its right edge too', async () => {
  const { run, right } = await editInColumn(VALUES, '225.00', '7.00');
  assert.ok(Math.abs(run.transform[4] + run.width - right) < 1);
});

test('a value with no room left is squeezed, not spilled', async () => {
  const { run, right, ops } = await editInColumn(VALUES, '9.00', '999,888,777,666,555,444,333,222.00');
  assert.ok(run, 'replacement is on the page');
  assert.ok(Math.abs(run.transform[4] + run.width - right) < 1, 'still ends at the column edge');
  assert.ok(/ Tz\b/.test(ops), 'squeezed rather than spilled past the column');
  assert.equal(+Math.hypot(run.transform[2], run.transform[3]).toFixed(1), 12, 'size untouched');
});
