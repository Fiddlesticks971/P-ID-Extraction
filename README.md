# P&ID Tag Extractor

A browser-based tool for extracting instrument and equipment tags from
Piping & Instrumentation Diagrams (P&IDs). Upload a PDF or image drawing, it
OCRs the page and finds tags that follow ISA 5.1-style naming conventions,
lets you verify/correct them against highlighted boxes drawn directly on the
drawing, and exports the result as a CSV or XLSX table.

Everything runs client-side in the browser — no backend, no drawing upload
to a server.

## Features

- **PDF and image input** — multi-page PDFs (via pdf.js) or PNG/JPG/TIFF images.
- **OCR-based tag detection** (via Tesseract.js) matched against configurable
  regex patterns for instrument tags (`PT-101A`), equipment tags (`TK-201`),
  and pipe line numbers.
- **Stacked bubble-tag merging** — many P&ID instrument bubbles draw the
  function code and loop number as two separate lines of text (e.g. `FT`
  over `310A`); the extractor detects vertically stacked OCR words and
  merges them into a single tag.
- **Circular instrument-bubble detection** — whole-page OCR reliably fails
  on text packed tightly inside circular instrument symbols (the stroke and
  connecting lines get merged with the text into a non-text region and
  dropped). A Hough-transform circle detector finds these bubbles, crops
  each one tight, masks out its stroke, and OCRs it in isolation
  (`src/lib/circleDetect.ts`) — recovers most bubble tags that would
  otherwise be missed entirely. Adjustable/toggleable in Settings.
- **Rotated-text pass** — each page is also OCR'd rotated 90°, to catch
  vertical instrument tags next to horizontal lines that a horizontal-only
  pass misses completely.
- **Verification overlay** — every detected tag is drawn as a highlighted
  box on the drawing (amber = unverified, green = verified) so you can
  visually confirm it against the source P&ID. Click a box or a table row
  to select/scroll to the other.
- **Editable, exportable table** — fix OCR mistakes, add descriptions,
  verify/reject tags, or manually place a tag by clicking the drawing.
  Export to CSV or XLSX, or export the current page as a highlighted PNG for
  handoff/verification records.
- **Configurable extraction** — tune OCR render scale, the stacked-text
  grouping distance, and the tag regex patterns themselves from the Settings
  panel, then re-run extraction without re-running OCR.

## Getting started

```bash
npm install
npm run dev
```

Then open the printed local URL, upload a P&ID, and wait for OCR to finish
(a progress banner shows page/status). Detected tags appear both as
highlighted boxes on the drawing and as rows in the table on the right.

## How tag extraction works

1. Each page is rasterized to a canvas (`src/lib/pdfRender.ts`).
2. Tesseract.js OCRs the canvas twice — upright and rotated 90° — in
   sparse-text mode, returning word-level text with bounding boxes
   (`src/lib/ocr.ts`).
3. Circular instrument bubbles are detected on the page (Hough gradient
   circle transform over a box-downsampled grayscale image, with a
   circumference-coverage check to reject false positives from round
   letterforms — `src/lib/circleDetect.ts`). Each detected bubble is
   cropped tight, its stroke masked out (clipped to an inner disk so
   neighboring bubbles/lines are excluded too), upscaled, and OCR'd on its
   own — this is what recovers tags that whole-page OCR merges into
   unreadable noise.
4. Every word from all three passes is tested against the enabled regex
   patterns (`src/lib/tagPatterns.ts`). Vertically stacked word pairs are
   also tried combined, to catch two-line bubble tags
   (`src/lib/grouping.ts`).
5. Overlapping duplicate matches are resolved, keeping the
   longest/highest-confidence candidate, and turned into editable `Tag`
   records.

Because this is pattern-matching over OCR output, it is a starting point for
verification, not a guaranteed-correct extraction — always review the
highlighted boxes against the source drawing before relying on the exported
table. False positives can be deleted and false negatives added manually
with the "+ Add Tag" tool.

### Customizing tag patterns

