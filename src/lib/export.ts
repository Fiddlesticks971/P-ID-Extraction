import * as XLSX from "xlsx";
import { saveAs } from "file-saver";
import { toCsv } from "./csv";
import type { DrawingMeta, LineRecord, NoteRecord, PageImage, Tag } from "../types";

/**
 * The first nine columns are exactly the seed-file schema
 * (`instrument_tags.csv`), in the same order, so an export drops straight
 * back into whatever consumed that file — an instrument index or a CMMS
 * import — without remapping. Everything after them is provenance the seed
 * format has no place for: how the tag was read, how sure we are, where it
 * sits on the sheet, and who last touched it.
 */
const COLUMNS = [
  "Tag",
  "ISA_Function",
  "Description",
  "Loop_Group",
  "Line_or_Equipment",
  "Panel",
  "Size",
  "Fail_Position",
  "Notes",
  "Review_State",
  "Function_Code",
  "Loop_Number",
  "Suffix",
  "Type",
  "Source",
  "Continues_On",
  "Page",
  "Confidence_%",
  "Center_X",
  "Center_Y",
  "Width",
  "Height",
  "Updated_At",
  "Updated_By",
] as const;

type Column = (typeof COLUMNS)[number];

/**
 * Positions are in page-raster pixels at the OCR render scale the run used,
 * matching the highlight boxes on screen. They make two exports of the same
 * drawing diffable — without them a tag can only be matched by its text,
 * which is exactly what differs when OCR misreads something. Imported rows
 * that were never placed on the drawing have a zero-area box and export as
 * blank rather than as a misleading 0,0.
 */
function tagRow(tag: Tag): Record<Column, string | number> {
  const placed = tag.bbox.x1 > tag.bbox.x0 || tag.bbox.y1 > tag.bbox.y0;
  return {
    Tag: tag.text,
    ISA_Function: tag.isaFunction,
    Description: tag.description,
    Loop_Group: tag.loopGroup,
    Line_or_Equipment: tag.lineOrEquipment,
    Panel: tag.panel,
    Size: tag.size,
    Fail_Position: tag.failPosition,
    Notes: tag.notes,
    Review_State: tag.state,
    Function_Code: tag.functionCode,
    Loop_Number: tag.loopNumber,
    Suffix: tag.suffix,
    Type: tag.type,
    Source: tag.source,
    Continues_On: tag.continuesOn,
    Page: tag.page,
    "Confidence_%": Math.round(tag.confidence),
    Center_X: placed ? Math.round((tag.bbox.x0 + tag.bbox.x1) / 2) : "",
    Center_Y: placed ? Math.round((tag.bbox.y0 + tag.bbox.y1) / 2) : "",
    Width: placed ? Math.round(tag.bbox.x1 - tag.bbox.x0) : "",
    Height: placed ? Math.round(tag.bbox.y1 - tag.bbox.y0) : "",
    Updated_At: tag.updatedAt,
    Updated_By: tag.updatedBy,
  };
}

const LINE_COLUMNS = ["Line_Number", "Size", "Service", "Spec_Code", "From", "To", "Notes"] as const;

function lineRow(line: LineRecord): (string | number)[] {
  return [line.lineNumber, line.size, line.service, line.specCode, line.fromRef, line.toRef, line.notes];
}

const NOTE_COLUMNS = ["Flag", "Note"] as const;

const META_LABELS: [keyof DrawingMeta, string][] = [
  ["drawingNumber", "Drawing Number"],
  ["revision", "Revision"],
  ["title", "Title"],
  ["project", "Project"],
  ["client", "Client"],
  ["county", "County/Parish"],
  ["state", "State"],
  ["date", "Date"],
  ["matchLineRefs", "Match Line References"],
  ["sourceFileName", "Source File"],
];

/** The tag table as CSV text. Separate from the download so it can be tested. */
export function tagsToCsv(tags: Tag[]): string {
  const rows = tags.map(tagRow);
  return toCsv(
    COLUMNS,
    rows.map((row) => COLUMNS.map((col) => row[col])),
  );
}

