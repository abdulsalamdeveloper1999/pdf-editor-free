import { useEffect, useRef } from "react";
import { Util } from "pdfjs-dist";
import { countMatches } from "./text";

export default function PdfPage({
  p,
  edits,
  failed,
  placed,
  stale,
  onEdit,
  find,
  matchCase,
}) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    canvas.width = p.vp.width;
    canvas.height = p.vp.height;
    const task = p.page.render({ canvas, viewport: p.vp });
    task.promise.catch(() => {}); // cancelled on unmount / StrictMode re-run
    return () => task.cancel();
  }, [p]);

  return (
    <div className="page" style={{ width: p.vp.width, height: p.vp.height }}>
      <canvas ref={canvasRef} />
      <div className="layer">
        {p.items.map((it) => {
          // pdf.js text-layer placement: transform[4,5] is the baseline origin.
          const tx = Util.transform(p.vp.transform, it.transform);
          const size = Math.hypot(tx[2], tx[3]);
          const val = edits[it.id] ?? it.str;
          const changed = val !== it.str;
          const hit = countMatches(val, find, matchCase) > 0;
          // a right-aligned run is redrawn further left; follow it so the
          // click target stays on the text
          const moved = (placed[it.id] ?? 0) * p.vp.scale;
          return (
            <span
              key={it.id}
              id={`t${it.id}`}
              className={`tx${changed ? " changed" : ""}${changed && stale ? " pending" : ""}${hit ? " hit" : ""}${failed.has(it.id) ? " failed" : ""}`}
              style={{
                left: `${tx[4] - moved}px`,
                top: `${tx[5] - size}px`,
                fontSize: `${size}px`,
                lineHeight: `${size}px`,
                // match the original run so the box covers it exactly while focused
                fontFamily: p.styles?.[it.fontName]?.fontFamily || "sans-serif",
                minWidth: `${it.width * p.vp.scale + moved}px`,
              }}
              contentEditable
              suppressContentEditableWarning
              spellCheck={false}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === "Escape") {
                  e.preventDefault();
                  e.currentTarget.blur();
                }
              }}
              onBlur={(e) =>
                onEdit(it.id, e.currentTarget.textContent.replace(/ /g, " "))
              }
            >
              {val}
            </span>
          );
        })}
      </div>
    </div>
  );
}
