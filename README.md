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
2. Tesseract.js OCRs the canvas in sparse-text mode and returns word-level
   text with bounding boxes (`src/lib/ocr.ts`).
3. Each word is tested against the enabled regex patterns
   (`src/lib/tagPatterns.ts`). Vertically stacked word pairs are also tried
   combined, to catch two-line bubble tags (`src/lib/grouping.ts`).
4. Overlapping duplicate matches are resolved, keeping the
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

If the language model can't be downloaded, the app times out after 90
seconds with a clear error message rather than hanging indefinitely.

## Tech stack

- React + TypeScript + Vite
- [pdfjs-dist](https://github.com/mozilla/pdf.js) for PDF rendering
- [tesseract.js](https://github.com/naptha/tesseract.js) for in-browser OCR
- [xlsx](https://github.com/SheetJS/sheetjs) for spreadsheet export
- [file-saver](https://github.com/eligrey/FileSaver.js) for triggering downloads

## Known limitations

- OCR accuracy depends heavily on drawing scan quality/resolution; increase
  the OCR render scale in Settings for small or low-DPI text.
- Stacked-tag merging currently only combines two lines of text; tags spread
  across three or more lines (e.g. area-loop-suffix each on their own line)
  are not automatically merged and should be added manually.
- The `xlsx` (SheetJS) package has known advisories related to *parsing*
  untrusted spreadsheet files; this app only ever *writes* XLSX files, never
  parses user-supplied ones, so that attack surface isn't exercised here.
