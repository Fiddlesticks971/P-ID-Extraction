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
  dropped). A Hough-transform circle detector finds these bubbles
  (`src/lib/circleDetect.ts`), and each one is then read on its own,
  several times over, and voted on — see below. Adjustable/toggleable in
  Settings.
- **Vector re-rendering for bubble text** — for PDFs, each bubble is
  re-rendered from the original vector source at the scale OCR reads best,
  rather than upscaling pixels from the page raster. Upscaling can only
  interpolate detail that was never there; re-rendering is what lets OCR
  reliably tell a `3` from a `5` in a loop number.
- **Rotated-text pass** — each page is also OCR'd rotated 90°, to catch
  vertical instrument tags next to horizontal lines that a horizontal-only
  pass misses completely.
- **Verification overlay** — every detected tag is drawn as a highlighted
  box on the drawing (amber = unverified, green = verified) so you can
  visually confirm it against the source P&ID. Click a box or a table row
  to select/scroll to the other.
- **Instrument-index data model** — every tag carries the fields an
  instrument index or CMMS import actually needs: ISA function, description,
  loop/group, line or parent equipment, panel, size, fail position, notes,
  and a match-line "continues on" reference.
- **Three-state review, not a checkbox** — a tag is `uncertain` (the default
  for anything OCR produced), `confirmed` (checked against the drawing), or
  `illegible` (genuinely unreadable). Nothing is ever guessed into a
  plausible-looking value, and the state travels with the export.
- **Side-by-side verification** — selecting a tag shows the cropped region of
  the drawing it was read from, magnified, next to its editable fields.
- **Seed-list import and reconciliation** — import a reviewed tag list
  (`instrument_tags.csv` and similar). Rows that match a detected tag enrich
  it in place, keeping the position OCR found; rows with no match are added.
  The import then reports the three ways the two disagree: in the list but
  not on the drawing, on the drawing but not in the list, and read more than
  once. See below.
- **Drawing record** — title-block metadata, the sheet's line numbers (parsed
  into size/service/spec), and hex-flagged note references, all exported
  alongside the tags.
- **Multi-drawing project library** — drawings save to the browser's own
  storage (IndexedDB), source file included, so a project can span several
  sheets and a part-finished review can be reopened later. Nothing is
  uploaded anywhere.
- **Audit trail** — every edit records a timestamp and the reviewer name set
  in Settings.
- **Editable, exportable table** — filter by tag text, loop group, panel or
  review state; fix OCR mistakes, or manually place a tag by clicking the
  drawing. Export to CSV or a multi-sheet XLSX (Tags / Drawing / Lines /
  Notes), or export the current page as a highlighted PNG for
  handoff/verification records. Exports carry each tag's position (`Center_X`
  /`Center_Y`/`Width`/`Height`, in page-raster pixels at the OCR render
  scale) so two runs of the same drawing can be diffed by location rather
  than by text — which matters precisely when the text is what differs.
- **Configurable extraction** — tune OCR render scale, the stacked-text
  grouping distance, and the tag regex patterns themselves from the Settings
  panel, then re-run extraction without re-running OCR.

## Hosted build

`.github/workflows/deploy.yml` builds the app and publishes it to GitHub
Pages on every push to the default branch, so the tool is usable from a URL
instead of a local dev server:

<https://fiddlesticks971.github.io/P-ID-Extraction/>

Pages has to be switched on once by a repo admin before the first deploy
succeeds — **Settings → Pages → Build and deployment → Source: GitHub
Actions**. The workflow token is not permitted to create the Pages site
itself, so this step cannot be automated. After that, re-run the workflow
(Actions → Deploy to GitHub Pages → Run workflow) and it deploys on its own
from then on.

Project sites are served from `/<repo>/`, so the build takes a `BASE_PATH`
env var; deploying to a root domain instead just needs `BASE_PATH=/`.

Drawings are processed entirely in the browser — nothing is uploaded to a
server — so a public URL does not expose the drawings anyone opens in it.

## Getting started

