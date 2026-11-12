// Edits text in place inside the PDF's own content streams: only the string
// operands of the text-showing operators change. Font, size, colour, position
// and every other operator are left exactly as they were, and the original
// characters are genuinely gone rather than painted over.
import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFRawStream,
  decodePDFRawStream,
} from "pdf-lib";
import { Encodings, Font, FontNames } from "@pdf-lib/standard-fonts";

const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIM = new Set([
  0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25,
]);
const latin1 = (b, s, e) => {
  let o = "";
  for (let i = s; i < e; i++) o += String.fromCharCode(b[i]);
  return o;
};

// WinAnsi differs from Latin-1 only in 0x80-0x9f.
const WIN_HIGH = {
  0x80: "€",
  0x82: "‚",
  0x83: "ƒ",
  0x84: "„",
  0x85: "…",
  0x86: "†",
  0x87: "‡",
  0x88: "ˆ",
  0x89: "‰",
  0x8a: "Š",
  0x8b: "‹",
  0x8c: "Œ",
  0x8e: "Ž",
  0x91: "‘",
  0x92: "’",
  0x93: "“",
  0x94: "”",
  0x95: "•",
  0x96: "–",
  0x97: "—",
  0x98: "˜",
  0x99: "™",
  0x9a: "š",
  0x9b: "›",
  0x9c: "œ",
  0x9e: "ž",
  0x9f: "Ÿ",
};

/* ---------- content-stream tokenizer ---------- */

function skipLiteral(b, i) {
  let depth = 0;
  for (; i < b.length; i++) {
    const c = b[i];
    if (c === 0x5c) {
      i++;
      continue;
    } // backslash escapes the next byte
    if (c === 0x28) depth++;
    else if (c === 0x29 && --depth === 0) return i + 1;
  }
  return b.length;
}

function skipInlineImage(b, i) {
  for (; i < b.length - 1; i++) {
    if (
      WS.has(b[i]) &&
      b[i + 1] === 0x45 &&
      b[i + 2] === 0x49 &&
      (i + 3 >= b.length || WS.has(b[i + 3]) || DELIM.has(b[i + 3]))
    )
      return i + 3;
  }
  return b.length;
}

function tokenize(b) {
  const out = [];
  let i = 0;
  while (i < b.length) {
    const c = b[i];
    if (WS.has(c)) {
      i++;
      continue;
    }
    if (c === 0x25) {
      while (i < b.length && b[i] !== 0x0a && b[i] !== 0x0d) i++;
      continue;
    }
    if (c === 0x28) {
      const s = i;
      i = skipLiteral(b, i);
      out.push({ t: "str", s, e: i, hex: false });
      continue;
    }
    if (c === 0x3c && b[i + 1] === 0x3c) {
      out.push({ t: "<<", s: i, e: i + 2 });
      i += 2;
      continue;
    }
    if (c === 0x3e && b[i + 1] === 0x3e) {
      out.push({ t: ">>", s: i, e: i + 2 });
      i += 2;
      continue;
    }
    if (c === 0x3c) {
      const s = i;
      while (i < b.length && b[i] !== 0x3e) i++;
      i++;
      out.push({ t: "str", s, e: i, hex: true });
      continue;
    }
    if (c === 0x5b || c === 0x5d) {
      out.push({ t: String.fromCharCode(c), s: i, e: i + 1 });
      i++;
      continue;
    }
    if (c === 0x2f) {
      const s = i++;
      while (i < b.length && !WS.has(b[i]) && !DELIM.has(b[i])) i++;
      out.push({ t: "name", s, e: i, v: latin1(b, s + 1, i) });
      continue;
    }
    if (c === 0x7b || c === 0x7d) {
      i++;
      continue;
    }
    const s = i;
    while (i < b.length && !WS.has(b[i]) && !DELIM.has(b[i])) i++;
    if (i === s) {
      i++;
      continue;
    }
    const v = latin1(b, s, i);
    if (/^[-+.\d]/.test(v))
      out.push({ t: "num", s, e: i, v: parseFloat(v) || 0 });
    else {
      out.push({ t: "op", s, e: i, v });
      if (v === "ID") i = skipInlineImage(b, i);
    }
  }
  return out;
}

