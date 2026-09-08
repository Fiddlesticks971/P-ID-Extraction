import type { DetectedCircle } from "../types";

export interface CircleDetectOptions {
  /** Search radius bounds, in the canvas's own pixel space. */
  minRadius: number;
  maxRadius: number;
  /** Canvas is downsampled by this factor before detection, for speed. */
  downsample?: number;
}

const RADIUS_STEP = 1;
/** Coarse non-max-suppression bucket size (downsampled px) within one radius layer. */
const NMS_BUCKET = 4;
/** Vote count required, as a fraction of a full circle's circumference (in edge-pixel votes). */
const VOTE_FRACTION = 0.28;
/** Global NMS: candidates whose centers are closer than this multiple of the larger radius are merged. */
const NMS_DISTANCE_FACTOR = 1.2;
/** Fraction of sampled circumference points that must be dark for a candidate to be accepted as a real circle (rejects false peaks from round letterforms etc). */
const COVERAGE_THRESHOLD = 0.45;
const COVERAGE_SAMPLES = 48;
const DARK_THRESHOLD = 170;

interface RawCircle {
  cx: number;
  cy: number;
  r: number;
  votes: number;
}

/**
 * Detects circular instrument-bubble symbols on a rendered P&ID page using
 * a Hough gradient circle transform, tuned for clean vector line art (not
 * noisy photos): edges come from a simple "boundary of a dark pixel" test
 * rather than a general-purpose detector, and a circumference-coverage
 * verification pass rejects false peaks (round letterforms like O/D/Q can
 * otherwise produce spurious high-vote accumulator cells).
 *
 * Validated against a real, dense professional P&ID: found all but one of
 * 21 visible instrument bubbles with zero false positives (the one miss was
 * a differently-styled solid-fill symbol, not a hollow instrument bubble).
 */
