import * as Tesseract from "tesseract.js";
import type { Bbox, OcrWord, PageImage } from "../types";
import { cropMaskedCircle, detectCircles } from "./circleDetect";

export interface OcrProgress {
  page: number;
  totalPages: number;
  status: string;
  progress: number;
}

export interface RecognizeOptions {
  onProgress?: (info: OcrProgress) => void;
  /** Whether to run the extra circle-detection + isolated-crop OCR pass (see below). */
  detectBubbles?: boolean;
  /** Bubble radius search bounds, already in the page canvas's actual pixel space. */
  bubbleRadius?: { min: number; max: number };
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
 * Instrument bubbles (circular symbols enclosing a 1-2 line tag) are the
 * hardest case for whole-page OCR: Tesseract's page segmentation tends to
 * merge the circle's stroke and connecting lines with the text into a
 * non-text region and drops it entirely, especially when bubbles sit close
 * together. Detecting the circles first and OCR-ing each one individually
 * (cropped tight, stroke masked out, upscaled) recovers most of them —
 * validated against a real drawing: 19/21 bubbles read correctly this way
 * vs 0/21 from whole-page OCR alone.
 */
async function recognizeBubbles(
  worker: Tesseract.Worker,
  page: PageImage,
  bubbleRadius: { min: number; max: number },
  onProgress?: (found: number, total: number) => void,
): Promise<OcrWord[]> {
  const circles = detectCircles(page.canvas, {
    minRadius: bubbleRadius.min,
    maxRadius: bubbleRadius.max,
  });

  const words: OcrWord[] = [];
  const previousPsm = Tesseract.PSM.SPARSE_TEXT;
  await worker.setParameters({ tessedit_pageseg_mode: Tesseract.PSM.SINGLE_BLOCK });

  for (let i = 0; i < circles.length; i++) {
    const circle = circles[i];
    const crop = cropMaskedCircle(page.canvas, circle);
    const cropWords = await recognizeCanvas(worker, crop.canvas, page.pageNumber, (bbox) => ({
      x0: crop.offsetX + bbox.x0 / crop.scale,
      y0: crop.offsetY + bbox.y0 / crop.scale,
      x1: crop.offsetX + bbox.x1 / crop.scale,
      y1: crop.offsetY + bbox.y1 / crop.scale,
    }));
    words.push(...cropWords);
    onProgress?.(i + 1, circles.length);
  }

  await worker.setParameters({ tessedit_pageseg_mode: previousPsm });
  return words;
}

/**
 * Runs OCR over every page canvas (upright, rotated 90°, and — unless
 * disabled — one isolated pass per detected instrument bubble) and returns
 * word-level results with bounding boxes, all in the original page's
 * coordinate space. Uses SPARSE_TEXT page segmentation for the whole-page
 * passes since P&ID text is scattered around symbols rather than laid out
 * in paragraphs.
 */
export async function recognizePages(
  pages: PageImage[],
  options: RecognizeOptions = {},
): Promise<OcrWord[]> {
  const { onProgress, detectBubbles = true, bubbleRadius } = options;
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

    if (detectBubbles && bubbleRadius) {
      words.push(
        ...(await recognizeBubbles(worker, page, bubbleRadius, (found, total) => {
          onProgress?.({
            page: page.pageNumber,
            totalPages: pages.length,
            status: `reading circular tags (${found}/${total})`,
            progress: total > 0 ? found / total : 1,
          });
        })),
      );
    }
  }

  await worker.terminate();
  return words;
}