```bash
npm install
npm run dev     # start the app
npm test        # import/export round-trip tests
npm run lint    # oxlint
npm run build   # typecheck + production build
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
   letterforms — `src/lib/circleDetect.ts`). Each detected bubble is then
   read **twice**, under two deliberately different views, and the results
   are voted on field by field (`BUBBLE_VARIANTS` in `src/lib/ocr.ts`):
   - a **circular** mask at 0.82 r, re-rendered at scale 4 — isolates the
     function code best;
   - a **wide, short ellipse** (1.15 r × 0.95 r) at scale 5 — recovers loop
     numbers that overflow the bubble (`SVC / 1378A`) which the circular
     mask clips, while still cutting the vertical connector lines.

   Both are OCR'd with a tag-only character whitelist. The winning function
   code and loop number are emitted as two stacked synthetic words covering
   the bubble, so the normal pattern matching below combines them into a tag
   exactly as it would a real two-line bubble.
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

## Working from a reviewed tag list

Extraction and review are two different jobs, and the second one is where
the data actually becomes trustworthy. If you already have a reviewed tag
list for a drawing — the CSV a careful extraction pass produces, with
columns like:

```
Tag,ISA_Function,Description,Loop_Group,Line_or_Equipment,Panel,Size,Fail_Position,Notes
```

— then **Import Tag List** merges it against whatever the app read off the
sheet. Header names are matched loosely (`Loop_Group`, `Loop Group` and
`loop group` are the same column), so a hand-written file and one this app
exported both import without renaming anything.

Matching is on the tag text with separators and case ignored, since a typed
list and an OCR reading rarely agree on them (`ZSC-1378A` / `ZSC 1378A` /
`zsc1378a`). For each row:

- **Matched** — the detected tag keeps the position OCR found it at (the
  list has no way to know that) and gains the reviewed attributes. Its text
  is corrected to the list's spelling and its state becomes `confirmed`.
  Fields you have already edited are not overwritten.
- **Unmatched** — added as a row with no position, so nothing in the
  reviewed list is silently dropped. Place it with **+ Add Tag** if you want
  it on the overlay.

The import then reports the disagreements, which is the part worth reading:

| Reported as | What it usually means |
| --- | --- |
| In the list but not found on the drawing | The extractor missed it, or misread it — a dropped suffix letter is the classic case |
| On the drawing but not in the list | A false positive, or something the reviewed list forgot |
| Read more than once | Two symbols resolved to the same identity, so at least one is wrong |

On the validation drawing this turns the known weak spot into an explicit
worklist rather than a silent error: of a 32-row seed list against the 24
bubbles the app reads, 20 match and enrich; the four tags whose trailing
suffix the OCR drops (`ZSC-1378A`, `ZSO-1378A`, `BDV-1378A`, `SVO-1321A`)
are reported as "in the list but not found", their misreadings
(`ZSC-13784`, `ZSO-1378`, `BDV-13784`) as "on the drawing but not in the
list", and the collision where `SVO-1321A` degrades into the already-real
`SVO-1321` is caught as "read more than once".

A note on quoting: sizes on a P&ID are written `8"`, `20"x10"`,
`XX"-BD-XXXX-3D4`, and hand-written CSVs do not escape those inch marks.
Strict RFC 4180 parsing reads the first one as the start of a quoted field
and swallows the rest of the file into a single cell, so the parser here
only treats a quote as a delimiter at the *start* of a field and as a
literal inch mark anywhere else.

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

## Relationship to the extraction framework spec

This app implements the data model and review workflow from the project's
"P&ID Instrument Tag Extraction & Application Build Framework" document,
with two deliberate departures from the architecture it recommends:

- **No Python/FastAPI/SQLite backend.** The spec's stated goal was a tool
  usable without deployment overhead; a static browser app has strictly less
  of that than a local server — nothing to install, nothing to run, and the
  drawings never leave the machine. SQLite's role is filled by IndexedDB,
  with the same entity shapes (Drawing / Tag / Line / Note).