function strBytes(b, tok) {
  if (tok.hex) {
    let h = latin1(b, tok.s + 1, tok.e - 1).replace(/[^0-9a-fA-F]/g, "");
    if (h.length % 2) h += "0";
    const o = new Uint8Array(h.length / 2);
    for (let k = 0; k < o.length; k++)
      o[k] = parseInt(h.slice(k * 2, k * 2 + 2), 16);
    return o;
  }
  const o = [];
  for (let i = tok.s + 1; i < tok.e - 1; i++) {
    let c = b[i];
    if (c !== 0x5c) {
      o.push(c);
      continue;
    }
    c = b[++i];
    if (c >= 0x30 && c <= 0x37) {
      let v = c - 0x30;
      for (let k = 0; k < 2 && b[i + 1] >= 0x30 && b[i + 1] <= 0x37; k++)
        v = v * 8 + (b[++i] - 0x30);
      o.push(v & 0xff);
    } else if (c === 0x6e) o.push(10);
    else if (c === 0x72) o.push(13);
    else if (c === 0x74) o.push(9);
    else if (c === 0x62) o.push(8);
    else if (c === 0x66) o.push(12);
    else if (c === 0x0a) {
      /* line continuation */
    } else if (c === 0x0d) {
      if (b[i + 1] === 0x0a) i++;
    } else o.push(c);
  }
  return Uint8Array.from(o);
}

const toHex = (bytes) => {
  let h = "";
  for (const x of bytes) h += x.toString(16).padStart(2, "0");
  return `<${h}>`;
};

/* ---------- character maps ---------- */

function parseToUnicode(text) {
  const toUni = new Map();
  const chr = (h) => {
    let s = "";
    for (let i = 0; i < h.length; i += 4)
      s += String.fromCharCode(parseInt(h.slice(i, i + 4), 16));
    return s;
  };
  for (const [, body] of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g))
    for (const [, src, dst] of body.matchAll(
      /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g,
    ))
      toUni.set(parseInt(src, 16), chr(dst));
  for (const [, body] of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const re =
      /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F]*)>|\[([\s\S]*?)\])/g;
    for (const [, lo, hi, dst, arr] of body.matchAll(re)) {
      const a = parseInt(lo, 16);
      const b = parseInt(hi, 16);
      if (arr !== undefined) {
        const list = [...arr.matchAll(/<([0-9a-fA-F]*)>/g)];
        for (let k = 0; k <= b - a && k < list.length; k++)
          toUni.set(a + k, chr(list[k][1]));
      } else {
        const base = chr(dst);
        for (let k = 0; k <= b - a; k++)
          toUni.set(
            a + k,
            base.slice(0, -1) +
              String.fromCharCode(base.charCodeAt(base.length - 1) + k),
          );
      }
    }
  }
  return toUni;
}

const STD14 = {
  Helvetica: FontNames.Helvetica,
  Arial: FontNames.Helvetica,
  "Helvetica-Bold": FontNames.HelveticaBold,
  "Arial-Bold": FontNames.HelveticaBold,
  "Helvetica-Oblique": FontNames.HelveticaOblique,
  "Helvetica-BoldOblique": FontNames.HelveticaBoldOblique,
  "Times-Roman": FontNames.TimesRoman,
  TimesNewRoman: FontNames.TimesRoman,
  "Times-Bold": FontNames.TimesRomanBold,
  "Times-Italic": FontNames.TimesRomanItalic,
  "Times-BoldItalic": FontNames.TimesRomanBoldItalic,
  Courier: FontNames.Courier,
  "Courier-Bold": FontNames.CourierBold,
  "Courier-Oblique": FontNames.CourierOblique,
  "Courier-BoldOblique": FontNames.CourierBoldOblique,
};

