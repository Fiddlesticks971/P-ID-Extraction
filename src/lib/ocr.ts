import * as Tesseract from "tesseract.js";
import type { Bbox, OcrWord, PageImage } from "../types";

export interface OcrProgress {
  page: number;
  totalPages: number;
  status: string;
  progress: number;
}

/**
 * P&IDs commonly carry instrument tags as vertical (rotated 90°) text next
 * to horizontal branch lines. Tesseract's sparse-text segmentation doesn't
 * detect those at all in a single horizontal pass (verified against a real
 * drawing: it silently produced zero words for a strip of vertical tags),
 * so each page is also OCR'd rotated 90° clockwise and the results are
 * mapped back into the original page's coordinate space.
 */
function createRotatedCanvas(source: HTMLCanvasElement): HTMLCanvasElement {
  const rotated = document.createElement("canvas");
  rotated.width = source.height;
  rotated.height = source.width;
  const ctx = rotated.getContext("2d");
  if (!ctx) throw new Error("Could not create canvas context");
  ctx.translate(rotated.width / 2, rotated.height / 2);
  ctx.rotate(Math.PI / 2);
  ctx.drawImage(source, -source.width / 2, -source.height / 2);
  return rotated;
}

/** Maps a word bbox found in a 90°-clockwise-rotated canvas back to the original (unrotated) page's coordinate space. */
function unrotateBbox(bbox: Bbox, originalHeight: number): Bbox {
  return {
    x0: bbox.y0,
    x1: bbox.y1,
    y0: originalHeight - bbox.x1,
    y1: originalHeight - bbox.x0,
  };
}

async function recognizeCanvas(
  worker: Tesseract.Worker,
  canvas: HTMLCanvasElement,
  page: number,
  transformBbox?: (bbox: Bbox) => Bbox,
): Promise<OcrWord[]> {
  const { data } = await worker.recognize(canvas, {}, { blocks: true });
  const words: OcrWord[] = [];
  for (const block of data.blocks ?? []) {
    for (const paragraph of block.paragraphs) {
      for (const line of paragraph.lines) {
        for (const word of line.words) {
          const text = word.text.trim();
          if (!text) continue;
          words.push({
            text,
            confidence: word.confidence,
            bbox: transformBbox ? transformBbox({ ...word.bbox }) : { ...word.bbox },
            page,
          });
        }
      }
    }
  }
  return words;
}

/**
 * Runs OCR over every page canvas (both upright and rotated 90°) and
 * returns word-level results with bounding boxes, all in the original
 * page's coordinate space. Uses SPARSE_TEXT page segmentation since P&ID
 * text is scattered around symbols rather than laid out in paragraphs.
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
    words.push(...(await recognizeCanvas(worker, page.canvas, page.pageNumber)));

    const rotated = createRotatedCanvas(page.canvas);
    words.push(
      ...(await recognizeCanvas(worker, rotated, page.pageNumber, (bbox) =>
        unrotateBbox(bbox, page.height),
      )),
    );
  }

  await worker.terminate();
  return words;
}
