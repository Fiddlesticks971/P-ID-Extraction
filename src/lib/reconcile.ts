import type { Tag } from "../types";

/**
 * Cross-checks each bubble reading against the rest of the sheet.
 *
 * A P&ID is highly redundant in a way a single OCR read cannot exploit: a
 * loop number is shared by every device in the loop, and those devices are
 * drawn next to each other. On the validation drawing, loop 1321A appears
 * on four adjacent bubbles and 1319 on six. So when one bubble reads
 * `13217` and three neighbours within a few bubble-widths read `1321A`,
 * the odd one out is far more likely to be a misread `A` than a real
 * five-digit loop.
 *
 * The same trick fixes function codes against a dictionary of the codes
 * that actually appear on P&IDs: `AQV` is not a function code anyone uses,
 * and it is one confusable character away from `AOV`.
 *
 * Corrections are **suggestions, not assertions**. The tag keeps its
 * `uncertain` state, the original reading is preserved in the notes, and
 * the reviewer sees exactly what was changed and why. Nothing here invents
 * a reading that no OCR pass produced.
 */

/** Function codes that appear on real P&IDs — ISA 5.1 combinations plus common valve abbreviations. */
const KNOWN_FUNCTION_CODES = new Set([
  // Actuated valves and their accessories — the bubble-heavy population.
  "AOV", "BDV", "MOV", "SDV", "XV", "FCV", "PCV", "TCV", "LCV", "HCV", "PSV", "RO",
  "SV", "SVO", "SVC", "ZSO", "ZSC", "ZS", "ZT", "ZI", "ZY",
  // Transmitters / indicators / elements.
  "PT", "PIT", "PDT", "PDIT", "PI", "PG", "PSH", "PSL", "PSHH", "PSLL",
  "TT", "TIT", "TE", "TW", "TI", "TSH", "TSL",
  "FT", "FIT", "FE", "FI", "FQ", "FQI", "FY", "FS",
  "LT", "LIT", "LE", "LI", "LSH", "LSL", "LSHH", "LSLL", "LG",
  "AT", "AIT", "AE", "AI",
  "VT", "VE", "VI", "ST", "SE", "SI",
  // Controllers, relays, panels, and hand switches.
  "FIC", "PIC", "TIC", "LIC", "FFIC", "UIC",
  "PY", "TY", "LY", "AY", "ZY", "UY", "KY",
  "HS", "HV", "XY", "XA", "UA", "KQI",
]);

/** Character pairs OCR routinely swaps on CAD lettering, in both directions. */
const CONFUSABLE: [string, string][] = [
  ["O", "0"], ["O", "Q"], ["O", "D"], ["Q", "0"],
  ["I", "1"], ["I", "L"], ["1", "7"], ["1", "T"],
  ["S", "5"], ["B", "8"], ["Z", "2"], ["G", "6"],
  ["A", "4"], ["A", "7"], ["U", "V"], ["C", "G"],
  ["E", "F"], ["9", "3"], ["6", "5"],
];

const CONFUSABLE_SET = new Set(
  CONFUSABLE.flatMap(([a, b]) => [`${a}${b}`, `${b}${a}`]),
);

function isConfusable(a: string, b: string): boolean {
  return a === b || CONFUSABLE_SET.has(`${a}${b}`);
}

/**
 * The letters a digit is routinely misread as. Used to recover a suffix
 * that *no* bubble on the sheet read correctly: on the validation drawing
 * the trailing `A` of loop 1321A came out as `7` on all three bubbles that
 * carry it and as `4` on the fourth, so there was never a correct reading
 * to copy from.
 *
 * This only ever fires when the answer is unique. `7` and `4` are each
 * confusable with exactly one letter (`A`), so the inference is
 * determined; `0` (O or Q) and `1` (I or T) are ambiguous and are left
 * alone rather than guessed between.
 */
function lettersConfusableWith(digit: string): string[] {
  const letters = new Set<string>();
  for (const [a, b] of CONFUSABLE) {
    if (a === digit && /[A-Z]/.test(b)) letters.add(b);
    if (b === digit && /[A-Z]/.test(a)) letters.add(a);
  }
  return [...letters];
}

/** Splits a loop token into its digit stem and trailing letter suffix. */
export function splitToken(token: string): { stem: string; suffix: string } {
  const m = /^(\d*)([A-Z]*)$/.exec(token);
  return { stem: m?.[1] ?? token, suffix: m?.[2] ?? "" };
}

