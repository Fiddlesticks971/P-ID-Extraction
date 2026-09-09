import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileUpload } from "./components/FileUpload";
import { PidViewer } from "./components/PidViewer";
import { TagTable } from "./components/TagTable";
import { TagDetail } from "./components/TagDetail";
import { DrawingPanel } from "./components/DrawingPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { loadFile } from "./lib/pdfRender";
import type { LoadedDocument } from "./lib/pdfRender";
import { recognizePages } from "./lib/ocr";
import type { OcrProgress } from "./lib/ocr";
import { extractTagCandidates, candidatesToTags } from "./lib/grouping";
import { reconcileTags } from "./lib/reconcile";
import type { UnreadBubble } from "./lib/ocr";
import { DEFAULT_PATTERNS } from "./lib/tagPatterns";
import { mergeSeedRows, parseSeedCsv } from "./lib/tagImport";
import { exportTagsCsv, exportWorkbook, exportAnnotatedPage } from "./lib/export";
import {
  deleteDrawing,
  listDrawings,
  loadDrawing,
  saveDrawing,
  type DrawingSummary,
} from "./lib/persist";
import {
  emptyDrawingMeta,
  type AppSettings,
  type DrawingMeta,
  type LineRecord,
  type NoteRecord,
  type OcrWord,
  type PageImage,
  type Bbox,
  type ReviewState,
  type Tag,
} from "./types";
import "./index.css";

type Status = "idle" | "rendering" | "ocr" | "grouping" | "ready" | "error";
type PanelTab = "tags" | "drawing";

// Each page is OCR'd twice (upright + rotated 90°) plus once more per
// detected instrument bubble (see ocr.ts) at full drawing resolution,
// which is legitimately slow for large, dense P&IDs — this only needs to
// be generous enough to rule out an infinite hang (e.g. a failed
// language-model download), not to tightly bound normal runtime.
const OCR_BASE_TIMEOUT_MS = 5 * 60_000;
const OCR_PER_PAGE_TIMEOUT_MS = 8 * 60_000;

/**
 * tesseract.js can swallow a failed language-model download inside its
 * worker without ever rejecting the `recognize` promise, which would
 * otherwise leave the UI stuck on the progress banner forever. This bounds
 * how long we wait so a network problem surfaces as a clear, actionable
 * error instead of an infinite spinner.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      window.setTimeout(() => reject(new Error(message)), ms);
    }),
  ]);
}

function defaultSettings(): AppSettings {
  return {
    ocrScale: 2.5,
    groupStackedText: 0.8,
    patterns: DEFAULT_PATTERNS.map((p) => ({ ...p })),
    detectBubbles: true,
    // Radius bounds at ocrScale = 1; scaled up by the current OCR render
    // scale at detection time. Validated against a real drawing at the
    // default 2.5x scale (bubbles measured ~33-54px radius there).
    bubbleMinRadius: 13,
    bubbleMaxRadius: 22,
    reviewerName: "",
  };
}

let manualTagCounter = 0;
let unreadCounter = 0;

/**
 * A detected bubble whose text OCR could not read becomes a visible
 * "illegible" row sitting at the symbol's location, rather than nothing at
 * all. On the validation drawing four bubbles were being silently dropped
 * this way — the worst possible failure for an extraction tool, because
 * the output looks complete.
 */
function unreadBubbleToTag(bubble: { page: number; bbox: Bbox }, reviewer: string): Tag {
  unreadCounter += 1;
  return {
    id: `unread-${Date.now()}-${unreadCounter}`,
    text: "",
    functionCode: "",
    loopNumber: "",
    suffix: "",
    description: "",
    type: "Unreadable bubble",
    page: bubble.page,
    bbox: bubble.bbox,
    confidence: 0,
    state: "illegible",
    source: "auto",
    patternName: "Unreadable bubble",
    origin: "bubble",
    isaFunction: "",
    loopGroup: "",
    lineOrEquipment: "",
    panel: "",
    size: "",
    failPosition: "",
    notes: "Instrument bubble detected here, but its text could not be read. Zoom in and type the tag.",
    continuesOn: "",
    updatedAt: "",
    updatedBy: reviewer,
  };
}

