/**
 * Minimal RFC 4180 CSV reader/writer.
 *
 * The seed files this app ingests are hand-maintained engineering data and
 * routinely contain quoted fields with embedded commas, doubled quotes (a
 * bore size written as `""XX""`), and stray CRLFs — so splitting on commas
 * is not good enough. Written by hand rather than pulled in as a dependency
 * because the whole job is ~60 lines and the app already carries `xlsx`
 * only as a writer.
 */

/**
 * Splits CSV text into rows of raw string cells. Blank trailing lines are
 * dropped.
 *
 * Deliberately lenient about the double-quote character, because on a P&ID
 * it is a unit: pipe and valve sizes are written `8"`, `20"x10"`,
 * `XX"-BD-XXXX-3D4`. A hand- or AI-written seed list puts those in
 * unquoted fields without escaping them, which strict RFC 4180 parsing
 * reads as the start of a quoted field and then swallows the rest of the
 * file into one cell. So a quote only opens a quoted field at the start of
 * a field; anywhere else it is a literal inch mark.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  /** True until the first character of the current field is consumed. */
  let atFieldStart = true;
  // Strip a UTF-8 BOM; Excel writes one and it would otherwise corrupt the
  // first header name.
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];

    if (inQuotes) {
      if (ch === '"') {
        const next = src[i + 1];
        if (next === '"') {
          field += '"';
          i++;
        } else if (next === undefined || next === "," || next === "\n" || next === "\r") {
          inQuotes = false;
        } else {
          // A lone quote mid-field in an otherwise quoted cell — another
          // unescaped inch mark, e.g. "8" bore, TBD". Keep it as text
          // rather than ending the field early.
          field += '"';
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"' && atFieldStart) {
      inQuotes = true;
      atFieldStart = false;
    } else if (ch === ",") {
      row.push(field);
      field = "";
      atFieldStart = true;
    } else if (ch === "\n" || ch === "\r") {
      // Treat CRLF as one terminator.
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      atFieldStart = true;
    } else {
      field += ch;
      atFieldStart = false;
    }
  }

  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

export function csvEscape(value: string | number): string {
  const str = String(value);
  if (/[",\r\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

export function toCsv(header: readonly string[], rows: (string | number)[][]): string {
  return [header.map(csvEscape).join(","), ...rows.map((r) => r.map(csvEscape).join(","))].join(
    "\n",
  );
}

/**
 * Normalizes a header cell so lookups tolerate the spelling differences
 * between a hand-written seed file and this app's own export
 * ("Loop_Group", "Loop Group", "loop group" all match).
 */
export function normalizeHeader(header: string): string {
  return header.trim().toLowerCase().replace(/[\s_-]+/g, "");
}

/** Turns parsed rows into objects keyed by normalized header name. */
export function rowsToObjects(rows: string[][]): Record<string, string>[] {
  if (rows.length === 0) return [];
  const header = rows[0].map(normalizeHeader);
  return rows.slice(1).map((cells) => {
    const obj: Record<string, string> = {};
    for (let i = 0; i < header.length; i++) {
      if (!header[i]) continue;
      obj[header[i]] = (cells[i] ?? "").trim();
    }
    return obj;
  });
}