/** One confusable substitution between two equal-length strings. */
function oneSubstitution(a: string, b: string): boolean {
  if (a.length !== b.length || a === b) return false;
  let diffs = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    if (++diffs > 1 || !isConfusable(a[i], b[i])) return false;
  }
  return diffs === 1;
}

/** One character inserted into `short` gives `long` (characters otherwise identical). */
function oneInsertion(short: string, long: string): boolean {
  if (long.length - short.length !== 1) return false;
  let i = 0, j = 0, skipped = false;
  while (i < short.length && j < long.length) {
    if (short[i] === long[j]) { i++; j++; continue; }
    if (skipped) return false;
    skipped = true;
    j++;
  }
  return true;
}

/**
 * Whether a reading can be corrected to a candidate, and why.
 *
 * The structure of a loop token is load-bearing here. `1321` and `1321A`
 * are two *different* loops that both exist on the validation drawing, so
 * an unconstrained edit distance is actively harmful: it "fixes" a
 * correctly-read `1321A` into the better-supported `1321` and destroys a
 * good reading. A trailing letter is information, and this never deletes
 * one.
 *
 * What it does allow:
 *  - a confusable digit swap within the stem (`1327` -> `1321`);
 *  - a trailing digit that should have been the suffix letter
 *    (`13217` -> `1321A`, where `7` is a confusable for `A`) — but only
 *    when a tag somewhere on the sheet actually reads `1321A`, so the
 *    suffix is observed rather than invented;
 *  - a dropped digit inside the stem (`378A` -> `1378A`), suffix intact;
 *  - a confusable swap of the suffix letter itself, stem unchanged.
 */
export type CorrectionKind =
  | "stem-substitution"
  | "suffix-recovered"
  | "stem-insertion"
  | "suffix-substitution"
  /** A suffix letter inferred from a trailing digit that no bubble read correctly. */
  | "suffix-inferred";

export function correctionKind(from: string, to: string): CorrectionKind | null {
  if (from === to) return null;
  const a = splitToken(from);
  const b = splitToken(to);

  // Never drop a suffix letter: 1321A -> 1321 is a loss, not a fix.
  if (a.suffix && !b.suffix) return null;

  if (a.suffix === b.suffix) {
    if (oneSubstitution(a.stem, b.stem)) return "stem-substitution";
    if (oneInsertion(a.stem, b.stem)) return "stem-insertion";
    return null;
  }

  // A trailing digit misread for the suffix letter.
  if (!a.suffix && b.suffix.length === 1 && a.stem.length === b.stem.length + 1) {
    const dropped = a.stem[a.stem.length - 1];
    if (a.stem.slice(0, -1) === b.stem && isConfusable(dropped, b.suffix)) {
      return "suffix-recovered";
    }
    return null;
  }

  // Same stem, confusable suffix letter.
  if (a.suffix && b.suffix && a.stem === b.stem && oneSubstitution(a.suffix, b.suffix)) {
    return "suffix-substitution";
  }
  return null;
}

/** Kept for the function-code dictionary, where plain closeness is the right test. */
export function isOneConfusableEdit(a: string, b: string): boolean {
  if (a === b) return false;
  if (a.length === b.length) return oneSubstitution(a, b);
  if (Math.abs(a.length - b.length) !== 1) return false;
  return a.length < b.length ? oneInsertion(a, b) : oneInsertion(b, a);
}

export interface ReconcileOptions {
  /**
   * How far apart two bubbles can be and still count as the same cluster,
   * in page-raster pixels. Devices on one valve assembly sit within a few
   * bubble diameters of each other.
   */
  clusterRadius: number;
  /** A reading with support at or below this is a correction candidate. */
  weakSupport: number;
  /** The replacement must have at least this many more supporting reads. */
  supportMargin: number;
}

export const DEFAULT_RECONCILE: ReconcileOptions = {
  clusterRadius: 900,
  weakSupport: 2,
  supportMargin: 2,
};

export interface Correction {
  tagId: string;
  field: "loop" | "func";
  from: string;
  to: string;
  reason: string;
}

/** The stem of a token, for the inferred-suffix explanation. */
function trimmedNote(token: string): string {
  return token.slice(0, -1);
}