// Glyph advances in 1/1000 em — the same numbers the viewer lays the page out
// with, so a fitted run measures exactly as it will render.
function widthLookup(fontDict, twoByte) {
  const first = fontDict
    .lookupMaybe(PDFName.of("FirstChar"), PDFNumber)
    ?.asNumber();
  const widths = fontDict.lookupMaybe(PDFName.of("Widths"), PDFArray);
  if (widths && first != null) {
    const miss =
      fontDict
        .lookupMaybe(PDFName.of("FontDescriptor"), PDFDict)
        ?.lookupMaybe(PDFName.of("MissingWidth"), PDFNumber)
        ?.asNumber() ?? 0;
    const w = [];
    for (let i = 0; i < widths.size(); i++)
      w.push(widths.lookup(i, PDFNumber)?.asNumber() ?? miss);
    return (code) => w[code - first] ?? miss;
  }

  if (twoByte) {
    const desc = fontDict
      .lookupMaybe(PDFName.of("DescendantFonts"), PDFArray)
      ?.lookupMaybe(0, PDFDict);
    if (!desc) return null;
    const dw =
      desc.lookupMaybe(PDFName.of("DW"), PDFNumber)?.asNumber() ?? 1000;
    const W = desc.lookupMaybe(PDFName.of("W"), PDFArray);
    const map = new Map();
    if (W) {
      let i = 0;
      while (i < W.size()) {
        const c = W.lookup(i, PDFNumber)?.asNumber();
        const second = W.lookup(i + 1);
        if (second instanceof PDFArray) {
          for (let k = 0; k < second.size(); k++)
            map.set(c + k, second.lookup(k, PDFNumber)?.asNumber() ?? dw);
          i += 2;
        } else {
          const c2 = W.lookup(i + 1, PDFNumber)?.asNumber();
          const w = W.lookup(i + 2, PDFNumber)?.asNumber() ?? dw;
          for (let k = c; k <= c2; k++) map.set(k, w);
          i += 3;
        }
      }
    }
    return (code) => map.get(code) ?? dw;
  }

  // standard 14: no /Widths in the file, the metrics are built into the viewer
  const base = fontDict
    .get(PDFName.of("BaseFont"))
    ?.toString()
    .replace(/^\/(?:[A-Z]{6}\+)?/, "");
  const std = STD14[base];
  if (!std) return null;
  let metrics;
  try {
    metrics = Font.load(std);
  } catch {
    return null;
  }
  return (code, ch) => {
    try {
      const g = Encodings.WinAnsi.encodeUnicodeCodePoint(ch.codePointAt(0));
      return metrics.getWidthOfGlyph(g.name) ?? null;
    } catch {
      return null;
    }
  };
}

function buildMap(fontDict) {
  const twoByte = fontDict?.get(PDFName.of("Subtype"))?.toString() === "/Type0";
  let toUni = null;
  const tu = fontDict?.lookupMaybe?.(PDFName.of("ToUnicode"), PDFRawStream);
  if (tu) {
    const raw = decodePDFRawStream(tu).decode();
    toUni = parseToUnicode(latin1(raw, 0, raw.length));
  }
  if (!toUni && twoByte) return null; // CID font with no ToUnicode: can't read or write it
  const enc = fontDict?.get(PDFName.of("Encoding"));
  if (!toUni && enc instanceof PDFDict && enc.get(PDFName.of("Differences")))
    return null;

  if (!toUni) {
    toUni = new Map();
    for (let c = 0; c < 256; c++)
      toUni.set(c, WIN_HIGH[c] ?? String.fromCharCode(c));
  }
  const fromUni = new Map();
  for (const [code, s] of toUni)
    if (s.length === 1 && !fromUni.has(s)) fromUni.set(s, code);
  const glyphWidth = widthLookup(fontDict, twoByte);

  return {
    decode(bytes) {
      let out = "";
      const step = twoByte ? 2 : 1;
      for (let i = 0; i + step <= bytes.length; i += step) {
        const code = twoByte ? (bytes[i] << 8) | bytes[i + 1] : bytes[i];
        const s = toUni.get(code);
        if (s === undefined) return null;
        out += s;
      }
      return out;
    },
    // total advance of `text` in 1/1000 em, or null if this font can't be measured
    widthOfText(text) {
      if (!glyphWidth) return null;
      let total = 0;
      for (const ch of text) {
        const code = fromUni.get(ch);
        if (code === undefined) return null;
        const w = glyphWidth(code, ch);
        if (w == null) return null;
        total += w;
      }
      return total;
    },
    encode(text) {
      const out = [];
      for (const ch of text) {
        const code = fromUni.get(ch);
        if (code === undefined) return null;
        if (twoByte) out.push((code >> 8) & 0xff, code & 0xff);
        else out.push(code & 0xff);
      }
      return Uint8Array.from(out);
    },
  };
}

