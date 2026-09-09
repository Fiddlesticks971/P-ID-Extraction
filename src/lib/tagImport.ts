import { parseCsv, rowsToObjects } from "./csv";
import type { LineRecord, ReviewState, Tag } from "../types";
import { REVIEW_STATES } from "../types";

/**
 * Ingest for a seed tag list — the reviewed, hand-transcribed CSV that an
 * extraction pass produces (`instrument_tags.csv`). Importing one is what
 * turns a raw OCR result into a verified instrument index: rows that match
 * a detected tag enrich it in place (keeping its position on the drawing,
 * which the CSV has no way to know), and rows with no match are added so
 * nothing in the reviewed list is silently dropped.
 */

export interface SeedRow {
  tag: string;
  isaFunction: string;
  description: string;
  loopGroup: string;
  lineOrEquipment: string;
  panel: string;
  size: string;
  failPosition: string;
  notes: string;
  /** Only present when re-importing a file this app exported. */
  state?: ReviewState;
}

/**
 * Column aliases, normalized (lowercase, separators stripped). The first
 * list entry that is present wins, so a file exported by this app and a
 * hand-written seed file both import without the user renaming anything.
 */
const FIELD_ALIASES: Record<keyof Omit<SeedRow, "state">, string[]> = {
  tag: ["tag", "tagnumber", "tagno"],
  isaFunction: ["isafunction", "function", "functiondescription"],
  description: ["description", "servicedescription"],
  loopGroup: ["loopgroup", "loop", "group"],
  lineOrEquipment: ["lineorequipment", "line", "equipment", "lineequipment"],
  panel: ["panel", "controlpanel"],
  size: ["size", "nominalsize"],
  failPosition: ["failposition", "failsafe", "failaction"],
  notes: ["notes", "note", "comment", "comments"],
};

const STATE_ALIASES = ["reviewstate", "state", "confidence", "verified"];

function pick(row: Record<string, string>, aliases: string[]): string {
  for (const alias of aliases) {
    const value = row[alias];
    if (value !== undefined && value !== "") return value;
  }
  return "";
}

function parseState(raw: string): ReviewState | undefined {
  const v = raw.trim().toLowerCase();
  if (!v) return undefined;
  if ((REVIEW_STATES as string[]).includes(v)) return v as ReviewState;
  // Tolerate the boolean "Verified" column earlier versions exported.
  if (v === "yes" || v === "true") return "confirmed";
  if (v === "no" || v === "false") return "uncertain";
  return undefined;
}

/**
 * Comparison key for tag text. Real drawings and hand-typed lists disagree
 * about separators and spacing ("ZSC-1378A" / "ZSC 1378A" / "zsc1378a"),
 * and OCR of a bubble emits the two lines with no separator at all, so the
 * key ignores everything but letters and digits.
 */
