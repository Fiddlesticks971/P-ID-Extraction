import * as pdfjsLib from "pdfjs-dist";
import pdfWorkerUrl from "./pdfWorkerEntry.ts?worker&url";
import type { PageImage } from "../types";
import { installMapUpsertPolyfill } from "./mapUpsertPolyfill";

installMapUpsertPolyfill();
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

/** A rectangle in the base-scale page raster's pixel coordinates. */
export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Re-renders a region of a page from the original vector source at an
 * arbitrary scale. Upscaling the page raster can only interpolate pixels
 * that are already there; re-rendering gives genuinely sharper glyphs,
 * which is what lets OCR tell a "3" from a "5" on small bubble text.
 */
export type RegionRenderer = (
  pageNumber: number,
  region: Region,
  targetScale: number,
) => Promise<HTMLCanvasElement>;

export interface LoadedDocument {
  pages: PageImage[];
  /** Only available for PDFs; image uploads have no vector source to re-render from. */
  renderRegion?: RegionRenderer;
  /**
   * Scale the page rasters were produced at, relative to the source's own
   * coordinate space (PDF points for PDFs, native pixels for images). Needed
   * to convert an absolute target scale into a raster upscale factor.
   */
  baseScale: number;
  /** Releases the underlying pdf.js document and its worker. */
  destroy: () => void;
}

async function loadPdf(file: File, scale: number): Promise<LoadedDocument> {
  const buffer = await file.arrayBuffer();
  const loadingTask = pdfjsLib.getDocument({ data: buffer });
  const pdf = await loadingTask.promise;
  const pages: PageImage[] = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not create canvas context");
    await page.render({ canvas, canvasContext: context, viewport }).promise;
    pages.push({ pageNumber, canvas, width: canvas.width, height: canvas.height });
  }

  const renderRegion: RegionRenderer = async (pageNumber, region, targetScale) => {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: targetScale });
    const ratio = targetScale / scale;

    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.ceil(region.w * ratio));
    canvas.height = Math.max(1, Math.ceil(region.h * ratio));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Could not create canvas context");
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    await page.render({
      canvas,
      canvasContext: ctx,
      viewport,
      // Shifts the page so the requested region lands at the canvas origin.
      transform: [1, 0, 0, 1, -region.x * ratio, -region.y * ratio],
    }).promise;

    return canvas;
  };

  return { pages, renderRegion, baseScale: scale, destroy: () => void loadingTask.destroy() };
}

async function loadImage(file: File): Promise<LoadedDocument> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("Could not load image file"));
      image.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not create canvas context");
    context.drawImage(img, 0, 0);
    return {
      pages: [{ pageNumber: 1, canvas, width: canvas.width, height: canvas.height }],
      // Images are used at native resolution, so their raster is scale 1.
      baseScale: 1,
      destroy: () => {},
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function loadFile(file: File, scale: number): Promise<LoadedDocument> {
  if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
    return loadPdf(file, scale);
  }
  return loadImage(file);
}