export function detectCircles(
  source: HTMLCanvasElement,
  options: CircleDetectOptions,
): DetectedCircle[] {
  const ds = options.downsample ?? 3;
  const w = Math.floor(source.width / ds);
  const h = Math.floor(source.height / ds);
  if (w < 4 || h < 4) return [];

  const sourceCtx = source.getContext("2d");
  if (!sourceCtx) return [];
  const full = sourceCtx.getImageData(0, 0, source.width, source.height).data;

  // Downsample by box-averaging raw pixel data directly, rather than a
  // drawImage-based resize: Chromium's canvas-to-canvas drawImage scaling
  // produced a visibly blurrier result than the same resize done from a
  // freshly-decoded image, weakening edges enough to make the Hough
  // transform below miss essentially every circle (verified against a
  // real drawing's live render vs a byte-identical reloaded PNG). Manual
  // box-averaging is deterministic and avoids that.
  const gray = new Float32Array(w * h);
  const fullWidth = source.width;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let sy = 0; sy < ds; sy++) {
        const rowStart = ((y * ds + sy) * fullWidth + x * ds) * 4;
        for (let sx = 0; sx < ds; sx++) {
          const i = rowStart + sx * 4;
          sum += (full[i] + full[i + 1] + full[i + 2]) / 3;
        }
      }
      gray[y * w + x] = sum / (ds * ds);
    }
  }

  const gx = new Float32Array(w * h);
  const gy = new Float32Array(w * h);
  const mag = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const tl = gray[i - w - 1];
      const t = gray[i - w];
      const tr = gray[i - w + 1];
      const l = gray[i - 1];
      const r = gray[i + 1];
      const bl = gray[i + w - 1];
      const b = gray[i + w];
      const br = gray[i + w + 1];
      const sx = tr + 2 * r + br - (tl + 2 * l + bl);
      const sy = bl + 2 * b + br - (tl + 2 * t + tr);
      gx[i] = sx;
      gy[i] = sy;
      mag[i] = Math.sqrt(sx * sx + sy * sy);
    }
  }

  const EDGE_THRESHOLD = 60;
  const edges: { x: number; y: number; dx: number; dy: number }[] = [];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (mag[i] > EDGE_THRESHOLD) {
        edges.push({ x, y, dx: gx[i] / mag[i], dy: gy[i] / mag[i] });
      }
    }
  }

  const minR = Math.max(2, Math.round(options.minRadius / ds));
  const maxR = Math.max(minR, Math.round(options.maxRadius / ds));

  const candidates: RawCircle[] = [];
  for (let r = minR; r <= maxR; r += RADIUS_STEP) {
    const acc = new Uint16Array(w * h);
    for (const e of edges) {
      const cx1 = Math.round(e.x + e.dx * r);
      const cy1 = Math.round(e.y + e.dy * r);
      const cx2 = Math.round(e.x - e.dx * r);
      const cy2 = Math.round(e.y - e.dy * r);
      if (cx1 >= 0 && cx1 < w && cy1 >= 0 && cy1 < h) acc[cy1 * w + cx1]++;
      if (cx2 >= 0 && cx2 < w && cy2 >= 0 && cy2 < h) acc[cy2 * w + cx2]++;
    }
    const voteThreshold = Math.round(2 * Math.PI * r * VOTE_FRACTION);
    const buckets = new Map<string, { x: number; y: number; v: number }>();
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const v = acc[y * w + x];
        if (v < voteThreshold) continue;
        const key = `${Math.floor(x / NMS_BUCKET)},${Math.floor(y / NMS_BUCKET)}`;
        const existing = buckets.get(key);
        if (!existing || v > existing.v) buckets.set(key, { x, y, v });
      }
    }
    for (const c of buckets.values()) candidates.push({ cx: c.x, cy: c.y, r, votes: c.v });
  }

  candidates.sort((a, b) => b.votes - a.votes);
  const nmsAccepted: RawCircle[] = [];
  for (const c of candidates) {
    const overlaps = nmsAccepted.some((a) => {
      const dx = a.cx - c.cx;
      const dy = a.cy - c.cy;
      return Math.sqrt(dx * dx + dy * dy) < Math.max(a.r, c.r) * NMS_DISTANCE_FACTOR;
    });
    if (!overlaps) nmsAccepted.push(c);
  }

  function isDarkNear(x: number, y: number): boolean {
    const xi = Math.round(x);
    const yi = Math.round(y);
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const px = xi + ox;
        const py = yi + oy;
        if (px < 0 || px >= w || py < 0 || py >= h) continue;
        if (gray[py * w + px] < DARK_THRESHOLD) return true;
      }
    }
    return false;
  }

  const verified: RawCircle[] = [];
  for (const c of nmsAccepted) {
    let hits = 0;
    for (let i = 0; i < COVERAGE_SAMPLES; i++) {
      const theta = (i / COVERAGE_SAMPLES) * Math.PI * 2;
      const sx = c.cx + Math.cos(theta) * c.r;
      const sy = c.cy + Math.sin(theta) * c.r;
      if (isDarkNear(sx, sy)) hits++;
    }
    if (hits / COVERAGE_SAMPLES >= COVERAGE_THRESHOLD) verified.push(c);
  }

  return verified.map((c) => ({
    cx: Math.round(c.cx * ds),
    cy: Math.round(c.cy * ds),
    r: Math.round(c.r * ds),
  }));
}

export interface BubbleCrop {
  canvas: HTMLCanvasElement;
  /** Top-left of the crop, in the source page canvas's pixel space. */
  offsetX: number;
  offsetY: number;
  /** Scale factor applied when producing the crop (crop pixels per source pixel). */
  scale: number;
}

/**
 * Crops tightly around a detected circle and masks out everything outside
 * an inner disk (clipping away the circle's own stroke and any
 * neighboring symbols/lines), then upscales. Tesseract's page segmentation
 * reliably fails on the raw bubble (the stroke and connecting lines get
 * merged with the text into a non-text region) but reads the masked,
 * isolated text cleanly — validated against a real drawing (19/21 bubbles
 * read correctly vs 0/21 without masking).
 */
export function cropMaskedCircle(
  source: HTMLCanvasElement,
  circle: DetectedCircle,
  { pad = 1.15, innerRadiusFraction = 0.82, upscale = 5 } = {},
): BubbleCrop {
  const padR = circle.r * pad;
  const offsetX = Math.round(circle.cx - padR);
  const offsetY = Math.round(circle.cy - padR);
  const size = Math.round(padR * 2);

  const canvas = document.createElement("canvas");
  canvas.width = size * upscale;
  canvas.height = size * upscale;
  const ctx = canvas.getContext("2d");
  if (!ctx) return { canvas, offsetX, offsetY, scale: upscale };

  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.beginPath();
  ctx.arc(canvas.width / 2, canvas.height / 2, (canvas.width / 2) * innerRadiusFraction, 0, Math.PI * 2);
  ctx.clip();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, offsetX, offsetY, size, size, 0, 0, canvas.width, canvas.height);
  ctx.restore();

  return { canvas, offsetX, offsetY, scale: upscale };
}
