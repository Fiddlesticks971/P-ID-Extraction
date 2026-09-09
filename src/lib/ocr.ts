import * as Tesseract from "tesseract.js";
import type { Bbox, DetectedCircle, OcrWord, PageImage, TagOrigin } from "../types";
import { cropMaskedCircle, detectCircles, maskRegion } from "./circleDetect";
import type { MaskShape } from "./circleDetect";
import type { RegionRenderer } from "./pdfRender";

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
  /** Re-renders bubble regions from the vector source; greatly improves digit accuracy. */
  renderRegion?: RegionRenderer;
  /** Base scale the page rasters were rendered at, needed to convert region coordinates. */
  baseScale?: number;
}

/** Restricting the alphabet keeps stray glyphs ("$", "™", "\") out of tag text. */
const TAG_CHAR_WHITELIST = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-";

/** Absolute URL of the deployment root, so self-hosted OCR assets resolve under any base path. */
const assetBase = new URL(import.meta.env.BASE_URL, window.location.href);

/**
 * Each bubble is read more than once, under crop/scale combinations that
 * fail in different ways, and the results are voted on field by field.
 * Measured against a hand-transcribed ground truth for a real drawing's 20
 * bubbles: the circular mask reads function codes best (20/20) but clips
 * loop numbers that overflow the bubble, while the wide/short ellipse
 * recovers those. Either alone scores 16/20 tags fully correct; together
 * with voting they reach 18/20, against 5/20 for the previous single
 * upscaled-raster pass.
 */
const BUBBLE_VARIANTS: { renderScale: number; pad: number; shape: MaskShape }[] = [
  { renderScale: 4, pad: 1.25, shape: { rx: 0.82, ry: 0.82 } },
  { renderScale: 5, pad: 1.6, shape: { rx: 1.15, ry: 0.95 } },
];

const FUNC_TOKEN = /^[A-Z]{1,5}$/;
const LOOP_TOKEN = /^\d{2,5}[A-Z]?$/;

interface TokenVote {
  votes: number;
  confidenceSum: number;
}

/** Majority vote over candidate tokens; ties prefer the longer token (e.g. "1378A" over "1378"). */
function pickBest(tallies: Map<string, TokenVote>): { text: string; confidence: number } | null {
  let best: { text: string; vote: TokenVote } | null = null;
  for (const [text, vote] of tallies) {
    if (
      !best ||
      vote.votes > best.vote.votes ||
      (vote.votes === best.vote.votes && text.length > best.text.length)
    ) {
      best = { text, vote: vote };
    }
  }
  if (!best) return null;
  return { text: best.text, confidence: best.vote.confidenceSum / best.vote.votes };
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
  origin: TagOrigin,
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
            origin,
          });
        }
      }
    }
  }
  return words;
}

/** Builds one masked view of a bubble, re-rendered from vector source when available. */
async function buildBubbleView(
  page: PageImage,
  circle: DetectedCircle,
  variant: (typeof BUBBLE_VARIANTS)[number],
  renderRegion: RegionRenderer | undefined,
  baseScale: number,
): Promise<HTMLCanvasElement> {
  // renderScale is an absolute scale on the source's own coordinate space, so
  // a given text size lands at the same pixel height whatever the drawing —
  // which is what Tesseract actually cares about. Measured optimum is 4-5;
  // both lower and much higher (12+) read noticeably worse.
  const padR = circle.r * variant.pad;
  if (!renderRegion) {
    // No vector source (image upload): match the same effective resolution by
    // interpolating the page raster instead.
    return cropMaskedCircle(page.canvas, circle, {
      pad: variant.pad,
      shape: variant.shape,
      upscale: Math.max(1, variant.renderScale / baseScale),
    }).canvas;
  }
  const region = await renderRegion(
    page.pageNumber,
    { x: circle.cx - padR, y: circle.cy - padR, w: padR * 2, h: padR * 2 },
    variant.renderScale,
  );
  return maskRegion(region, variant.pad, variant.shape);
}

/**
 * Instrument bubbles (circular symbols enclosing a 1-2 line tag) are the
 * hardest case for whole-page OCR: Tesseract's page segmentation tends to
 * merge the circle's stroke and connecting lines with the text into a
 * non-text region and drops it entirely, especially when bubbles sit close
 * together. Each detected circle is instead read on its own, several times
 * over (see BUBBLE_VARIANTS), and the function code and loop number are
 * voted on separately across those reads.
 *
 * The vote winners are emitted as two stacked synthetic words covering the
 * bubble, so the normal pattern matching downstream combines them into a
 * tag exactly as it would a real two-line bubble.
 */
export interface UnreadBubble {
  page: number;
  bbox: Bbox;
}