/* ---------- collect the editable text runs of one content stream ---------- */

function showOps(bytes, resources, mapCache) {
  const toks = tokenize(bytes);
  const ops = [];
  let font = null;
  let hscale = 100; // current Tz, so a fitted run can restore it afterwards
  let operands = [];
  const stack = [];

  const mapFor = (name) => {
    if (!mapCache.has(name)) {
      const fonts = resources?.lookupMaybe?.(PDFName.of("Font"), PDFDict);
      let dict = null;
      try {
        dict = fonts?.lookup(PDFName.of(name), PDFDict) ?? null;
      } catch {
        dict = null;
      }
      mapCache.set(name, dict ? buildMap(dict) : null);
    }
    return mapCache.get(name);
  };

  for (const tk of toks) {
    if (tk.t === "[") {
      stack.push({ prev: operands, open: tk.s });
      operands = [];
      continue;
    }
    if (tk.t === "]") {
      const frame = stack.pop();
      const arr = {
        t: "arr",
        items: operands,
        s: frame ? frame.open : tk.s,
        e: tk.e,
      };
      operands = frame ? frame.prev : [];
      operands.push(arr);
      continue;
    }
    if (tk.t !== "op") {
      operands.push(tk);
      continue;
    }

    const v = tk.v;
    if (v === "Tf") font = operands[operands.length - 2]?.v ?? font;
    else if (v === "Tz") hscale = operands[operands.length - 1]?.v ?? hscale;
    else if (v === "Tj" || v === "'" || v === '"' || v === "TJ") {
      const last = operands[operands.length - 1];
      let elems = null;
      let start = last?.s;
      if (v === "TJ" && last?.t === "arr") {
        elems = last.items.map((x) =>
          x.t === "str"
            ? { str: true, bytes: strBytes(bytes, x) }
            : { str: false, v: x.v },
        );
      } else if (last?.t === "str") {
        elems = [{ str: true, bytes: strBytes(bytes, last) }];
        if (v === '"') start = operands[operands.length - 3]?.s ?? start;
      }
      if (elems) {
        const map = mapFor(font);
        const texts = elems.map((x) => (x.str ? map?.decode(x.bytes) : null));
        ops.push({
          kind: v,
          start,
          end: tk.e,
          elems,
          texts,
          map,
          lead:
            v === '"'
              ? [
                  operands[operands.length - 3]?.v ?? 0,
                  operands[operands.length - 2]?.v ?? 0,
                ]
              : null,
          tz: hscale,
          ok: !!map && texts.every((t, i) => !elems[i].str || t !== null),
        });
      }
    }
    operands = [];
  }
  return ops;
}

function opText(op) {
  return op.elems.map((e, i) => (e.str ? op.texts[i] : "")).join("");
}

