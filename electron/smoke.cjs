// Boots the packaged renderer exactly as the app does, opens a PDF in it and
// checks the text layer came up. Catches the things a unit test cannot: the
// app:// handler, the bundle executing, and the pdf.js worker loading.
const { app, protocol } = require('electron');
const { registerScheme, serve, createWindow } = require('./app.cjs');

registerScheme();

const fail = (msg) => {
  console.error('smoke: FAIL -', msg);
  app.exit(1);
};

app.whenReady().then(async () => {
  protocol.handle('app', serve);
  const win = createWindow({ show: false });

  const timer = setTimeout(() => fail('timed out'), 60000);
  try {
    await new Promise((res, rej) => {
      win.webContents.once('did-finish-load', res);
      win.webContents.once('did-fail-load', (_e, code, desc) => rej(new Error(`${code} ${desc}`)));
    });

    const report = await win.webContents.executeJavaScript(`(async () => {
      const dt = new DataTransfer();
      dt.items.add(new File([await (await fetch('/sample.pdf')).blob()], 's.pdf',
        { type: 'application/pdf' }));
      const i = document.querySelector('input[type=file]');
      i.files = dt.files;
      i.dispatchEvent(new Event('change', { bubbles: true }));
      for (let n = 0; n < 60 && document.querySelectorAll('.tx').length === 0; n++)
        await new Promise((r) => setTimeout(r, 250));
      return {
        status: document.querySelector('.foot p').textContent,
        pages: document.querySelectorAll('.page').length,
        runs: document.querySelectorAll('.tx').length,
        first: document.querySelector('.tx')?.textContent ?? null,
      };
    })()`);

    clearTimeout(timer);
    console.log('smoke:', JSON.stringify(report));
    if (report.pages !== 2) return fail(`expected 2 pages, got ${report.pages}`);
    if (report.runs < 5) return fail(`text layer empty (${report.runs} runs)`);
    if (report.first !== 'Acme Invoice 2026') return fail(`unexpected text: ${report.first}`);
    console.log('smoke: ok - renderer, app:// handler and pdf.js worker all live');
    app.exit(0);
  } catch (err) {
    clearTimeout(timer);
    fail(err.message);
  }
});