function centerOf(tag: Tag): [number, number] {
  return [(tag.bbox.x0 + tag.bbox.x1) / 2, (tag.bbox.y0 + tag.bbox.y1) / 2];
}

function loopToken(tag: Tag): string {
  return `${tag.loopNumber}${tag.suffix}`;
}

function rebuildText(func: string, loop: string, suffix: string): string {
  // A placeholder for an unreadable bubble has no function code; keep its
  // "?-1321A" shape rather than emitting a tag that starts with a dash.
  if (!loop) return func;
  return `${func || "?"}-${loop}${suffix}`;
}

/**
 * Returns a corrected copy of the tag list plus the list of what changed.
 * Only bubble-sourced, auto-extracted tags are considered — page text is
 * too heterogeneous for consensus to mean anything, and anything a person
 * has already touched is left alone.
 */
export function reconcileTags(
  tags: Tag[],
  options: ReconcileOptions = DEFAULT_RECONCILE,
): { tags: Tag[]; corrections: Correction[] } {
  const subjects = tags.filter(
    (t) => t.origin === "bubble" && t.source === "auto" && t.state !== "confirmed",
  );
  if (subjects.length < 3) return { tags, corrections: [] };

  const loopSupport = new Map<string, number>();
  /** Support for the digit stem alone, pooling 1321 and 1321A. */
  const stemSupport = new Map<string, number>();
  const stemLengths = new Map<number, Set<string>>();
  for (const tag of subjects) {
    const token = loopToken(tag);
    if (!token) continue;
    loopSupport.set(token, (loopSupport.get(token) ?? 0) + 1);
    const { stem } = splitToken(token);
    if (!stem) continue;
    stemSupport.set(stem, (stemSupport.get(stem) ?? 0) + 1);
  }
  // Work out the sheet's own loop-number length, counting *distinct* stems
  // rather than tags, and ignoring stems that are one character longer than
  // another stem already present. Those are derivative: "13217" alongside
  // "1321" is far more likely to be 1321 with a misread suffix than an
  // independent five-digit loop, and counting it as evidence lets the very
  // error this pass exists to fix redefine the convention and protect
  // itself. On the validation drawing the trailing A came out as both "7"
  // and "4", so even counting distinct stems was not enough on its own.
  for (const stem of stemSupport.keys()) {
    if (stem.length > 1 && stemSupport.has(stem.slice(0, -1))) continue;
    const byLength = stemLengths.get(stem.length) ?? new Set<string>();
    byLength.add(stem);
    stemLengths.set(stem.length, byLength);
  }

  // How long a loop number is on *this* sheet. A token that disagrees with
  // the sheet's own convention is structurally suspect on its own, before
  // any comparison — which is why it needs less corroboration to correct.
  let modalStemLength = 0;
  let modalCount = 0;
  for (const [length, stems] of stemLengths) {
    // Ties go to the shorter length: the misreads this pass exists to fix
    // append a character (a suffix letter read as a digit), so the longer
    // candidate is the suspect one.
    if (stems.size > modalCount || (stems.size === modalCount && length < modalStemLength)) {
      modalCount = stems.size;
      modalStemLength = length;
    }
  }

  const corrections: Correction[] = [];
  const patched = new Map<string, Tag>();

  for (const tag of subjects) {
    let func = tag.functionCode;
    let loop = tag.loopNumber;
    let suffix = tag.suffix;
    let changed = false;
    const notes: string[] = [];

    // --- Loop number, by cluster consensus ---
    const token = loopToken(tag);
    const own = loopSupport.get(token) ?? 0;
    const ownSplit = splitToken(token);
    const ownStem = ownSplit.stem;
    const lengthAnomaly = ownStem.length > 0 && ownStem.length !== modalStemLength;
    // A token that already matches the sheet's convention and is echoed by
    // other bubbles needs no help. But repetition is only evidence when the
    // token is structurally plausible: OCR misreads the same glyph the same
    // way every time, so three bubbles all reading "13217" on a sheet whose
    // loops are four digits is three instances of one systematic error, not
    // corroboration. A length anomaly therefore overrides the support gate.
    if (token && (own <= options.weakSupport || lengthAnomaly)) {
      const [cx, cy] = centerOf(tag);
      const margin = lengthAnomaly ? 1 : options.supportMargin;
      let best: { token: string; support: number; distance: number; kind: CorrectionKind } | null = null;

      for (const [candidate, support] of loopSupport) {
        const kind = correctionKind(token, candidate);
        if (!kind) continue;
        // Pool the evidence for the target's stem: 1321 read four times is
        // support for the stem behind 1321A too.
        const evidence = stemSupport.get(splitToken(candidate).stem) ?? support;
        if (evidence < own + margin) continue;

        // Require a supporting read physically nearby: a loop number from
        // the far side of the sheet is not evidence about this bubble.
        let nearest = Infinity;
        for (const other of subjects) {
          if (loopToken(other) !== candidate) continue;
          const [ox, oy] = centerOf(other);
          nearest = Math.min(nearest, Math.hypot(ox - cx, oy - cy));
        }
        if (nearest > options.clusterRadius) continue;

        if (!best || evidence > best.support || (evidence === best.support && nearest < best.distance)) {
          best = { token: candidate, support: evidence, distance: nearest, kind };
        }
      }

      // Nothing on the sheet reads the suffix correctly? Infer it, but only
      // when the shape of the token forces a single answer: an all-digit
      // token exactly one longer than the sheet's own loop length, whose
      // leading digits are a well-supported stem, ending in a digit that is
      // confusable with exactly one letter.
      if (!best && !ownSplit.suffix && ownStem.length === modalStemLength + 1) {
        const trimmed = ownStem.slice(0, -1);
        const dropped = ownStem[ownStem.length - 1];
        const letters = lettersConfusableWith(dropped);
        const stemEvidence = stemSupport.get(trimmed) ?? 0;
        if (letters.length === 1 && stemEvidence >= options.supportMargin) {
          const [cx2, cy2] = centerOf(tag);
          let nearest = Infinity;
          for (const other of subjects) {
            if (splitToken(loopToken(other)).stem !== trimmed) continue;
            const [ox, oy] = centerOf(other);
            nearest = Math.min(nearest, Math.hypot(ox - cx2, oy - cy2));
          }
          if (nearest <= options.clusterRadius) {
            best = {
              token: `${trimmed}${letters[0]}`,
              support: stemEvidence,
              distance: nearest,
              kind: "suffix-inferred",
            };
          }
        }
      }

      if (best) {
        const split = splitToken(best.token);
        notes.push(
          best.kind === "suffix-inferred"
            ? `Loop read as "${token}". No bubble on this sheet read the suffix, but "${trimmedNote(token)}" is a ${best.support}-bubble loop here and a trailing "${token[token.length - 1]}" is a common misread of "${best.token[best.token.length - 1]}". Check this one against the drawing.`
            : `Loop read as "${token}"; corrected to "${best.token}" (${best.support} nearby bubbles on this loop). Verify against the drawing.`,
        );
        corrections.push({
          tagId: tag.id,
          field: "loop",
          from: token,
          to: best.token,
          reason: `${best.kind}, ${best.support} nearby bubbles agree`,
        });
        loop = split.stem;
        suffix = split.suffix;
        changed = true;
      }
    }

    // --- Function code, against the dictionary of codes P&IDs actually use ---
    if (func && !KNOWN_FUNCTION_CODES.has(func)) {
      const matches = [...KNOWN_FUNCTION_CODES].filter((known) =>
        isOneConfusableEdit(func, known),
      );
      // Only act when the answer is unambiguous.
      if (matches.length === 1) {
        notes.push(`Function code read as "${func}"; "${matches[0]}" is the only known code one character away.`);
        corrections.push({
          tagId: tag.id,
          field: "func",
          from: func,
          to: matches[0],
          reason: "nearest known function code",
        });
        func = matches[0];
        changed = true;
      }
    }

    if (!changed) continue;
    patched.set(tag.id, {
      ...tag,
      functionCode: func,
      loopNumber: loop,
      suffix,
      text: rebuildText(func, loop, suffix),
      loopGroup: loop ? `${loop}${suffix}` : tag.loopGroup,
      // A suggestion, not a verified reading: it stays in the review queue
      // and carries what it was changed from. A bubble whose tag could not
      // be read stays "illegible" — a better guess at its loop number does
      // not make it read.
      state: tag.state === "illegible" ? "illegible" : "uncertain",
      notes: [tag.notes, ...notes].filter(Boolean).join(" "),
    });
  }

  if (patched.size === 0) return { tags, corrections: [] };
  return { tags: tags.map((t) => patched.get(t.id) ?? t), corrections };
}