// Keep a rewritten run in the space it already had. A run in a right-aligned
// column keeps its right edge and grows leftwards; anything else grows to the
// right until it would reach its neighbour. Only when neither direction has the
// room is the run squeezed horizontally (Tz). The font and its size never change.
function fit(op, origText, newText, at, geom) {
  if (!geom || !geom.size) return;
  const unit = geom.size / 1000;
  const prefix = op.map.widthOfText(origText.slice(0, at));
  const wOld = op.map.widthOfText(origText);
  const wNew = op.map.widthOfText(newText);
  if (prefix == null || wOld == null || wNew == null) return;

  const start = geom.x - prefix * unit; // where this operator starts drawing
  const end = start + wOld * unit; // where it used to stop
  const want = wNew * unit;
  const canShift = op.kind === "Tj" || op.kind === "TJ";

  if (geom.rightAligned && canShift) {
    const floor = Math.min(geom.leftLimit + geom.size * 0.25, start);
    let newStart = end - want; // hold the right edge, grow left
    if (newStart < floor) {
      newStart = floor;
      const room = end - newStart;
      if (room > 0 && want > room) op.hscale = Math.max((room / want) * 100, 1);
    }
    let shift = (start - newStart) / unit; // 1/1000 em, positive moves left
    if (op.hscale) shift /= op.hscale / 100; // TJ offsets are scaled by Tz too
    if (Math.abs(shift) > 0.5) {
      op.shift = shift;
      op.shiftPoints = start - newStart; // reported back so the editor can follow
    }
    return;
  }

  const next = geom.neighbours.find((nx) => nx > end + 0.5) ?? geom.pageRight;
  if (!(next > start)) return;
  const keep = Math.min(Math.max(next - end, 0), geom.size * 0.25); // keep a gap
  const room = next - keep - start;
  if (room > 0 && want > room) op.hscale = Math.max((room / want) * 100, 1);
}

function spliceOp(op, from, to, geom) {
  if (!op.ok) return false;
  const text = opText(op);
  const at = text.indexOf(from);
  if (at < 0) return false;
  const end = at + from.length;

  let off = 0;
  let first = -1;
  let last = -1;
  let head = "";
  let tail = "";
  op.elems.forEach((e, i) => {
    if (!e.str) return;
    const len = op.texts[i].length;
    if (first < 0 && off + len > at) {
      first = i;
      head = op.texts[i].slice(0, at - off);
    }
    if (off < end && off + len >= end) {
      if (last < 0) {
        last = i;
        tail = op.texts[i].slice(end - off);
      }
    }
    off += len;
  });
  if (first < 0 || last < 0) return false;

  const merged = head + to + tail;
  const bytes = op.map.encode(merged);
  if (!bytes) return false; // replacement uses characters this font cannot show

  op.elems.splice(first, last - first + 1, { str: true, bytes });
  op.texts.splice(first, last - first + 1, merged);
  op.dirty = true;
  fit(op, text, opText(op), at, geom);
  return true;
}

function opSource(op) {
  const parts = op.elems.map((e) => (e.str ? toHex(e.bytes) : String(e.v)));
  let src;
  const shift = op.shift ? `${+op.shift.toFixed(2)} ` : "";
  if (op.kind === "TJ") src = `[${shift}${parts.join(" ")}] TJ`;
  else if (op.kind === '"') src = `${op.lead[0]} ${op.lead[1]} ${parts[0]} "`;
  else if (shift)
    src = `[${shift}${parts[0]}] TJ`; // a leading offset re-places the run
  else src = `${parts[0]} ${op.kind}`;
  if (op.hscale)
    src = `${+op.hscale.toFixed(3)} Tz ${src} ${+op.tz.toFixed(3)} Tz`;
  return src;
}

function rebuild(bytes, ops) {
  const dirty = ops.filter((o) => o.dirty).sort((a, b) => a.start - b.start);
  if (!dirty.length) return null;
  const chunks = [];
  let at = 0;
  for (const op of dirty) {
    chunks.push(bytes.subarray(at, op.start));
    chunks.push(Uint8Array.from(opSource(op), (c) => c.charCodeAt(0)));
    at = op.end;
  }
  chunks.push(bytes.subarray(at));
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}

/* ---------- every content stream reachable from a page, in drawing order ---------- */

