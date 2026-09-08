export interface Bbox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface OcrWord {
  text: string;
  confidence: number;
  bbox: Bbox;
  page: number;
}

export interface PageImage {
  pageNumber: number;
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
}

export type TagSource = "auto" | "manual";

export interface Tag {
  id: string;
  text: string;
  functionCode: string;
  loopNumber: string;
  suffix: string;
  description: string;
  type: string;
  page: number;
  bbox: Bbox;
  confidence: number;
  confirmed: boolean;
  source: TagSource;
  patternName: string;
}

export interface TagPattern {
  id: string;
  name: string;
  pattern: string;
  enabled: boolean;
  description: string;
}

export interface AppSettings {
  ocrScale: number;
  groupStackedText: number;
  patterns: TagPattern[];
  detectBubbles: boolean;
  /** Bubble radius search range, in pixels at ocrScale = 1 (scaled by ocrScale at detection time). */
  bubbleMinRadius: number;
  bubbleMaxRadius: number;
}

export interface DetectedCircle {
  cx: number;
  cy: number;
  r: number;
}