Open **Settings** to edit the regex patterns used for matching. Each pattern
should use named capture groups `func`, `loop`, and `suffix` so extracted
tags populate those table columns, e.g.:

```
(?<func>[A-Z]{1,5})-?(?<loop>\d{2,5})(?<suffix>[A-Z]{1,2})?
```

Patterns can be enabled/disabled, edited, deleted, or added per-project to
match whatever tagging standard a given set of drawings uses. After editing
patterns, click **Re-run Extraction** to re-apply them to the already-OCR'd
text without re-scanning the drawing.

## Offline / self-hosted OCR assets

By default Tesseract.js downloads its worker script and WASM OCR core from a
CDN. This app instead ships those files locally under `public/tesseract/`
(copied from the `tesseract.js` / `tesseract.js-core` packages) so OCR does
not depend on a CDN for the bulk of its runtime.

The one remaining network dependency is the English language model
(`eng.traineddata`, a few MB), which downloads from jsdelivr on first use
and is then cached by the browser (IndexedDB) for subsequent runs. If you
need a fully offline/air-gapped setup:

1. Download `eng.traineddata.gz` for the LSTM model (e.g. from
   `https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz`
   on a machine with internet access).
2. Place it at `public/tesseract/lang/eng.traineddata.gz`.
3. In `src/lib/ocr.ts`, add `langPath: "/tesseract/lang"` to the
   `Tesseract.createWorker` options.

If the language model can't be downloaded, the app times out (5 minutes,
plus 5 more per page — real OCR on a dense, high-resolution drawing is
legitimately slow) with a clear error message rather than hanging
indefinitely.

## Tech stack

- React + TypeScript + Vite
- [pdfjs-dist](https://github.com/mozilla/pdf.js) for PDF rendering
- [tesseract.js](https://github.com/naptha/tesseract.js) for in-browser OCR
- [xlsx](https://github.com/SheetJS/sheetjs) for spreadsheet export
- [file-saver](https://github.com/eligrey/FileSaver.js) for triggering downloads

## Known limitations

Validated against a real, dense, professionally-drafted P&ID (a single
6480×4320px page at the default render scale — see the table below for
before/after numbers). Findings from that pass:

- **Circular instrument bubbles were the hardest case, now handled by
  dedicated detection.** Whole-page OCR alone found 0 of 21 visible
  instrument bubbles on the test drawing (Tesseract's segmentation merges
  the circle stroke and connecting lines with the text and drops it
  entirely — confirmed this isn't a resolution problem, tested up to 6x
  local upscaling). With circle detection + isolated cropped OCR
  (`src/lib/circleDetect.ts`), 19-20 of those 21 bubbles were read
  correctly. Bubble radius varies by drawing convention/scale — if bubbles
  on your drawing aren't being found, widen the min/max bubble radius in
  Settings (they default to a range tuned to the validated test drawing).
- **OCR digit errors** (particularly `3` misread as `5`, an artifact of
  this drawing's specific CAD font) are the main remaining error class on
  otherwise-correctly-located tags — always double check digits against
  the highlighted drawing before exporting; incorrect ones are a quick
  inline edit in the table.
- One bubble on the test drawing used a solid-fill (knockout/reversed) text
  style rather than the standard hollow outline — that style isn't read;
  add such tags manually with "+ Add Tag".
- Tags in open space, in box/rectangle symbols, and pipe line numbers are
  read reliably without any of the above caveats.
- OCR accuracy depends heavily on drawing scan quality/resolution; increase
  the OCR render scale in Settings for small or low-DPI text.
- Stacked-tag merging currently only combines two lines of text; tags spread
  across three or more lines (e.g. area-loop-suffix each on their own line)
  are not automatically merged and should be added manually.
- The `xlsx` (SheetJS) package has known advisories related to *parsing*
  untrusted spreadsheet files; this app only ever *writes* XLSX files, never
  parses user-supplied ones, so that attack surface isn't exercised here.

As always: treat OCR output as a first pass to verify against the drawing
via the highlighted overlay, not a guaranteed-complete extraction — that's
what the verify/edit workflow and the "+ Add Tag" manual tool are for.
