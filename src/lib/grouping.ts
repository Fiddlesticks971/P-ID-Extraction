import type { Bbox, OcrWord, Tag, TagPattern } from "../types";
import { compilePattern } from "./tagPatterns";

/** Minimum fraction of the candidate text a pattern match must cover to be accepted. */
const MATCH_COVERAGE_THRESHOLD = 0.7;
/** Two candidate boxes on the same page with IoU above this are treated as duplicates. */
const DEDUP_IOU_THRESHOLD = 0.4;

interface Candidate {
  text: string;
  bbox: Bbox;
  confidence: number;
  page: number;
  patternId: string;
  patternName: string;
  func: string;
  loop: string;
  suffix: string;
}

function unionBbox(a: Bbox, b: Bbox): Bbox {
  return {
    x0: Math.min(a.x0, b.x0),
    y0: Math.min(a.y0, b.y0),
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
  };
}

function bboxArea(b: Bbox): number {
  return Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);
}

function iou(a: Bbox, b: Bbox): number {
  const x0 = Math.max(a.x0, b.x0);
  const y0 = Math.max(a.y0, b.y0);
  const x1 = Math.min(a.x1, b.x1);
  const y1 = Math.min(a.y1, b.y1);
  const intersection = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  if (intersection <= 0) return 0;
  const union = bboxArea(a) + bboxArea(b) - intersection;
  return union > 0 ? intersection / union : 0;
}

function tryMatch(
  text: string,
  bbox: Bbox,
  confidence: number,
  page: number,
  patterns: TagPattern[],
): Candidate | null {
  const normalized = text.toUpperCase();
  let best: Candidate | null = null;

  for (const pattern of patterns) {
    if (!pattern.enabled) continue;
    const regex = compilePattern(pattern);
    if (!regex) continue;
    regex.lastIndex = 0;
    const match = regex.exec(normalized);
    if (!match) continue;
    const coverage = match[0].length / normalized.length;
    if (coverage < MATCH_COVERAGE_THRESHOLD) continue;

    const groups = match.groups ?? {};
    const candidate: Candidate = {
      text: match[0],
      bbox,
      confidence,
      page,
      patternId: pattern.id,
      patternName: pattern.name,
      func: groups.func ?? "",
      loop: groups.loop ?? "",
      suffix: groups.suffix ?? "",
    };
    if (!best || match[0].length > best.text.length) {
      best = candidate;
    }
  }

  return best;
}

/** Buckets words by horizontal position so stacked-text search stays roughly linear. */
function bucketByX(words: OcrWord[], bucketWidth: number): Map<number, OcrWord[]> {
  const buckets = new Map<number, OcrWord[]>();
  for (const word of words) {
    const centerX = (word.bbox.x0 + word.bbox.x1) / 2;
    const key = Math.floor(centerX / bucketWidth);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(word);
  }
  return buckets;
}

/**
 * Finds tag candidates from OCR words: first tries to match each word alone
 * (handles single-line tags like "PT-101A"), then tries merging vertically
 * stacked word pairs (handles bubble tags drawn as two lines, e.g. "FT" over
 * "205"). Overlapping duplicate candidates on the same page are resolved by
 * keeping the longest/highest-confidence match.
 */
export function extractTagCandidates(
  words: OcrWord[],
  patterns: TagPattern[],
  stackGapFactor: number,
): Candidate[] {
  const candidates: Candidate[] = [];

  // Single-word matches.
  for (const word of words) {
    const match = tryMatch(word.text, word.bbox, word.confidence, word.page, patterns);
    if (match) candidates.push(match);
  }

  // Stacked-pair matches, grouped by page then bucketed by x-position.
  const pages = new Map<number, OcrWord[]>();
  for (const word of words) {
    if (!pages.has(word.page)) pages.set(word.page, []);
    pages.get(word.page)!.push(word);
  }

  for (const [page, pageWords] of pages) {
    const buckets = bucketByX(pageWords, 80);
    for (const [key, bucketWords] of buckets) {
      const neighbors = [
        ...bucketWords,
        ...(buckets.get(key - 1) ?? []),
        ...(buckets.get(key + 1) ?? []),
      ];
      for (const top of bucketWords) {
        const topHeight = top.bbox.y1 - top.bbox.y0;
        const maxGap = topHeight * stackGapFactor;
        for (const bottom of neighbors) {
          if (bottom === top) continue;
          const gap = bottom.bbox.y0 - top.bbox.y1;
          if (gap < -2 || gap > maxGap) continue;
          const overlapX =
            Math.min(top.bbox.x1, bottom.bbox.x1) - Math.max(top.bbox.x0, bottom.bbox.x0);
          const minWidth = Math.min(
            top.bbox.x1 - top.bbox.x0,
            bottom.bbox.x1 - bottom.bbox.x0,
          );
          if (minWidth <= 0 || overlapX / minWidth < 0.3) continue;

          const bbox = unionBbox(top.bbox, bottom.bbox);
          const confidence = Math.min(top.confidence, bottom.confidence);
          for (const combined of [
            `${top.text}-${bottom.text}`,
            `${top.text}${bottom.text}`,
          ]) {
            const match = tryMatch(combined, bbox, confidence, page, patterns);
            if (match) candidates.push(match);
          }
        }
      }
    }
  }

  return dedupeCandidates(candidates);
}

function dedupeCandidates(candidates: Candidate[]): Candidate[] {
  const sorted = [...candidates].sort((a, b) => {
    if (b.text.length !== a.text.length) return b.text.length - a.text.length;
    return b.confidence - a.confidence;
  });

  const accepted: Candidate[] = [];
  for (const candidate of sorted) {
    const overlapsAccepted = accepted.some(
      (existing) =>
        existing.page === candidate.page && iou(existing.bbox, candidate.bbox) > DEDUP_IOU_THRESHOLD,
    );
    if (!overlapsAccepted) accepted.push(candidate);
  }

  return accepted;
}

let tagCounter = 0;
function nextTagId(): string {
  tagCounter += 1;
  return `tag-${Date.now()}-${tagCounter}`;
}

export function candidatesToTags(candidates: Candidate[]): Tag[] {
  return candidates
    .sort((a, b) => a.page - b.page || a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0)
    .map((c) => ({
      id: nextTagId(),
      text: c.text,
      functionCode: c.func,
      loopNumber: c.loop,
      suffix: c.suffix,
      description: "",
      type: c.patternName,
      page: c.page,
      bbox: c.bbox,
      confidence: c.confidence,
      confirmed: false,
      source: "auto" as const,
      patternName: c.patternName,
    }));
}