- **OCR auto-extraction is kept, not deferred to v2.** The spec listed it as
  a v1 non-goal, which was written before the extraction pipeline existed.
  It does exist, it is measured against a real drawing (see below), and the
  seed-CSV import means the human-in-the-loop path the spec asked for works
  too — the two complement each other rather than competing.

Everything else the spec asks for is implemented: the entity schema, seed
CSV import, the high-resolution render pipeline, side-by-side tag review,
three-state confidence flagging, search and filter by prefix/loop/panel/
state, CSV+XLSX export, cross-drawing match-line references, an audit
trail, and tests for import/export round-tripping.

## Tech stack

- React + TypeScript + Vite
- [pdfjs-dist](https://github.com/mozilla/pdf.js) for PDF rendering
- [tesseract.js](https://github.com/naptha/tesseract.js) for in-browser OCR
- [xlsx](https://github.com/SheetJS/sheetjs) for spreadsheet export
- [file-saver](https://github.com/eligrey/FileSaver.js) for triggering downloads
- IndexedDB for the local project store — no backend, no server
- [vitest](https://vitest.dev) for the import/export tests (`npm test`)

## Known limitations

Validated against a real, dense, professionally-drafted P&ID (a single
6480×4320px page at the default render scale — see the table below for
before/after numbers). Findings from that pass:

Bubble-tag accuracy was tuned against a hand-transcribed ground truth for
the instrument bubbles on the test drawing. The drawing has **24** of them —
established by running detection deliberately loose and classifying every
candidate by eye, which is also how four bubbles that earlier passes silently
missed came to light.

**Circle detection is exact and stable: 24/24 real bubbles, zero false
positives**, verified by running the detector directly over the page raster.

Text accuracy is a different story, and the numbers below come from a **real
browser run exported by a user**, not from a proxy. That distinction matters:
an earlier revision of this file claimed 20/24, measured with the native
`tesseract` CLI standing in for the browser engine because this
environment cannot download tesseract.js's language model. The real
in-browser engine (`4.0.0_best_int`) scored **12/24** on the same drawing.
The proxy was optimistic and the claim was wrong; these are the corrected
figures.

| Stage | Bubble tags exactly correct |
| --- | --- |
| Whole-page OCR only | 0/24 |
| Single upscaled raster crop | 5/24 |
| Vector re-render + two views + field voting | 12/24 |
| + cross-sheet reconciliation, as first shipped | 14/24 |
| **+ bubble reads winning the dedupe (current)** | **19/24** |

The last row is the fix for what the raw OCR gets wrong, and it does not
depend on OCR getting better. A P&ID repeats itself: a loop number is
shared by every device in the loop, and those devices are drawn next to
each other. `src/lib/reconcile.ts` uses that. Where one bubble reads
`13217` and five neighbouring bubbles on the same assembly read `1321`
and `1321A`, the odd reading is a misread `A`, and the sheet says so.

The rules are structural rather than a plain edit distance, because a plain
edit distance actively destroys good data here: **`1321` and `1321A` are two
different loops that both exist on this drawing**, and "snap to the most
common value" turns a correctly-read `1321A` into `1321`. So a suffix letter
is never deleted; what is allowed is recovering a suffix read as a trailing
digit (`13217` → `1321A`, and only when some tag on the sheet actually reads
`1321A`), a confusable digit swap in the stem (`1327` → `1321`), and a
dropped stem digit (`378A` → `1378A`). Function codes are matched against a
dictionary of codes P&IDs actually use, which is what turns `AQV` back into
`AOV`.

Every correction is a **suggestion, not an assertion**: the tag stays
`uncertain`, and its Notes record what it was read as and why it was
changed. Nothing here invents a reading no OCR pass produced — the one
remaining error on the test drawing (`ZSC-1378A` read as `A-1378`) is left
exactly as read, because no rule can recover it honestly.

The 14/24 row is worth keeping visible, because it is where reconciliation
first shipped and it under-delivered: only two of the seven corrections
fired. The cause was upstream. Both OCR passes read the same bubble, the
whole-page pass reported higher confidence, and the duplicate-resolution
step picked it on that basis — so the tag ended up marked as page text and
reconciliation, which only trusts bubble reads, skipped it. Tesseract's
confidence knows nothing about the bubble pass having re-rendered the crop
from vector source and masked the connector lines away. **A bubble read now
wins outright over a whole-page read of the same symbol**, and all seven
corrections fire.

That bug was diagnosable only because a correction note said "3 nearby
bubbles on this loop" when the export plainly showed five tags on loop
1321. Exports now carry an `Origin` column for exactly this reason.

Other findings from the same real runs, all now fixed:

- **Four detected bubbles produced no tag at all and were silently
  dropped.** This is the worst failure mode an extraction tool has, because
  the output looks complete. A bubble that cannot be read in full is now
  emitted as an `illegible` row at its location, carrying whichever half of
  the tag did come through. Note *in full*: the first version of this check
  only fired when neither the function code nor the loop number was read,
  and those four bubbles stayed missing — a lone `ZSO` with no loop number
  matches no tag pattern downstream and vanishes just as quietly. Both
  halves are required.
- **23 of the 43 exported rows were not instruments** — `E1550` from the
  spec code in `8"-G-0331-8E1550`, `BD-0038` from the valve number
  `03-BD-0038`, and so on. The tag patterns were matching *inside* longer
  tokens. They are now anchored so a candidate has to stand on its own, and
  every tag records whether it came from a bubble or from page text, with
  the table showing bubbles by default.

Three things that sound like they should help but measurably did **not**,
so they aren't in the code:

- **Rendering the page raster at a higher scale.** Going from 2.5x to 4x
  made whole-page OCR clearly *worse* (12/13 → 5/13 known line numbers and
  air-supply tags read exactly). Tesseract has a glyph-size sweet spot;
  bigger is not better. The same effect shows up in the bubble sweep, where
  render scale 12 scored far below 4-5.
- **Detecting circles at full resolution.** Hough votes disperse across
  neighbouring accumulator cells instead of concentrating, and detection
  drops to zero. Detection deliberately runs on a downsampled image.
- **A character whitelist on the whole-page passes.** It helps on bubble
  crops (which are pure tag text) but would corrupt pipe sizes like `4"`.

Remaining known limitations:

- Of the 24 bubbles on the test drawing, 19 read exactly, 4 come back as
  `illegible` (detected, unreadable — they need typing in by hand), and 1
  (`ZSC-1378A`) is misread as `A-1378` and is not recoverable by
  reconciliation. Expect to review every tag; this is a first pass, not an
  answer.
- Reconciliation needs the sheet to repeat itself. On a drawing with only
  one device per loop there is nothing to cross-check against, and it will
  correct nothing.
- One bubble on the test drawing used a solid-fill (knockout/reversed) text
  style rather than the standard hollow outline — that style isn't read;
  add such tags manually with "+ Add Tag".
- Bubble radius varies by drawing convention/scale — if bubbles on your
  drawing aren't being found, widen the min/max bubble radius in Settings.
- Image uploads (PNG/JPG) have no vector source, so their bubble crops fall
  back to upscaling the raster and will read less accurately than a PDF of
  the same drawing.
- These numbers come from one real drawing with one CAD font. Treat the
  ranking of approaches as more transferable than the exact counts.
- Tags in open space, in box/rectangle symbols, and pipe line numbers are
  read reliably without the bubble-specific caveats above.
- Stacked-tag merging currently only combines two lines of text; tags spread
  across three or more lines (e.g. area-loop-suffix each on their own line)
  are not automatically merged and should be added manually.
- The `xlsx` (SheetJS) package has known advisories related to *parsing*
  untrusted spreadsheet files; this app only ever *writes* XLSX files, never
  parses user-supplied ones, so that attack surface isn't exercised here.

As always: treat OCR output as a first pass to verify against the drawing
via the highlighted overlay, not a guaranteed-complete extraction — that's
what the verify/edit workflow and the "+ Add Tag" manual tool are for.
