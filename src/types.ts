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

export type TagSource = "auto" | "manual" | "imported";

/**
 * Review state for a tag, per the extraction rule the project works to: a
 * reading is never guessed. Anything not visually confirmed against the
 * drawing stays "uncertain", and text that genuinely cannot be read is
 * marked "illegible" rather than filled in with a plausible value.
 */
export type ReviewState = "confirmed" | "uncertain" | "illegible";

export const REVIEW_STATES: ReviewState[] = ["uncertain", "confirmed", "illegible"];

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
  /** Review state. Replaces the old boolean "confirmed" flag. */
  state: ReviewState;
  source: TagSource;
  patternName: string;

  // --- Engineering attributes (instrument index / CMMS fields) ---
  /** ISA 5.1 function description, e.g. "Position Switch - Closed". */
  isaFunction: string;
  /** Loop or functional group, e.g. "1378A - Blowdown Valve". */
  loopGroup: string;
  /** Line number or parent equipment the device sits on. */
  lineOrEquipment: string;
  /** Control panel the device is wired to, e.g. "UCP-1300". */
  panel: string;
  /** Nominal size, e.g. '4"'. Free text — drawings print TBD sizes as XX". */
  size: string;
  /** Fail position, e.g. "FO (Fail Open)". */
  failPosition: string;
  notes: string;
  /** Drawing this tag continues onto, for match-line references. */
  continuesOn: string;

  // --- Audit trail ---
  /** ISO timestamp of the last edit, or "" if never edited since extraction. */
  updatedAt: string;
  /** Reviewer initials/name captured from Settings at edit time. */
  updatedBy: string;
}

/** Fields a seed CSV can populate, and that the review UI exposes as editable. */
export const TAG_ATTRIBUTE_FIELDS = [
  "isaFunction",
  "description",
  "loopGroup",
  "lineOrEquipment",
  "panel",
  "size",
  "failPosition",
  "notes",
] as const;

export type TagAttributeField = (typeof TAG_ATTRIBUTE_FIELDS)[number];

/** Title-block and project metadata for one drawing sheet. */
export interface DrawingMeta {
  drawingNumber: string;
  revision: string;
  title: string;
  project: string;
  client: string;
  county: string;
  state: string;
  date: string;
  /** Adjoining sheet(s) referenced by match lines, e.g. "SK-1310". */
  matchLineRefs: string;
  /** Name of the uploaded source file, for provenance. */
  sourceFileName: string;
}

export function emptyDrawingMeta(sourceFileName = ""): DrawingMeta {
  return {
    drawingNumber: "",
    revision: "",
    title: "",
    project: "",
    client: "",
    county: "",
    state: "",
    date: "",
    matchLineRefs: "",
    sourceFileName,
  };
}

/** A pipe line number appearing on the sheet. */
export interface LineRecord {
  id: string;
  lineNumber: string;
  size: string;
  service: string;
  specCode: string;
  fromRef: string;
  toRef: string;
  notes: string;
}

/** A hex-flagged note reference (e.g. 251A) and its text. */
export interface NoteRecord {
  id: string;
  flag: string;
  text: string;
}

/** Everything captured for one drawing, and the unit of persistence. */
export interface DrawingRecord {
  id: string;
  meta: DrawingMeta;
  tags: Tag[];
  lines: LineRecord[];
  notes: NoteRecord[];
  /** ISO timestamp, set whenever the record is saved. */
  savedAt: string;
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
  /** Recorded against every edit for the audit trail. */
  reviewerName: string;
}

export interface DetectedCircle {
  cx: number;
  cy: number;
  r: number;
}