export function exportTagsCsv(tags: Tag[], filename = "pid-tags.csv"): void {
  const blob = new Blob([tagsToCsv(tags)], { type: "text/csv;charset=utf-8" });
  saveAs(blob, filename);
}

export function exportLinesCsv(lines: LineRecord[], filename = "pid-lines.csv"): void {
  const csv = toCsv(LINE_COLUMNS, lines.map(lineRow));
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  saveAs(blob, filename);
}

/**
 * One workbook per drawing: the tag table plus the sheet-level data the
 * framework treats as part of the record — title-block metadata, line
 * numbers, and the hex note flags — so the export is the whole drawing,
 * not just its instruments.
 */
export function exportWorkbook(
  tags: Tag[],
  meta: DrawingMeta,
  lines: LineRecord[],
  notes: NoteRecord[],
  filename = "pid-tags.xlsx",
): void {
  const workbook = XLSX.utils.book_new();

  const tagSheet = XLSX.utils.json_to_sheet(tags.map(tagRow), { header: [...COLUMNS] });
  tagSheet["!cols"] = COLUMNS.map((col) => ({ wch: Math.max(col.length + 2, 12) }));
  XLSX.utils.book_append_sheet(workbook, tagSheet, "Tags");

  const metaSheet = XLSX.utils.aoa_to_sheet([
    ["Field", "Value"],
    ...META_LABELS.map(([key, label]) => [label, meta[key]]),
    ["Tag Count", tags.length],
    ["Confirmed", tags.filter((t) => t.state === "confirmed").length],
    ["Uncertain", tags.filter((t) => t.state === "uncertain").length],
    ["Illegible", tags.filter((t) => t.state === "illegible").length],
    ["Exported", new Date().toISOString()],
  ]);
  metaSheet["!cols"] = [{ wch: 24 }, { wch: 52 }];
  XLSX.utils.book_append_sheet(workbook, metaSheet, "Drawing");

  if (lines.length > 0) {
    const lineSheet = XLSX.utils.aoa_to_sheet([[...LINE_COLUMNS], ...lines.map(lineRow)]);
    lineSheet["!cols"] = LINE_COLUMNS.map((col) => ({ wch: Math.max(col.length + 2, 14) }));
    XLSX.utils.book_append_sheet(workbook, lineSheet, "Lines");
  }

  if (notes.length > 0) {
    const noteSheet = XLSX.utils.aoa_to_sheet([
      [...NOTE_COLUMNS],
      ...notes.map((n) => [n.flag, n.text]),
    ]);
    noteSheet["!cols"] = [{ wch: 12 }, { wch: 80 }];
    XLSX.utils.book_append_sheet(workbook, noteSheet, "Notes");
  }

  XLSX.writeFile(workbook, filename);
}

const STATE_COLORS: Record<Tag["state"], string> = {
  confirmed: "#16a34a",
  uncertain: "#f59e0b",
  illegible: "#dc2626",
};

/** Renders a page canvas with tag bounding boxes drawn on top and triggers a PNG download. */
export function exportAnnotatedPage(
  page: PageImage,
  tags: Tag[],
  filename = `pid-page-${page.pageNumber}-annotated.png`,
): void {
  const canvas = document.createElement("canvas");
  canvas.width = page.width;
  canvas.height = page.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.drawImage(page.canvas, 0, 0);

  for (const tag of tags) {
    const { x0, y0, x1, y1 } = tag.bbox;
    if (x1 <= x0 && y1 <= y0) continue;
    const color = STATE_COLORS[tag.state];
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    ctx.font = "12px sans-serif";
    ctx.fillStyle = color;
    ctx.fillText(tag.text, x0, Math.max(0, y0 - 4));
  }

  canvas.toBlob((blob) => {
    if (blob) saveAs(blob, filename);
  }, "image/png");
}
