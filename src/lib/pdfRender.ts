import * as pdfjsLib from "pdfjs-dist";
import pdfWorkerUrl from "./pdfWorkerEntry.ts?worker&url";
import type { PageImage } from "../types";
import { installMapUpsertPolyfill } from "./mapUpsertPolyfill";

installMapUpsertPolyfill();
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

async function renderPdfToPages(
  file: File,
  scale: number,
): Promise<PageImage[]> {
  const buffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
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

  return pages;
}

async function renderImageToPages(file: File): Promise<PageImage[]> {
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
    return [{ pageNumber: 1, canvas, width: canvas.width, height: canvas.height }];
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function loadFileToPages(
  file: File,
  scale: number,
): Promise<PageImage[]> {
  if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
    return renderPdfToPages(file, scale);
  }
  return renderImageToPages(file);
}
