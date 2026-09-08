import * as XLSX from "xlsx";
import { saveAs } from "file-saver";
import type { PageImage, Tag } from "../types";

const COLUMNS = [
  "Tag",
  "Function Code",
  "Loop Number",
  "Suffix",
  "Type",
  "Description",
  "Page",
  "Confidence %",
  "Verified",
  "Source",
] as const;

function tagRow(tag: Tag): Record<(typeof COLUMNS)[number], string | number> {
  return {
    Tag: tag.text,
    "Function Code": tag.functionCode,
    "Loop Number": tag.loopNumber,
    Suffix: tag.suffix,
    Type: tag.type,
    Description: tag.description,
    Page: tag.page,
    "Confidence %": Math.round(tag.confidence),
    Verified: tag.confirmed ? "Yes" : "No",
    Source: tag.source,
  };
}

function csvEscape(value: string | number): string {
  const str = String(value);
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

export function exportTagsCsv(tags: Tag[], filename = "pid-tags.csv"): void {
  const rows = tags.map(tagRow);
  const lines = [
    COLUMNS.join(","),
    ...rows.map((row) => COLUMNS.map((col) => csvEscape(row[col])).join(",")),
  ];
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  saveAs(blob, filename);
}

export function exportTagsXlsx(tags: Tag[], filename = "pid-tags.xlsx"): void {
  const rows = tags.map(tagRow);
  const worksheet = XLSX.utils.json_to_sheet(rows, { header: [...COLUMNS] });
  worksheet["!cols"] = COLUMNS.map((col) => ({ wch: Math.max(col.length + 2, 12) }));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Tags");
  XLSX.writeFile(workbook, filename);
}

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
    ctx.strokeStyle = tag.confirmed ? "#16a34a" : "#f59e0b";
    ctx.lineWidth = 2;
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    ctx.font = "12px sans-serif";
    ctx.fillStyle = tag.confirmed ? "#16a34a" : "#f59e0b";
    ctx.fillText(tag.text, x0, Math.max(0, y0 - 4));
  }

  canvas.toBlob((blob) => {
    if (blob) saveAs(blob, filename);
  }, "image/png");
}