export function tagKey(text: string): string {
  return text.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export interface SeedImportResult {
  rows: SeedRow[];
  warnings: string[];
}

export function parseSeedCsv(text: string): SeedImportResult {
  const objects = rowsToObjects(parseCsv(text));
  const warnings: string[] = [];
  const rows: SeedRow[] = [];

  if (objects.length === 0) {
    return { rows, warnings: ["The file has no data rows."] };
  }
  if (!Object.keys(objects[0]).some((k) => FIELD_ALIASES.tag.includes(k))) {
    return {
      rows,
      warnings: [
        'No "Tag" column found. Expected a header row containing at least a Tag column (e.g. Tag,ISA_Function,Description,Loop_Group,...).',
      ],
    };
  }

  const seen = new Set<string>();
  for (const [index, obj] of objects.entries()) {
    const tag = pick(obj, FIELD_ALIASES.tag);
    if (!tag) {
      warnings.push(`Row ${index + 2}: no tag number — skipped.`);
      continue;
    }
    const key = tagKey(tag);
    if (seen.has(key)) {
      warnings.push(`Row ${index + 2}: duplicate tag "${tag}" — skipped.`);
      continue;
    }
    seen.add(key);
    rows.push({
      tag: tag.trim(),
      isaFunction: pick(obj, FIELD_ALIASES.isaFunction),
      description: pick(obj, FIELD_ALIASES.description),
      loopGroup: pick(obj, FIELD_ALIASES.loopGroup),
      lineOrEquipment: pick(obj, FIELD_ALIASES.lineOrEquipment),
      panel: pick(obj, FIELD_ALIASES.panel),
      size: pick(obj, FIELD_ALIASES.size),
      failPosition: pick(obj, FIELD_ALIASES.failPosition),
      notes: pick(obj, FIELD_ALIASES.notes),
      state: parseState(pick(obj, STATE_ALIASES)),
    });
  }

  return { rows, warnings };
}

export interface MergeOptions {
  /** Page number given to rows that had no match on the drawing. */
  page: number;
  /** Review state applied to matched rows, per "seed data is reviewed data". */
  importedState: ReviewState;
  reviewer: string;
  /**
   * Overwrite an attribute that already has a value. Off by default so an
   * import can't silently discard a correction made in the review UI.
   */
  overwriteExisting: boolean;
}

/**
 * An import is really a reconciliation between a reviewed list and what
 * OCR found on the sheet, and the three ways they can disagree are each
 * worth acting on:
 *
 * - in the list but not on the drawing → the extractor missed it, or read
 *   it wrong (a dropped suffix letter is the classic case);
 * - on the drawing but not in the list → a false positive, or a tag the
 *   reviewed list forgot;
 * - the same tag read twice → two symbols resolved to one identity, so at
 *   least one of them is wrong.
 */
export interface MergeResult {
  tags: Tag[];
  matched: number;
  added: number;
  /** Tags on the drawing that the seed list said nothing about. */
  unmatchedTagTexts: string[];
  /** Seed rows with no counterpart on the drawing. */
  missingFromDrawing: string[];
  /** Tag texts that appeared more than once in the detected set. */
  duplicateTagTexts: string[];
}

let importCounter = 0;

/** Applies a seed row's attributes to a tag, leaving non-empty fields alone unless overwriting. */
function applyRow(tag: Tag, row: SeedRow, options: MergeOptions): Tag {
  const take = (current: string, incoming: string) =>
    incoming && (options.overwriteExisting || !current) ? incoming : current;

  return {
    ...tag,
    // The seed list is the reviewed source of truth for the tag's own text,
    // so a matched row corrects OCR spelling (e.g. "ZSC-13784" -> "ZSC-1378A")
    // while keeping the bounding box that locates it on the drawing.
    text: row.tag,
    isaFunction: take(tag.isaFunction, row.isaFunction),
    description: take(tag.description, row.description),
    loopGroup: take(tag.loopGroup, row.loopGroup),
    lineOrEquipment: take(tag.lineOrEquipment, row.lineOrEquipment),
    panel: take(tag.panel, row.panel),
    size: take(tag.size, row.size),
    failPosition: take(tag.failPosition, row.failPosition),
    notes: take(tag.notes, row.notes),
    state: row.state ?? options.importedState,
    updatedAt: new Date().toISOString(),
    updatedBy: options.reviewer,
  };
}

function seedRowToTag(row: SeedRow, options: MergeOptions): Tag {
  importCounter += 1;
  const match = /^(?<func>[A-Za-z]+)[\s-]*(?<loop>\d+)(?<suffix>[A-Za-z]*)$/.exec(row.tag.trim());
  return {
    id: `import-${Date.now()}-${importCounter}`,
    text: row.tag,
    functionCode: match?.groups?.func?.toUpperCase() ?? "",
    loopNumber: match?.groups?.loop ?? "",
    suffix: match?.groups?.suffix?.toUpperCase() ?? "",
    description: row.description,
    type: "Imported",
    page: options.page,
    // No position: the row came from a list, not from the drawing. A zero-area
    // box keeps it out of the overlay until someone places it with "+ Add Tag".
    bbox: { x0: 0, y0: 0, x1: 0, y1: 0 },
    confidence: 100,
    state: row.state ?? options.importedState,
    source: "imported",
    patternName: "Imported",
    isaFunction: row.isaFunction,
    loopGroup: row.loopGroup,
    lineOrEquipment: row.lineOrEquipment,
    panel: row.panel,
    size: row.size,
    failPosition: row.failPosition,
    notes: row.notes,
    continuesOn: "",
    updatedAt: new Date().toISOString(),
    updatedBy: options.reviewer,
  };
}

/**
 * Merges seed rows into the current tag list. Matching is by normalized tag
 * text, so it survives the separator and spacing differences between a
 * typed list and an OCR reading.
 */
export function mergeSeedRows(tags: Tag[], rows: SeedRow[], options: MergeOptions): MergeResult {
  const byKey = new Map<string, Tag>();
  const duplicateTagTexts: string[] = [];
  for (const tag of tags) {
    // First writer wins, so a duplicate reading can't shadow the tag that
    // already carries reviewed attributes.
    const key = tagKey(tag.text);
    if (byKey.has(key)) duplicateTagTexts.push(tag.text);
    else byKey.set(key, tag);
  }

  const patched = new Map<string, Tag>();
  const added: Tag[] = [];
  const missingFromDrawing: string[] = [];
  for (const row of rows) {
    const key = tagKey(row.tag);
    const existing = byKey.get(key);
    if (existing) {
      patched.set(existing.id, applyRow(existing, row, options));
    } else {
      added.push(seedRowToTag(row, options));
      missingFromDrawing.push(row.tag);
    }
  }

  const merged = tags.map((t) => patched.get(t.id) ?? t);
  const seedKeys = new Set(rows.map((r) => tagKey(r.tag)));
  const unmatchedTagTexts = tags
    .filter((t) => !seedKeys.has(tagKey(t.text)))
    .map((t) => t.text);

  return {
    tags: [...merged, ...added],
    matched: patched.size,
    added: added.length,
    unmatchedTagTexts,
    missingFromDrawing,
    duplicateTagTexts,
  };
}

// --- Line numbers -----------------------------------------------------

const LINE_FIELD_ALIASES = {
  lineNumber: ["linenumber", "line", "lineno"],
  size: ["size", "nominalsize"],
  service: ["service", "fluid", "commodity"],
  specCode: ["speccode", "spec", "pipingspec"],
  fromRef: ["fromref", "from", "origin"],
  toRef: ["toref", "to", "destination"],
  notes: ["notes", "note", "comment", "comments"],
};

let lineCounter = 0;

export function nextLineId(): string {
  lineCounter += 1;
  return `line-${Date.now()}-${lineCounter}`;
}

/**
 * Splits a conventional line number into its parts, e.g.
 * `8"-G-0331-8E1550` -> size 8", service G, spec 8E1550.
 */
export function parseLineNumber(lineNumber: string): Pick<LineRecord, "size" | "service" | "specCode"> {
  const match = /^\s*([\dX/."']+)?\s*-?\s*([A-Za-z]{1,4})-([\dX]{2,6})(?:-([A-Za-z0-9]+))?/.exec(
    lineNumber,
  );
  if (!match) return { size: "", service: "", specCode: "" };
  return {
    size: (match[1] ?? "").replace(/["']$/, '"'),
    service: (match[2] ?? "").toUpperCase(),
    specCode: match[4] ?? "",
  };
}

export function lineFromNumber(lineNumber: string): LineRecord {
  const trimmed = lineNumber.trim();
  const parsed = parseLineNumber(trimmed);
  return {
    id: nextLineId(),
    lineNumber: trimmed,
    size: parsed.size,
    service: parsed.service,
    specCode: parsed.specCode,
    fromRef: "",
    toRef: "",
    notes: "",
  };
}

/**
 * Imports line numbers from either a CSV with a Line Number column or a
 * plain list (one per line, or comma-separated) — engineers routinely have
 * the latter pasted out of a drawing note rather than a structured file.
 */
export function parseLinesInput(text: string): LineRecord[] {
  const rows = parseCsv(text);
  if (rows.length === 0) return [];

  const header = rows[0].map((h) => h.trim().toLowerCase().replace(/[\s_-]+/g, ""));
  const hasHeader = header.some((h) => LINE_FIELD_ALIASES.lineNumber.includes(h));

  if (hasHeader) {
    return rowsToObjects(rows)
      .map((obj) => {
        const lineNumber = pick(obj, LINE_FIELD_ALIASES.lineNumber);
        if (!lineNumber) return null;
        const base = lineFromNumber(lineNumber);
        return {
          ...base,
          size: pick(obj, LINE_FIELD_ALIASES.size) || base.size,
          service: pick(obj, LINE_FIELD_ALIASES.service) || base.service,
          specCode: pick(obj, LINE_FIELD_ALIASES.specCode) || base.specCode,
          fromRef: pick(obj, LINE_FIELD_ALIASES.fromRef),
          toRef: pick(obj, LINE_FIELD_ALIASES.toRef),
          notes: pick(obj, LINE_FIELD_ALIASES.notes),
        };
      })
      .filter((l): l is LineRecord => l !== null);
  }

  const seen = new Set<string>();
  return text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => {
      if (!s || seen.has(s)) return false;
      seen.add(s);
      return true;
    })
    .map(lineFromNumber);
}
