import { describe, expect, it } from "vitest";
import { correctionKind, reconcileTags, splitToken } from "./reconcile";
import type { Tag } from "../types";

/**
 * The scenario these tests encode is the real one from the validation
 * drawing: a cluster of four bubbles on loop 1321A sitting next to a
 * cluster on loop 1321, where OCR reads the trailing `A` of some 1321A
 * tags as a digit. The trap is that 1321 and 1321A are both real, so a
 * naive "snap to the most common value" makes things worse.
 */
function bubble(id: string, text: string, cx: number, cy: number): Tag {
  const m = /^([A-Z]+)-(\d+)([A-Z]*)$/.exec(text);
  return {
    id,
    text,
    functionCode: m?.[1] ?? "",
    loopNumber: m?.[2] ?? "",
    suffix: m?.[3] ?? "",
    description: "",
    type: "ISA Instrument Tag",
    page: 1,
    bbox: { x0: cx - 40, y0: cy - 30, x1: cx + 40, y1: cy + 30 },
    confidence: 80,
    state: "uncertain",
    source: "auto",
    patternName: "ISA Instrument Tag",
    origin: "bubble",
    isaFunction: "",
    loopGroup: "",
    lineOrEquipment: "",
    panel: "",
    size: "",
    failPosition: "",
    notes: "",
    continuesOn: "",
    updatedAt: "",
    updatedBy: "",
  };
}

const textOf = (tags: Tag[], id: string) => tags.find((t) => t.id === id)?.text;

describe("splitToken", () => {
  it("separates the digit stem from a trailing letter suffix", () => {
    expect(splitToken("1321A")).toEqual({ stem: "1321", suffix: "A" });
    expect(splitToken("1321")).toEqual({ stem: "1321", suffix: "" });
    expect(splitToken("13217")).toEqual({ stem: "13217", suffix: "" });
  });
});

describe("correctionKind", () => {
  it("never deletes a suffix letter, however well supported the target", () => {
    // The bug this guards: 1321A is a real loop, distinct from 1321.
    expect(correctionKind("1321A", "1321")).toBeNull();
  });

  it("recovers a suffix letter read as a trailing digit", () => {
    expect(correctionKind("13217", "1321A")).toBe("suffix-recovered");
    expect(correctionKind("13214", "1321A")).toBe("suffix-recovered");
  });

  it("will not invent a suffix that was never read", () => {
    // Nothing in "1378" suggests a trailing A; adding one is a guess.
    expect(correctionKind("1378", "1378A")).toBeNull();
  });

  it("swaps one confusable digit in the stem", () => {
    expect(correctionKind("1327", "1321")).toBe("stem-substitution");
    // 2 and 1 are not a confusable pair, so this is a different loop.
    expect(correctionKind("1329", "1321")).toBeNull();
  });

  it("restores a dropped digit while keeping the suffix", () => {
    expect(correctionKind("378A", "1378A")).toBe("stem-insertion");
  });

  it("rejects changes of more than one character", () => {
    expect(correctionKind("1234", "5678")).toBeNull();
    expect(correctionKind("13", "1321")).toBeNull();
  });
});

describe("reconcileTags", () => {
  // Four bubbles on 1321A; three of them misread the trailing A.
  const cluster = [
    bubble("a", "AOV-1321A", 3576, 2169),
    bubble("b", "SVO-13217", 3306, 2160),
    bubble("c", "ZSC-13217", 3417, 2160),
    bubble("d", "ZSO-13214", 3417, 2067),
    // A genuinely different loop nearby, which must survive untouched.
    bubble("e", "SVO-1321", 3306, 2766),
    bubble("f", "ZSC-1321", 3417, 2769),
    bubble("g", "AOV-1321", 3576, 2778),
    bubble("h", "PDIT-1321", 3825, 2010),
  ];

  it("recovers the misread suffix from the neighbours that read it correctly", () => {
    const { tags, corrections } = reconcileTags(cluster);
    expect(textOf(tags, "b")).toBe("SVO-1321A");
    expect(textOf(tags, "c")).toBe("ZSC-1321A");
    expect(textOf(tags, "d")).toBe("ZSO-1321A");
    expect(corrections).toHaveLength(3);
  });

  it("leaves the correctly-read tags of both loops alone", () => {
    const { tags } = reconcileTags(cluster);
    for (const id of ["a", "e", "f", "g", "h"]) {
      expect(textOf(tags, id)).toBe(cluster.find((t) => t.id === id)!.text);
    }
  });

  it("keeps a correction in the review queue and records what it was read as", () => {
    const { tags } = reconcileTags(cluster);
    const corrected = tags.find((t) => t.id === "b")!;
    // A suggestion, not a verified reading.
    expect(corrected.state).toBe("uncertain");
    expect(corrected.notes).toContain("13217");
    expect(corrected.notes).toContain("1321A");
  });

  it("fixes a function code that is one confusable character off a real one", () => {
    const tags = [
      bubble("x", "AQV-1321", 3576, 2778),
      ...cluster.slice(4),
    ];
    const { tags: out } = reconcileTags(tags);
    expect(textOf(out, "x")).toBe("AOV-1321");
  });

  it("leaves an ambiguous function code alone rather than picking one", () => {
    // "A" is one character away from AT, AE, AI, AY... — no basis to choose.
    const { tags } = reconcileTags([bubble("y", "A-1378", 3813, 1551), ...cluster.slice(4)]);
    expect(textOf(tags, "y")).toBe("A-1378");
  });

  it("ignores page text and anything already confirmed", () => {
    const confirmed: Tag = { ...bubble("z", "SVO-13217", 3306, 2160), state: "confirmed" };
    const pageText: Tag = { ...bubble("p", "SVO-13217", 3306, 2160), origin: "page" };
    const { tags } = reconcileTags([confirmed, pageText, ...cluster]);
    expect(textOf(tags, "z")).toBe("SVO-13217");
    expect(textOf(tags, "p")).toBe("SVO-13217");
  });

  it("does not correct across the sheet from an unrelated cluster", () => {
    const far = [
      bubble("far", "ZSO-13217", 200, 200),
      ...cluster.slice(0, 1),
      ...cluster.slice(4),
    ];
    const { tags } = reconcileTags(far);
    expect(textOf(tags, "far")).toBe("ZSO-13217");
  });
});
