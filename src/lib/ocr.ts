import * as Tesseract from "tesseract.js";
import type { OcrWord, PageImage } from "../types";

export interface OcrProgress {
  page: number;
  totalPages: number;
  status: string;
  progress: number;
}

/**
 * Runs OCR over every page canvas and returns word-level results with
 * bounding boxes. Uses SPARSE_TEXT page segmentation since P&ID text is
 * scattered around symbols rather than laid out in paragraphs.
 */
export async function recognizePages(
  pages: PageImage[],
  onProgress?: (info: OcrProgress) => void,
): Promise<OcrWord[]> {
  let currentPage = pages[0]?.pageNumber ?? 1;

  const worker = await Tesseract.createWorker("eng", 1, {
    // Self-hosted worker/core assets (see public/tesseract) so OCR works
    // offline instead of depending on the jsdelivr CDN. Only the English
    // language model (~a few MB) still downloads on first run; the browser
    // caches it in IndexedDB afterwards.
    workerPath: "/tesseract/worker.min.js",
    corePath: "/tesseract/core/tesseract-core-lstm.wasm.js",
    logger: (m) => {
      onProgress?.({
        page: currentPage,
        totalPages: pages.length,
        status: m.status,
        progress: m.progress,
      });
    },
  });

  await worker.setParameters({
    tessedit_pageseg_mode: Tesseract.PSM.SPARSE_TEXT,
    preserve_interword_spaces: "1",
  });

  const words: OcrWord[] = [];

  for (const page of pages) {
    currentPage = page.pageNumber;
    const { data } = await worker.recognize(page.canvas, {}, { blocks: true });
    for (const block of data.blocks ?? []) {
      for (const paragraph of block.paragraphs) {
        for (const line of paragraph.lines) {
          for (const word of line.words) {
            const text = word.text.trim();
            if (!text) continue;
            words.push({
              text,
              confidence: word.confidence,
              bbox: { ...word.bbox },
              page: page.pageNumber,
            });
          }
        }
      }
    }
  }

  await worker.terminate();
  return words;
}
