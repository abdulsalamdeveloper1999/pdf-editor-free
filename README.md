# PDF Editor Free

Open a PDF, click any line to edit it in place, find/replace across the whole
document, download the result. React + Vite, wrapped in Electron so it runs as a
desktop app. Everything happens on your machine — no upload, no server.

## Download

Installers for macOS, Windows and Linux are attached to each
[release](https://github.com/abdulsalamdeveloper1999/pdf-editor-free/releases).
The macOS build is universal — one file for both Intel and Apple silicon.

The builds are signed ad-hoc but **not notarized**, so your system warns the
first time you open one.

**macOS** says "Apple could not verify ... is free of malware". Open **System
Settings → Privacy & Security**, scroll to **Security**, and click **Open
Anyway** next to the app's name, then confirm. (Control-clicking the app and
choosing Open no longer works — Apple removed that bypass in macOS 15.) From a
terminal the equivalent is:

```bash
xattr -dr com.apple.quarantine "/Applications/PDF Editor Free.app"
```

**Windows** SmartScreen says "Windows protected your PC" — choose **More info**,
then **Run anyway**.

**Linux** — make the AppImage executable first: `chmod +x PDF-Editor-Free-*.AppImage`

Notarizing (macOS) and signing (Windows) would remove these warnings, but both
need paid developer accounts.

## Development

```bash
npm install
npm run dev     # browser, http://localhost:5173
npm run app     # the Electron app
npm test        # find/replace + rewrite-engine checks
npm run smoke   # boots the real Electron app and opens a PDF in it
npm run dist    # installers for this machine, into release/
```

Cutting a release: `npm version <x.y.z> && git push --follow-tags`. That bumps
`package.json` (what the installers are named after) and pushes the tag, which
runs the build on all three platforms and attaches them to a draft release.

Test files: `public/sample.pdf` (prose), `public/table.pdf` (left-aligned
columns), `public/right-aligned.pdf` (a right-aligned amount column).

## How it works

The Electron wrapper is thin: `electron/app.cjs` serves the ordinary Vite build
over a custom `app://` scheme (ES modules are blocked on `file://` origins) and
opens a window. There is no IPC and no Node access in the renderer.

- **pdf.js** renders each page to a canvas and reports where every text run sits.
  Those runs are laid over the canvas as `contentEditable` spans — transparent
  hit targets, not painted text.
- After each edit the canvas is **re-rendered from the actual edited PDF**, so the
  page you are looking at is the output. Nothing is drawn on top of anything.
- `Download` hands over those same bytes. Preview and export share one builder
  (`buildEdited`) and the export serves the buffer the canvas was rendered from,
  so the two cannot disagree — they did once, when the export was rebuilt
  separately and lost the layout geometry.
- On download, the edit is written **into the PDF's own content stream**: only the
  string operands of the text-showing operators (`Tj`, `TJ`, `'`, `"`) change.
  Every other operator — font, size, colour, position, spacing — is left byte for
  byte as it was, and the original characters are removed rather than covered.
  Character codes are read and written through the font's own `ToUnicode` map,
  falling back to WinAnsi for simple fonts without one.
- A replacement is kept in the space the run already had. Which way it grows
  depends on how its column lines up, worked out from the other runs on the page:
  a run in a **right-aligned** column (amounts, totals) keeps its right edge and
  grows leftwards; anything else grows rightwards until it would reach its
  neighbour. Only when neither direction has the room is the run **condensed
  horizontally** (`Tz`). The font and its size never change, and a run that
  still fits is left completely alone.
- Widths come from the font's own `/Widths` (or `/W` for CID fonts, or the
  built-in metrics for the standard 14), so the fit matches what the viewer draws.
  Re-placing a run uses a leading `TJ` offset, so no positioning operator is
  touched either.

Edits that cannot be written are reported in the status line and the run is
marked red in the page; the rest of the file still saves.

## Known limits

- **No reflow onto the next line.** A long replacement is fitted to its own
  line; text never re-wraps. The gap kept before the next run is a quarter em,
  so a very long value gets quite squeezed rather than spilling.
- **Centred columns** are treated as left-aligned; only left and right edges are
  detected.
- **Runs the viewer splits.** Some PDFs (print-driver output especially) draw one
  word per operator. Find/replace matches within a run, so a phrase split across
  two runs will not be found — single words still work.
- **Fonts without a usable map.** CID fonts with no `ToUnicode`, and fonts with a
  custom `/Differences` encoding and no `ToUnicode`, are left alone and reported.
- **Characters the font lacks.** The replacement has to exist in the font; typing
  CJK into a Latin-only font is refused rather than written as garbage.
- **Scanned PDFs** have no text to edit.
- No undo stack; `Revert all` drops every pending edit.
- The canvas re-render is debounced ~150ms after a run loses focus, so a very
  large document redraws its edited pages a moment after you finish typing.
