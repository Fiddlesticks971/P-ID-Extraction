import { useMemo, useRef, useState } from "react";
import { FileUpload } from "./components/FileUpload";
import { PidViewer } from "./components/PidViewer";
import { TagTable } from "./components/TagTable";
import { SettingsPanel } from "./components/SettingsPanel";
import { loadFile } from "./lib/pdfRender";
import type { LoadedDocument } from "./lib/pdfRender";
import { recognizePages } from "./lib/ocr";
import type { OcrProgress } from "./lib/ocr";
import { extractTagCandidates, candidatesToTags } from "./lib/grouping";
import { DEFAULT_PATTERNS } from "./lib/tagPatterns";
import { exportTagsCsv, exportTagsXlsx, exportAnnotatedPage } from "./lib/export";
import type { AppSettings, OcrWord, PageImage, Tag } from "./types";
import "./index.css";

type Status = "idle" | "rendering" | "ocr" | "grouping" | "ready" | "error";

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
  };
}

let manualTagCounter = 0;

function App() {
  const [fileName, setFileName] = useState<string | null>(null);
  const [pages, setPages] = useState<PageImage[]>([]);
  const [words, setWords] = useState<OcrWord[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [currentPageIndex, setCurrentPageIndex] = useState(0);
  const [selectedTagId, setSelectedTagId] = useState<string | null>(null);
  const [settings, setSettings] = useState<AppSettings>(defaultSettings());
  const [showSettings, setShowSettings] = useState(false);
  const [addMode, setAddMode] = useState(false);
  const [status, setStatus] = useState<Status>("idle");
  const [ocrProgress, setOcrProgress] = useState<OcrProgress | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const documentRef = useRef<LoadedDocument | null>(null);

  const busy = status === "rendering" || status === "ocr" || status === "grouping";
  const currentPage = pages[currentPageIndex] ?? null;

  const tagsOnCurrentPage = useMemo(
    () => tags.filter((t) => t.page === (currentPage?.pageNumber ?? -1)),
    [tags, currentPage],
  );

  async function processFile(file: File) {
    setFileName(file.name);
    setErrorMessage(null);
    setTags([]);
    setWords([]);
    setSelectedTagId(null);
    setCurrentPageIndex(0);
    setOcrProgress(null);

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
      const ocrWords = await withTimeout(
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
      setWords(ocrWords);

      setStatus("grouping");
      const candidates = extractTagCandidates(ocrWords, settings.patterns, settings.groupStackedText);
      setTags(candidatesToTags(candidates));
      setStatus("ready");
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
      const candidates = extractTagCandidates(words, settings.patterns, settings.groupStackedText);
      setTags(candidatesToTags(candidates));
      setStatus("ready");
    }, 0);
  }

  function updateTag(id: string, patch: Partial<Tag>) {
    setTags((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
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
      confirmed: true,
      source: "manual",
      patternName: "Manual",
    };
    setTags((prev) => [...prev, newTag]);
    setSelectedTagId(newTag.id);
    setAddMode(false);
  }

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
          <button onClick={() => exportTagsCsv(tags)} disabled={tags.length === 0}>
            Export CSV
          </button>
          <button onClick={() => exportTagsXlsx(tags)} disabled={tags.length === 0}>
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
        <TagTable
          tags={tags}
          selectedTagId={selectedTagId}
          onSelectTag={setSelectedTagId}
          onUpdateTag={updateTag}
          onDeleteTag={deleteTag}
          onConfirmAll={() => setTags((prev) => prev.map((t) => ({ ...t, confirmed: true })))}
          onDeleteUnconfirmed={() => setTags((prev) => prev.filter((t) => t.confirmed))}
        />
      </div>

      {showSettings && (
        <div className="settings-overlay" onClick={() => setShowSettings(false)}>
          <div onClick={(e) => e.stopPropagation()}>
            <SettingsPanel
              settings={settings}
              onChange={setSettings}
              onClose={() => setShowSettings(false)}
              onReapplyPatterns={reapplyPatterns}
              onResetDefaults={() => setSettings(defaultSettings())}
            />
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