async function recognizeBubbles(
  worker: Tesseract.Worker,
  page: PageImage,
  bubbleRadius: { min: number; max: number },
  renderRegion: RegionRenderer | undefined,
  baseScale: number,
  onProgress?: (found: number, total: number) => void,
): Promise<{ words: OcrWord[]; unread: UnreadBubble[] }> {
  const circles = detectCircles(page.canvas, {
    minRadius: bubbleRadius.min,
    maxRadius: bubbleRadius.max,
  });

  const words: OcrWord[] = [];
  const unread: UnreadBubble[] = [];
  await worker.setParameters({
    tessedit_pageseg_mode: Tesseract.PSM.SINGLE_BLOCK,
    tessedit_char_whitelist: TAG_CHAR_WHITELIST,
  });

  for (let i = 0; i < circles.length; i++) {
    const circle = circles[i];
    const funcVotes = new Map<string, TokenVote>();
    const loopVotes = new Map<string, TokenVote>();

    for (const variant of BUBBLE_VARIANTS) {
      const view = await buildBubbleView(page, circle, variant, renderRegion, baseScale);
      const read = await recognizeCanvas(worker, view, page.pageNumber, "bubble");
      // One vote per distinct token per variant, so a single noisy read
      // that repeats a token can't outweigh the other variants.
      const seen = new Set<string>();
      for (const word of read) {
        const text = word.text.toUpperCase().replace(/[^A-Z0-9]/g, "");
        if (!text || seen.has(text)) continue;
        seen.add(text);
        const target = FUNC_TOKEN.test(text) ? funcVotes : LOOP_TOKEN.test(text) ? loopVotes : null;
        if (!target) continue;
        const existing = target.get(text) ?? { votes: 0, confidenceSum: 0 };
        existing.votes += 1;
        existing.confidenceSum += word.confidence;
        target.set(text, existing);
      }
    }

    const func = pickBest(funcVotes);
    const loop = pickBest(loopVotes);
    const { cx, cy, r } = circle;

    // A detected bubble that produced no usable token is a real finding,
    // not a non-event: there is definitely an instrument symbol there, and
    // dropping it silently is how four tags went missing from a run
    // against the validation drawing. Report it so the reviewer gets it as
    // an "illegible" row sitting at the right place on the sheet.
    if (!func && !loop) {
      unread.push({
        page: page.pageNumber,
        bbox: { x0: cx - r, y0: cy - r, x1: cx + r, y1: cy + r },
      });
      onProgress?.(i + 1, circles.length);
      continue;
    }

    // Stacked halves of the bubble, so the pair-merging step joins them.
    if (func) {
      words.push({
        text: func.text,
        confidence: func.confidence,
        bbox: { x0: cx - r * 0.7, y0: cy - r * 0.65, x1: cx + r * 0.7, y1: cy - r * 0.05 },
        page: page.pageNumber,
        origin: "bubble",
      });
    }
    if (loop) {
      words.push({
        text: loop.text,
        confidence: loop.confidence,
        bbox: { x0: cx - r * 0.85, y0: cy + r * 0.05, x1: cx + r * 0.85, y1: cy + r * 0.65 },
        page: page.pageNumber,
        origin: "bubble",
      });
    }
    onProgress?.(i + 1, circles.length);
  }

  await worker.setParameters({
    tessedit_pageseg_mode: Tesseract.PSM.SPARSE_TEXT,
    tessedit_char_whitelist: "",
  });
  return { words, unread };
}

/**
 * Runs OCR over every page canvas (upright, rotated 90°, and — unless
 * disabled — one isolated pass per detected instrument bubble) and returns
 * word-level results with bounding boxes, all in the original page's
 * coordinate space. Uses SPARSE_TEXT page segmentation for the whole-page
 * passes since P&ID text is scattered around symbols rather than laid out
 * in paragraphs.
 */
export interface RecognizeResult {
  words: OcrWord[];
  /** Detected bubbles whose text could not be read at all. */
  unreadBubbles: UnreadBubble[];
}

export async function recognizePages(
  pages: PageImage[],
  options: RecognizeOptions = {},
): Promise<RecognizeResult> {
  const { onProgress, detectBubbles = true, bubbleRadius, renderRegion, baseScale = 1 } = options;
  let currentPage = pages[0]?.pageNumber ?? 1;

  const worker = await Tesseract.createWorker("eng", 1, {
    // Self-hosted worker/core assets (see public/tesseract) so OCR works
    // offline instead of depending on the jsdelivr CDN. Only the English
    // language model (~a few MB) still downloads on first run; the browser
    // caches it in IndexedDB afterwards.
    // Resolved against the deployment base so these still load when the app
    // is served from a subpath (e.g. GitHub Pages at /<repo>/).
    workerPath: new URL("tesseract/worker.min.js", assetBase).href,
    corePath: new URL("tesseract/core/tesseract-core-lstm.wasm.js", assetBase).href,
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
  const unreadBubbles: UnreadBubble[] = [];

  for (const page of pages) {
    currentPage = page.pageNumber;
    words.push(...(await recognizeCanvas(worker, page.canvas, page.pageNumber, "page")));

    const rotated = createRotatedCanvas(page.canvas);
    words.push(
      ...(await recognizeCanvas(worker, rotated, page.pageNumber, "page", (bbox) =>
        unrotateBbox(bbox, page.height),
      )),
    );

    if (detectBubbles && bubbleRadius) {
      const bubbles = await recognizeBubbles(
        worker,
        page,
        bubbleRadius,
        renderRegion,
        baseScale,
        (found, total) => {
          onProgress?.({
            page: page.pageNumber,
            totalPages: pages.length,
            status: `reading circular tags (${found}/${total})`,
            progress: total > 0 ? found / total : 1,
          });
        },
      );
      words.push(...bubbles.words);
      unreadBubbles.push(...bubbles.unread);
    }
  }

  await worker.terminate();
  return { words, unreadBubbles };
}
