import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { PDFDocument } from "pdf-lib";
import PdfPage from "./PdfPage";
import { applyEdits } from "./rewrite";
import { countMatches, replaceMatches } from "./text";

GlobalWorkerOptions.workerSrc = workerUrl;
const SCALE = 1.5;

export default function App() {
  const [pages, setPages] = useState([]);
  const [edits, setEdits] = useState({});
  const [find, setFind] = useState("");
  const [replace, setReplace] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [status, setStatus] = useState("");
  const [failed, setFailed] = useState(new Set());
  const [placed, setPlaced] = useState({});
  const [stale, setStale] = useState(false);
  const original = useRef(null); // untouched bytes for pdf-lib (pdf.js consumes its copy)
  const name = useRef("document.pdf");
  const basePages = useRef([]); // unedited page proxies, kept to restore reverted pages
  const preview = useRef(null); // pdf.js document of the edited file currently on screen
  const built = useRef(null); // the exact bytes the canvas was rendered from
  const [docId, setDocId] = useState(0);

  async function open(file) {
    if (!file) return;
    setStatus("Loading…");
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      original.current = bytes.slice();
      name.current = file.name;
      const pdf = await getDocument({ data: bytes }).promise;
      const out = [];
      for (let n = 1; n <= pdf.numPages; n++) {
        const page = await pdf.getPage(n);
        const vp = page.getViewport({ scale: SCALE });
        const [left, , right] = page.view;
        const { items, styles } = await page.getTextContent();
        out.push({
          num: n,
          page,
          vp,
          styles,
          left,
          right,
          items: items
            .map((it, i) => ({
              id: `${n}-${i}`,
              page: n,
              str: it.str,
              transform: it.transform,
              width: it.width,
              fontName: it.fontName,
            }))
            .filter((it) => it.str?.trim()),
        });
      }
      basePages.current = out.map((p) => p.page);
      preview.current = null;
      built.current = null;
      setPages(out);
      setEdits({});
      setFailed(new Set());
      setPlaced({});
      setStale(false);
      setDocId((d) => d + 1);
      setStatus(`${pdf.numPages} page${pdf.numPages > 1 ? "s" : ""}`);
    } catch (err) {
      setPages([]);
      setStatus(`Could not open this PDF — ${err.message}`);
    }
  }

  const onEdit = useCallback((id, text) => {
    setEdits((prev) => {
      if (prev[id] === text) return prev;
      setStale(true);
      return { ...prev, [id]: text };
    });
  }, []);

  const allItems = useMemo(() => pages.flatMap((p) => p.items), [pages]);
  const textOf = (it) => edits[it.id] ?? it.str;

  const matches = useMemo(() => {
    if (!find) return [];
    return allItems
      .map((it) => ({ it, n: countMatches(textOf(it), find, matchCase) }))
      .filter((m) => m.n > 0);
  }, [allItems, edits, find, matchCase]);

  const total = matches.reduce((a, m) => a + m.n, 0);
  const changed = allItems.filter((it) => textOf(it) !== it.str);
  // Where the run sits, so the engine can keep a longer replacement inside the
  // space it already occupies instead of running into the next column.
  const editList = () =>
    changed.map((it) => {
      const size = Math.hypot(it.transform[2], it.transform[3]) || 1;
      const y = it.transform[5];
      const x = it.transform[4];
      const page = pages[it.page - 1];

      // Which edge does this run's column line up on? Numbers in a right-aligned
      // column share a right edge and nothing else, so a longer value has to
      // grow leftwards to stay in the column.
      let onLeft = 0;
      let onRight = 0;
      for (const o of page.items) {
        if (o === it) continue;
        if (Math.abs(o.transform[4] - x) <= 1) onLeft += 1;
        if (Math.abs(o.transform[4] + o.width - (x + it.width)) <= 1)
          onRight += 1;
      }

      const sameLine = page.items.filter(
        (o) => o !== it && Math.abs(o.transform[5] - y) <= size * 0.35,
      );
      return {
        id: it.id,
        pageIndex: it.page - 1,
        from: it.str,
        to: textOf(it),
        geom: {
          x,
          size,
          rightAligned: onRight > onLeft,
          pageRight: page.right,
          leftLimit: sameLine
            .map((o) => o.transform[4] + o.width)
            .filter((r) => r <= x + 0.5)
            .reduce((a, b) => Math.max(a, b), page.left),
          neighbours: sameLine.map((o) => o.transform[4]).sort((a, b) => a - b),
        },
      };
    });

  // The one place an edited document is built. Preview and export MUST go
  // through this: a preview that used different inputs from the export is
  // exactly the bug this replaced.
  const buildEdited = async () =>
    applyEdits(await PDFDocument.load(original.current.slice()), editList());

  // Re-render the canvas from the real edited PDF, so what you see on the page
  // IS the output — the text layer never paints over it.
  useEffect(() => {
    if (!pages.length) return undefined;
    let dead = false;
    const timer = setTimeout(async () => {
      const list = editList();
      const dirty = new Set(list.map((e) => e.pageIndex));
      const fresh = [];
      if (dirty.size) {
        try {
          const { bytes, failed: bad, placed: moved } = await buildEdited();
          built.current = { bytes, failed: bad, placed: moved };
          if (!dead) setPlaced(moved);
          const pdf = await getDocument({ data: bytes.slice() }).promise;
          for (const i of dirty) fresh[i] = await pdf.getPage(i + 1);
          const old = preview.current;
          preview.current = pdf;
          setTimeout(() => old?.destroy?.().catch?.(() => {}), 1000);
        } catch {
          if (!dead) setStale(false);
          return;
        }
      }
      if (dead) return;
      setPages((prev) =>
        prev.map((p, i) => {
          const want = (dirty.has(i) && fresh[i]) || basePages.current[i];
          return p.page === want ? p : { ...p, page: want };
        }),
      );
      setStale(false);
    }, 150);
    return () => {
      dead = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edits, docId]);

  function replaceAll() {
    setEdits((prev) => {
      const next = { ...prev };
      for (const it of allItems) {
        const cur = next[it.id] ?? it.str;
        const r = replaceMatches(cur, find, replace, matchCase);
        if (r !== cur) next[it.id] = r;
      }
      return next;
    });
  }

  async function save() {
    try {
      const list = editList();
      // Download exactly what the canvas is showing. Rebuilding here is what
      // let the export drift from the preview before.
      const {
        bytes,
        failed: bad,
        placed: moved,
      } = !stale && built.current ? built.current : await buildEdited();
      setFailed(new Set(bad));
      setPlaced(moved);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(
        new Blob([bytes.slice()], { type: "application/pdf" }),
      );
      a.download = `${name.current.replace(/\.pdf$/i, "")}-edited.pdf`;
      a.click();
      URL.revokeObjectURL(a.href);
      setStatus(
        bad.length
          ? `Saved — ${list.length - bad.length} of ${list.length} edits written; ${bad.length} marked red`
          : `Saved — ${list.length} edit${list.length > 1 ? "s" : ""} written`,
      );
    } catch (err) {
      setStatus(`Could not save — ${err.message}`);
      console.error(err);
    }
  }

  return (
    <div className="app">
      <aside>
        <h1>PDF Editor Free</h1>
        <label className="file">
          Open PDF
          <input
            type="file"
            accept="application/pdf"
            onChange={(e) => open(e.target.files[0])}
          />
        </label>

        <input
          placeholder="Find"
          value={find}
          onChange={(e) => setFind(e.target.value)}
        />
        <input
          placeholder="Replace with"
          value={replace}
          onChange={(e) => setReplace(e.target.value)}
        />
        <label className="chk">
          <input
            type="checkbox"
            checked={matchCase}
            onChange={(e) => setMatchCase(e.target.checked)}
          />
          Match case
        </label>
        <button onClick={replaceAll} disabled={!find || !pages.length}>
          Replace all ({total})
        </button>

        {find && (
          <ul className="hits">
            {matches.map(({ it, n }) => (
              <li key={it.id}>
                <button
                  onClick={() =>
                    document
                      .getElementById(`t${it.id}`)
                      ?.scrollIntoView({ block: "center", behavior: "smooth" })
                  }
                >
                  <b>p{it.page}</b> {textOf(it).slice(0, 60)}
                  {n > 1 && <i> ×{n}</i>}
                </button>
              </li>
            ))}
            {!matches.length && <li className="none">No matches</li>}
          </ul>
        )}

        <div className="foot">
          <button onClick={save} disabled={!changed.length}>
            Download ({changed.length} edited)
          </button>
          <button onClick={() => setEdits({})} disabled={!changed.length}>
            Revert all
          </button>
          <p>{status}</p>
          <p className="hint">
            Click any text on the page to edit it in place.
          </p>
        </div>
      </aside>

      <main>
        {pages.map((p) => (
          <PdfPage
            key={p.num}
            p={p}
            edits={edits}
            failed={failed}
            placed={placed}
            stale={stale}
            onEdit={onEdit}
            find={find}
            matchCase={matchCase}
          />
        ))}
        {!pages.length && <p className="empty">Open a PDF to start.</p>}
      </main>
    </div>
  );
}