function streamUnits(page) {
  const ctx = page.node.context;
  const units = [];
  const seen = new Set();

  const read = (obj) => {
    try {
      const d = decodePDFRawStream(obj).decode();
      return d instanceof Uint8Array ? d : null;
    } catch {
      return null;
    }
  };

  const walk = (bytes, resources, write) => {
    units.push({ bytes, resources, write });
    const xobjs = resources?.lookupMaybe?.(PDFName.of("XObject"), PDFDict);
    if (!xobjs) return;
    for (const [key] of xobjs.entries()) {
      const ref = xobjs.get(key);
      const id = ref?.toString?.() ?? key.toString();
      if (seen.has(id)) continue;
      seen.add(id);
      let xo = null;
      try {
        xo = xobjs.lookup(key);
      } catch {
        continue;
      }
      if (
        !xo?.dict ||
        xo.dict.get(PDFName.of("Subtype"))?.toString() !== "/Form"
      )
        continue;
      const sub = read(xo);
      if (!sub) continue;
      walk(
        sub,
        xo.dict.lookupMaybe?.(PDFName.of("Resources"), PDFDict) ?? resources,
        (nb) => {
          xobjs.set(
            key,
            ctx.register(
              ctx.flateStream(nb, { Subtype: "Form", ...pick(xo.dict) }),
            ),
          );
        },
      );
    }
  };

  const pick = (dict) => {
    const o = {};
    for (const [k, v] of dict.entries()) {
      const name = k.toString().slice(1);
      if (["Length", "Filter", "DecodeParms"].includes(name)) continue;
      o[name] = v;
    }
    return o;
  };

  const contents = page.node.Contents();
  if (!contents) return units;
  const list =
    contents instanceof PDFArray
      ? contents.asArray().map((r) => ctx.lookup(r))
      : [contents];
  const parts = list.map(read).filter(Boolean);
  if (!parts.length) return units;
  const joined = new Uint8Array(parts.reduce((n, p) => n + p.length + 1, 0));
  let p = 0;
  for (const part of parts) {
    joined.set(part, p);
    p += part.length;
    joined[p++] = 0x0a;
  }

  walk(joined, page.node.Resources(), (nb) => {
    page.node.set(PDFName.of("Contents"), ctx.register(ctx.flateStream(nb)));
  });
  return units;
}

/* ---------- public API ---------- */

/**
 * edits: [{ id, pageIndex, from, to, geom }] in document order, where geom is
 * { x, size, neighbours, pageRight, leftLimit, rightAligned } describing where
 * the run sits on the page and how its column is aligned.
 * Returns { bytes, failed: [id], placed } — `failed` lists edits the file would
 * not take (text inside a font we cannot re-encode, or a run we could not
 * locate); `placed` maps an id to how far left its run moved, in points.
 */
export async function applyEdits(doc, edits) {
  const failed = [];
  const placed = {}; // id -> how far left the run moved, in points
  const byPage = new Map();
  for (const e of edits) {
    if (!byPage.has(e.pageIndex)) byPage.set(e.pageIndex, []);
    byPage.get(e.pageIndex).push(e);
  }

  for (const [pageIndex, pageEdits] of byPage) {
    const page = doc.getPages()[pageIndex];
    if (!page) {
      failed.push(...pageEdits.map((e) => e.id));
      continue;
    }
    const units = streamUnits(page);
    const mapCache = new Map();
    const parsed = units.map((u) => ({
      ...u,
      ops: showOps(u.bytes, u.resources, mapCache),
    }));

    let cursor = 0; // ops already passed, so repeated words land in order
    const flat = parsed.flatMap((u, ui) => u.ops.map((op) => ({ op, ui })));
    for (const e of pageEdits) {
      let hit = -1;
      for (const probe of [e.from, e.from.trim()]) {
        if (!probe) continue;
        for (let i = cursor; i < flat.length; i++) {
          if (spliceOp(flat[i].op, probe, e.to, e.geom)) {
            hit = i;
            break;
          }
        }
        if (hit >= 0) break;
      }
      if (hit < 0) failed.push(e.id);
      else {
        cursor = hit; // same op may hold several runs
        const { op } = flat[hit];
        if (op.shiftPoints) placed[e.id] = op.shiftPoints;
      }
    }

    parsed.forEach((u) => {
      const next = rebuild(u.bytes, u.ops);
      if (next) u.write(next);
    });
  }

  return { bytes: await doc.save(), failed, placed };
}