/** Extraction + the cross-sheet consistency pass, shared by first run and re-run. */
function buildTags(
  words: OcrWord[],
  unread: UnreadBubble[],
  settings: AppSettings,
): { tags: Tag[]; correctionCount: number } {
  const candidates = extractTagCandidates(words, settings.patterns, settings.groupStackedText);
  const extracted = candidatesToTags(candidates);
  const { tags, corrections } = reconcileTags(extracted);
  return {
    tags: [...tags, ...unread.map((b) => unreadBubbleToTag(b, settings.reviewerName))],
    correctionCount: corrections.length,
  };
}

function App() {
  const [fileName, setFileName] = useState<string | null>(null);
  const [pages, setPages] = useState<PageImage[]>([]);
  const [words, setWords] = useState<OcrWord[]>([]);
  const [unreadBubbles, setUnreadBubbles] = useState<UnreadBubble[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [meta, setMeta] = useState<DrawingMeta>(emptyDrawingMeta());
  const [lines, setLines] = useState<LineRecord[]>([]);
  const [notes, setNotes] = useState<NoteRecord[]>([]);
  const [drawingId, setDrawingId] = useState<string | null>(null);
  const [library, setLibrary] = useState<DrawingSummary[]>([]);
  const [saveState, setSaveState] = useState<string | null>(null);
  const [currentPageIndex, setCurrentPageIndex] = useState(0);
  const [selectedTagId, setSelectedTagId] = useState<string | null>(null);
  const [settings, setSettings] = useState<AppSettings>(defaultSettings());
  const [showSettings, setShowSettings] = useState(false);
  const [addMode, setAddMode] = useState(false);
  const [panelTab, setPanelTab] = useState<PanelTab>("tags");
  const [status, setStatus] = useState<Status>("idle");
  const [ocrProgress, setOcrProgress] = useState<OcrProgress | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [importSummary, setImportSummary] = useState<string | null>(null);
  const documentRef = useRef<LoadedDocument | null>(null);
  const sourceFileRef = useRef<File | null>(null);
  const seedInputRef = useRef<HTMLInputElement>(null);

  const busy = status === "rendering" || status === "ocr" || status === "grouping";
  const currentPage = pages[currentPageIndex] ?? null;

  const tagsOnCurrentPage = useMemo(
    () => tags.filter((t) => t.page === (currentPage?.pageNumber ?? -1)),
    [tags, currentPage],
  );
  const selectedTag = useMemo(
    () => tags.find((t) => t.id === selectedTagId) ?? null,
    [tags, selectedTagId],
  );

  const refreshLibrary = useCallback(async () => {
    try {
      setLibrary(await listDrawings());
    } catch (err) {
      console.warn("Could not read the local project store", err);
    }
  }, []);

  useEffect(() => {
    // Reading the saved-drawing list is exactly the "synchronize with an
    // external system" case effects are for — IndexedDB is the external
    // system, and the state is set after the await, not synchronously.
    // eslint-disable-next-line react/set-state-in-effect
    void refreshLibrary();
  }, [refreshLibrary]);

  function resetDrawingState(name: string) {
    setFileName(name);
    setErrorMessage(null);
    setImportSummary(null);
    setTags([]);
    setWords([]);
    setUnreadBubbles([]);
    setLines([]);
    setNotes([]);
    setSelectedTagId(null);
    setCurrentPageIndex(0);
    setOcrProgress(null);
    setSaveState(null);
  }

  async function processFile(file: File) {
    resetDrawingState(file.name);
    setMeta({ ...emptyDrawingMeta(file.name) });
    setDrawingId(`drawing-${Date.now()}`);
    sourceFileRef.current = file;

    try {
      setStatus("rendering");
      const loaded = await loadFile(file, settings.ocrScale);
      // Release the previous document's pdf.js worker before replacing it.
      documentRef.current?.destroy();
      documentRef.current = loaded;
      const loadedPages = loaded.pages;
      setPages(loadedPages);

      setStatus("ocr");
      const ocrTimeoutMs = OCR_BASE_TIMEOUT_MS + loadedPages.length * OCR_PER_PAGE_TIMEOUT_MS;
      const ocrResult = await withTimeout(
        recognizePages(loadedPages, {
          onProgress: setOcrProgress,
          detectBubbles: settings.detectBubbles,
          bubbleRadius: {
            min: settings.bubbleMinRadius * settings.ocrScale,
            max: settings.bubbleMaxRadius * settings.ocrScale,
          },
          renderRegion: loaded.renderRegion,
          baseScale: loaded.baseScale,
        }),
        ocrTimeoutMs,
        "OCR timed out. This usually means the English language model could not be downloaded on first use (check your internet connection, or see the README for offline / self-hosted setup instructions) — but very large or dense drawings can also genuinely take this long; try lowering the OCR render scale in Settings and re-uploading if that's the case.",
      );
      setWords(ocrResult.words);
      setUnreadBubbles(ocrResult.unreadBubbles);

      setStatus("grouping");
      const built = buildTags(ocrResult.words, ocrResult.unreadBubbles, settings);
      setTags(built.tags);
      setStatus("ready");
      const notices: string[] = [];
      if (ocrResult.unreadBubbles.length > 0) {
        notices.push(
          `${ocrResult.unreadBubbles.length} instrument bubble(s) were found on the drawing but could not be read — they are listed as "illegible" at their location on the sheet.`,
        );
      }
      if (built.correctionCount > 0) {
        notices.push(
          `${built.correctionCount} reading(s) were adjusted to agree with neighbouring bubbles on the same loop; each says what it was read as in its Notes. Check them before trusting them.`,
        );
      }
      setImportSummary(notices.length > 0 ? notices.join(" ") : null);
    } catch (err) {
      console.error(err);
      setErrorMessage(err instanceof Error ? err.message : String(err));
      setStatus("error");
    }
  }

  function reapplyPatterns() {
    if (words.length === 0) return;
    setStatus("grouping");
    window.setTimeout(() => {
      setTags(buildTags(words, unreadBubbles, settings).tags);
      setStatus("ready");
    }, 0);
  }

  /** Every edit stamps the audit trail, since this data feeds other systems. */
  function updateTag(id: string, patch: Partial<Tag>) {
    setTags((prev) =>
      prev.map((t) =>
        t.id === id
          ? { ...t, ...patch, updatedAt: new Date().toISOString(), updatedBy: settings.reviewerName }
          : t,
      ),
    );
  }

  function deleteTag(id: string) {
    setTags((prev) => prev.filter((t) => t.id !== id));
    setSelectedTagId((prev) => (prev === id ? null : prev));
  }

  function addTagAt(xFraction: number, yFraction: number) {
    if (!currentPage) return;
    const boxW = 90;
    const boxH = 36;
    const cx = xFraction * currentPage.width;
    const cy = yFraction * currentPage.height;
    manualTagCounter += 1;
    const newTag: Tag = {
      id: `manual-${Date.now()}-${manualTagCounter}`,
      text: "NEW-TAG",
      functionCode: "",
      loopNumber: "",
      suffix: "",
      description: "",
      type: "Manual",
      page: currentPage.pageNumber,
      bbox: {
        x0: Math.max(0, cx - boxW / 2),
        y0: Math.max(0, cy - boxH / 2),
        x1: Math.min(currentPage.width, cx + boxW / 2),
        y1: Math.min(currentPage.height, cy + boxH / 2),
      },
      confidence: 100,
      // Manually added tags are unreviewed by definition — they start
      // "uncertain" and are confirmed once checked against the drawing.
      state: "uncertain",
      source: "manual",
      patternName: "Manual",
      origin: "bubble",
      isaFunction: "",
      loopGroup: "",
      lineOrEquipment: "",
      panel: "",
      size: "",
      failPosition: "",
      notes: "",
      continuesOn: "",
      updatedAt: new Date().toISOString(),
      updatedBy: settings.reviewerName,
    };
    setTags((prev) => [...prev, newTag]);
    setSelectedTagId(newTag.id);
    setAddMode(false);
  }

  /**
   * Imports a reviewed seed list and merges it onto whatever is currently
   * on screen: matched rows enrich the detected tags (keeping their
   * position), unmatched rows are appended so nothing in the reviewed list
   * is lost.
   */
  async function importSeedFile(file: File) {
    try {
      const { rows, warnings } = parseSeedCsv(await file.text());
      if (rows.length === 0) {
        setImportSummary(warnings.join(" ") || "No rows found in that file.");
        return;
      }
      const result = mergeSeedRows(tags, rows, {
        page: currentPage?.pageNumber ?? 1,
        importedState: "confirmed",
        reviewer: settings.reviewerName,
        overwriteExisting: false,
      });
      setTags(result.tags);
      const list = (items: string[]) =>
        `${items.slice(0, 10).join(", ")}${items.length > 10 ? ` (+${items.length - 10} more)` : ""}`;
      const parts = [
        `Imported ${rows.length} rows from ${file.name}: ${result.matched} matched a tag found on the drawing.`,
      ];
      if (result.missingFromDrawing.length > 0) {
        parts.push(
          `${result.missingFromDrawing.length} in the list but not found on the drawing (added without a position — check these first): ${list(result.missingFromDrawing)}.`,
        );
      }
      if (result.unmatchedTagTexts.length > 0) {
        parts.push(
          `${result.unmatchedTagTexts.length} found on the drawing but not in the list: ${list(result.unmatchedTagTexts)}.`,
        );
      }
      if (result.duplicateTagTexts.length > 0) {
        parts.push(`Read more than once: ${list(result.duplicateTagTexts)}.`);
      }
      if (warnings.length > 0) parts.push(warnings.join(" "));
      setImportSummary(parts.join(" "));
    } catch (err) {
      setImportSummary(`Could not read that file: ${err instanceof Error ? err.message : err}`);
    }
  }

  async function handleSaveDrawing() {
    if (!drawingId) return;
    try {
      setSaveState("Saving…");
      await saveDrawing(
        { id: drawingId, meta, tags, lines, notes, savedAt: new Date().toISOString() },
        sourceFileRef.current ?? undefined,
      );
      setSaveState(`Saved ${new Date().toLocaleTimeString()}`);
      await refreshLibrary();
    } catch (err) {
      setSaveState(`Save failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Reopens a saved sheet: re-renders the stored file, restores the reviewed data. */
  async function handleOpenDrawing(id: string) {
    try {
      const stored = await loadDrawing(id);
      if (!stored) return;
      const { record, file } = stored;
      if (!file) {
        setErrorMessage("That drawing was saved without its source file and cannot be reopened.");
        return;
      }
      resetDrawingState(file.name);
      sourceFileRef.current = file;
      setDrawingId(record.id);
      setMeta(record.meta);
      setStatus("rendering");
      const loaded = await loadFile(file, settings.ocrScale);
      documentRef.current?.destroy();
      documentRef.current = loaded;
      setPages(loaded.pages);
      setTags(record.tags);
      setLines(record.lines);
      setNotes(record.notes);
      setStatus("ready");
      setSaveState(`Opened, last saved ${new Date(record.savedAt).toLocaleString()}`);
    } catch (err) {
      console.error(err);
      setErrorMessage(err instanceof Error ? err.message : String(err));
      setStatus("error");
    }
  }

  async function handleDeleteDrawing(id: string) {
    await deleteDrawing(id);
    if (id === drawingId) setDrawingId(null);
    await refreshLibrary();
  }

  function setStateAll(state: ReviewState) {
    const stamp = { updatedAt: new Date().toISOString(), updatedBy: settings.reviewerName };
    setTags((prev) => prev.map((t) => ({ ...t, state, ...stamp })));
  }

  const exportBaseName =
    meta.drawingNumber.trim() || fileName?.replace(/\.[^.]+$/, "") || "pid-tags";
  const progressPct = ocrProgress ? Math.round(ocrProgress.progress * 100) : 0;

  return (
    <div className="app">
      <header className="app-header">
        <h1>P&amp;ID Tag Extractor</h1>
        <div className="header-controls">
          <FileUpload onFileSelected={processFile} disabled={busy} currentFileName={fileName} />
          <button onClick={() => setShowSettings((s) => !s)}>Settings</button>
          <button
            onClick={() => setAddMode((a) => !a)}
            disabled={!currentPage}
            className={addMode ? "active" : ""}
          >
            {addMode ? "Cancel Add" : "+ Add Tag"}
          </button>
          <button onClick={() => seedInputRef.current?.click()} disabled={busy}>
            Import Tag List
          </button>
          <input
            ref={seedInputRef}
            type="file"
            accept=".csv,.txt"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void importSeedFile(file);
              e.target.value = "";
            }}
          />
          <button onClick={() => exportTagsCsv(tags, `${exportBaseName}.csv`)} disabled={tags.length === 0}>
            Export CSV
          </button>
          <button
            onClick={() => exportWorkbook(tags, meta, lines, notes, `${exportBaseName}.xlsx`)}
            disabled={tags.length === 0}
          >
            Export XLSX
          </button>
          <button
            onClick={() => currentPage && exportAnnotatedPage(currentPage, tagsOnCurrentPage)}
            disabled={!currentPage || tagsOnCurrentPage.length === 0}
          >
            Export Highlighted PNG
          </button>
        </div>
      </header>

      {busy && (
        <div className="progress-banner">
          {status === "rendering" && <span>Rendering pages&hellip;</span>}
          {status === "ocr" && ocrProgress && (
            <span>
              Scanning page {ocrProgress.page}/{ocrProgress.totalPages} &mdash; {ocrProgress.status} (
              {progressPct}%)
            </span>
          )}
          {status === "grouping" && <span>Matching tag patterns&hellip;</span>}
          <div className="progress-track">
            <div
              className="progress-fill"
              style={{ width: status === "ocr" ? `${progressPct}%` : "100%" }}
            />
          </div>
        </div>
      )}

      {status === "error" && errorMessage && (
        <div className="error-banner">Error: {errorMessage}</div>
      )}

      {importSummary && (
        <div className="info-banner">
          {importSummary}
          <button className="small" onClick={() => setImportSummary(null)}>
            Dismiss
          </button>
        </div>
      )}

      <div className="app-body">
        <PidViewer
          page={currentPage}
          pageCount={pages.length}
          currentPageIndex={currentPageIndex}
          onPageChange={setCurrentPageIndex}
          tags={tagsOnCurrentPage}
          selectedTagId={selectedTagId}
          onSelectTag={setSelectedTagId}
          addMode={addMode}
          onAddTagAt={addTagAt}
        />
        <div className="side-panel">
          <div className="panel-tabs">
            <button
              className={panelTab === "tags" ? "active" : ""}
              onClick={() => setPanelTab("tags")}
            >
              Tags ({tags.length})
            </button>
            <button
              className={panelTab === "drawing" ? "active" : ""}
              onClick={() => setPanelTab("drawing")}
            >
              Drawing
            </button>
          </div>

          {panelTab === "tags" ? (
            <>
              <TagTable
                tags={tags}
                selectedTagId={selectedTagId}
                onSelectTag={setSelectedTagId}
                onUpdateTag={updateTag}
                onDeleteTag={deleteTag}
                onSetStateAll={setStateAll}
                onDeleteUnconfirmed={() =>
                  setTags((prev) => prev.filter((t) => t.state === "confirmed"))
                }
              />
              {selectedTag && (
                <TagDetail
                  tag={selectedTag}
                  page={currentPage}
                  onUpdateTag={updateTag}
                  onClose={() => setSelectedTagId(null)}
                  onLocate={() => {
                    const index = pages.findIndex((p) => p.pageNumber === selectedTag.page);
                    if (index >= 0) setCurrentPageIndex(index);
                    // Re-setting the id re-triggers the viewer's scroll effect.
                    setSelectedTagId(null);
                    window.setTimeout(() => setSelectedTagId(selectedTag.id), 0);
                  }}
                />
              )}
            </>
          ) : (
            <DrawingPanel
              meta={meta}
              onMetaChange={(patch) => setMeta((prev) => ({ ...prev, ...patch }))}
              lines={lines}
              onLinesChange={setLines}
              notes={notes}
              onNotesChange={setNotes}
              library={library}
              currentDrawingId={drawingId}
              onSave={handleSaveDrawing}
              onOpen={(id) => void handleOpenDrawing(id)}
              onDelete={(id) => void handleDeleteDrawing(id)}
              saveState={saveState}
              hasDrawing={pages.length > 0}
            />
          )}
        </div>
      </div>

      {showSettings && (
        <div className="settings-overlay" onClick={() => setShowSettings(false)}>
          <div onClick={(e) => e.stopPropagation()}>
            <SettingsPanel
              settings={settings}
              onChange={setSettings}
              onClose={() => setShowSettings(false)}
              onReapplyPatterns={reapplyPatterns}
              // The reviewer's name identifies a person, not an extraction
              // setting, so resetting the tuning doesn't clear it.
              onResetDefaults={() =>
                setSettings((prev) => ({ ...defaultSettings(), reviewerName: prev.reviewerName }))
              }
            />
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
