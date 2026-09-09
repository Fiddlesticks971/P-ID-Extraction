import type { TagPattern } from "../types";

/**
 * Default tag patterns based on ISA 5.1 instrumentation tag conventions plus
 * common equipment and pipe line numbering schemes seen on P&IDs. Users can
 * edit, disable, or add their own patterns from the Settings panel to match
 * project-specific tagging standards.
 *
 * Each pattern should use named capture groups `func`, `loop`, and `suffix`
 * where possible so extracted tags can be split into columns. Patterns
 * without named groups still work; the whole match is used as the tag text.
 *
 * Note the `(?<![A-Z0-9-])` / `(?![A-Z0-9-])` guards on the instrument and
 * equipment patterns. Without them a tag pattern happily matches *inside* a
 * longer token, and on a real P&ID that is the dominant source of false
 * positives: `8"-G-0331-8E1550` yields "E1550", `03-BD-0038` yields
 * "BD-0038", `4"-BD-0334-8E1550` yields both. A `\b` is not enough — there
 * is no word boundary between the `8` and the `E` of a spec code. Requiring
 * that the match not be flanked by another tag character means a candidate
 * has to stand on its own.
 */
export const DEFAULT_PATTERNS: TagPattern[] = [
  {
    id: "isa-instrument",
    name: "ISA Instrument Tag",
    pattern: String.raw`(?<![A-Z0-9-])(?<func>[A-Z]{1,5})-?(?<loop>\d{2,5})(?<suffix>[A-Z]{1,2})?(?![A-Z0-9-])`,
    enabled: true,
    description:
      'Instrument bubble tags such as "PT-101", "FIC 205A", "LSH-4102". Matches 1-5 letter function code + 2-5 digit loop number + optional suffix letter(s).',
  },
  {
    id: "equipment",
    name: "Equipment Tag",
    pattern: String.raw`(?<![A-Z0-9-])(?<func>[A-Z]{1,4})-(?<loop>\d{2,4})(?<suffix>[A-Z]{0,2})(?![A-Z0-9-])`,
    enabled: true,
    description:
      'Equipment tags such as "P-101A" (pump), "V-201" (vessel), "TK-301" (tank), "E-401B" (exchanger).',
  },
  {
    id: "line-number",
    name: "Pipe Line Number",
    pattern: String.raw`\d{1,2}"?-(?<func>[A-Z]{1,6})-(?<loop>\d{3,6})(?:-(?<suffix>[A-Za-z0-9]{1,4}))?`,
    enabled: false,
    description:
      'Pipe line numbers such as "6"-P-10234-A1A" or "4-CS-101-B". Disabled by default since it can overlap with equipment tags.',
  },
];

export const FUNCTION_LETTER_MEANINGS: Record<string, string> = {
  A: "Analysis",
  B: "Burner/Combustion",
  C: "Conductivity/Control",
  D: "Density",
  E: "Voltage/Element",
  F: "Flow",
  G: "Gauging",
  H: "Hand",
  I: "Current/Indicate",
  J: "Power",
  K: "Time/Schedule",
  L: "Level",
  M: "Moisture",
  N: "User's Choice",
  O: "Orifice",
  P: "Pressure",
  Q: "Quantity",
  R: "Radiation/Record",
  S: "Speed/Switch",
  T: "Temperature/Transmit",
  U: "Multivariable",
  V: "Vibration/Valve",
  W: "Weight/Well",
  X: "Unclassified",
  Y: "Event/Relay",
  Z: "Position/Driver",
};

/** Best-effort human-readable hint for a function-code prefix, e.g. "PT" -> "Pressure + Transmit". */
export function describeFunctionCode(func: string): string {
  const letters = func.toUpperCase().split("");
  const parts = letters
    .map((l) => FUNCTION_LETTER_MEANINGS[l])
    .filter((v): v is string => Boolean(v));
  return parts.length ? parts.join(" + ") : "";
}

export function compilePattern(pattern: TagPattern): RegExp | null {
  try {
    return new RegExp(pattern.pattern, "g");
  } catch {
    return null;
  }
}
