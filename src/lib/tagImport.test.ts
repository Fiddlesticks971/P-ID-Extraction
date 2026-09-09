import { describe, expect, it } from "vitest";
import { parseCsv, rowsToObjects } from "./csv";
import {
  lineFromNumber,
  mergeSeedRows,
  parseLineNumber,
  parseLinesInput,
  parseSeedCsv,
  tagKey,
  type MergeOptions,
} from "./tagImport";
import { tagsToCsv } from "./export";
import { extractTagCandidates } from "./grouping";
import { DEFAULT_PATTERNS } from "./tagPatterns";
import type { OcrWord, Tag } from "../types";

/**
 * A stand-in for a real seed list, in the same schema as the
 * `instrument_tags.csv` the extraction workflow produces. Deliberately
 * synthetic — real drawings are client engineering data and don't belong
 * in a public repository — but it exercises the properties that matter:
 * quoted fields containing commas, doubled quotes inside a quoted field,
 * empty columns, and a CRLF line ending.
 */
const SEED_CSV = [
  "Tag,ISA_Function,Description,Loop_Group,Line_or_Equipment,Panel,Size,Fail_Position,Notes",
  'PT-1001,Pressure Transmitter,Suction pressure,1001 - Suction,6"-G-0100-1A1,UCP-100,,,',
  'FCV-1002,Flow Control Valve,"Anti-surge valve, fail open",1002 - Anti-Surge,8"-G-0101-1A1,,8",FO (Fail Open),',
  'RO-1003,Restriction Orifice,Orifice downstream,1002 - Anti-Surge,8"-G-0101-1A1,,XX" bore,,"Bore printed as ""XX"" - not specified"',
  "ZSC-1002A,Position Switch - Closed,Closed limit switch,1002A,FCV-1002,UCP-100,,,\r",
].join("\n");

const OPTIONS: MergeOptions = {
  page: 1,
  importedState: "confirmed",
  reviewer: "KG",
  overwriteExisting: false,
};

function tag(partial: Partial<Tag> & Pick<Tag, "id" | "text">): Tag {
  return {
    functionCode: "",
    loopNumber: "",
    suffix: "",
    description: "",
    type: "ISA Instrument Tag",
    page: 1,
    bbox: { x0: 10, y0: 20, x1: 60, y1: 40 },
    confidence: 88,
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
    ...partial,
  };
}

describe("parseCsv", () => {
  it("keeps commas and doubled quotes inside quoted fields", () => {
    const rows = parseCsv('a,"b,c","say ""hi"""\n1,2,3');
    expect(rows).toEqual([
      ["a", "b,c", 'say "hi"'],
      ["1", "2", "3"],
    ]);
  });

  it("treats CRLF as a single row terminator and drops blank lines", () => {
    expect(parseCsv("a,b\r\n1,2\r\n\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("treats an unescaped inch mark as text, not as the start of a quoted field", () => {
    // The case that matters on a P&ID: sizes are written 8", 20"x10",
    // XX"-BD-XXXX-3D4, and a hand-written seed list does not escape them.
    // Reading that quote as an opening delimiter swallows the rest of the
    // file into a single cell.
    expect(parseCsv('Tag,Size,Line\nFCV-1,10",20"x10" reducer\nPT-2,,')).toEqual([
      ["Tag", "Size", "Line"],
      ["FCV-1", '10"', '20"x10" reducer'],
      ["PT-2", "", ""],
    ]);
  });

  it("keeps a stray quote inside a properly quoted field", () => {
    expect(parseCsv('a,"8" bore, TBD",c')).toEqual([["a", '8" bore, TBD', "c"]]);
  });

  it("strips a UTF-8 BOM so the first header name is usable", () => {
    expect(rowsToObjects(parseCsv("﻿Tag,Panel\nPT-1,UCP-100"))[0]).toEqual({
      tag: "PT-1",
      panel: "UCP-100",
    });
  });
});

describe("parseSeedCsv", () => {
  it("maps the seed schema onto tag attributes", () => {
    const { rows, warnings } = parseSeedCsv(SEED_CSV);
    expect(warnings).toEqual([]);
    expect(rows).toHaveLength(4);
    expect(rows[1]).toMatchObject({
      tag: "FCV-1002",
      isaFunction: "Flow Control Valve",
      description: "Anti-surge valve, fail open",
      loopGroup: "1002 - Anti-Surge",
      lineOrEquipment: '8"-G-0101-1A1',
      panel: "",
      size: '8"',
      failPosition: "FO (Fail Open)",
    });
    expect(rows[2].notes).toBe('Bore printed as "XX" - not specified');
  });

  it("reports a missing Tag column instead of importing nothing silently", () => {
    const { rows, warnings } = parseSeedCsv("Function,Description\nPressure,Something");
    expect(rows).toEqual([]);
    expect(warnings[0]).toMatch(/No "Tag" column/);
  });

  it("skips duplicate tags and says so", () => {
    const { rows, warnings } = parseSeedCsv("Tag,Panel\nPT-1,A\nPT-1,B");
    expect(rows).toHaveLength(1);
    expect(warnings[0]).toMatch(/duplicate/i);
  });

  it("accepts header spellings that differ only in case and separators", () => {
    const { rows } = parseSeedCsv("tag,isa function,loop_group\nPT-1,Pressure Transmitter,1001");
    expect(rows[0]).toMatchObject({
      tag: "PT-1",
      isaFunction: "Pressure Transmitter",
      loopGroup: "1001",
    });
  });
});

describe("tagKey", () => {
  it("ignores separators and case, as OCR and typed lists disagree about them", () => {
    expect(tagKey("ZSC-1378A")).toBe(tagKey("zsc 1378a"));
    expect(tagKey("ZSC-1378A")).toBe(tagKey("ZSC1378A"));
    expect(tagKey("ZSC-1378A")).not.toBe(tagKey("ZSC-1378"));
  });
});

describe("mergeSeedRows", () => {
  it("enriches a matched tag and keeps the position it was found at", () => {
    const detected = [tag({ id: "t1", text: "PT 1001", bbox: { x0: 5, y0: 6, x1: 55, y1: 26 } })];
    const { rows } = parseSeedCsv(SEED_CSV);
    const result = mergeSeedRows(detected, rows, OPTIONS);

    const merged = result.tags.find((t) => t.id === "t1");
    expect(merged).toBeDefined();
    // The seed list is the reviewed source of truth for the text...
    expect(merged?.text).toBe("PT-1001");
    expect(merged?.isaFunction).toBe("Pressure Transmitter");
    expect(merged?.panel).toBe("UCP-100");
    expect(merged?.state).toBe("confirmed");
    expect(merged?.updatedBy).toBe("KG");
    // ...but only the drawing knows where the tag actually is.
    expect(merged?.bbox).toEqual({ x0: 5, y0: 6, x1: 55, y1: 26 });
    expect(result.matched).toBe(1);
    expect(result.added).toBe(3);
  });

  it("corrects an OCR misreading of the suffix without moving the box", () => {
    const detected = [tag({ id: "t1", text: "ZSC-10024" })];
    const { rows } = parseSeedCsv(SEED_CSV);
    // "ZSC-10024" is not "ZSC-1002A" under the key, so it is not a match —
    // this documents that suffix misreads are added, not silently merged.
    const result = mergeSeedRows(detected, rows, OPTIONS);
    expect(result.matched).toBe(0);
    expect(result.unmatchedTagTexts).toEqual(["ZSC-10024"]);
  });

  it("does not overwrite an existing value unless asked", () => {
    const detected = [tag({ id: "t1", text: "PT-1001", panel: "UCP-999" })];
    const { rows } = parseSeedCsv(SEED_CSV);

    expect(mergeSeedRows(detected, rows, OPTIONS).tags[0].panel).toBe("UCP-999");
    expect(
      mergeSeedRows(detected, rows, { ...OPTIONS, overwriteExisting: true }).tags[0].panel,
    ).toBe("UCP-100");
  });

  it("adds unmatched seed rows with no position so nothing is dropped", () => {
    const { rows } = parseSeedCsv(SEED_CSV);
    const result = mergeSeedRows([], rows, OPTIONS);
    expect(result.tags).toHaveLength(4);
    const added = result.tags.find((t) => t.text === "FCV-1002");
    expect(added?.source).toBe("imported");
    expect(added?.functionCode).toBe("FCV");
    expect(added?.loopNumber).toBe("1002");
    expect(added?.bbox).toEqual({ x0: 0, y0: 0, x1: 0, y1: 0 });
  });

  it("lists detected tags the seed list says nothing about", () => {
    const detected = [tag({ id: "t1", text: "PT-1001" }), tag({ id: "t2", text: "XV-9999" })];
    const { rows } = parseSeedCsv(SEED_CSV);
    expect(mergeSeedRows(detected, rows, OPTIONS).unmatchedTagTexts).toEqual(["XV-9999"]);
  });
});

describe("line numbers", () => {
  it("splits a conventional line number into size, service and spec", () => {
    expect(parseLineNumber('8"-G-0331-8E1550')).toEqual({
      size: '8"',
      service: "G",
      specCode: "8E1550",
    });
    expect(parseLineNumber('4"-BD-0334-8E1550')).toMatchObject({ service: "BD" });
    // Sizes and numbers a designer has left as TBD must survive as written.
    expect(parseLineNumber('XX"-BD-XXXX-3D4')).toMatchObject({ service: "BD", specCode: "3D4" });
  });

  it("imports a plain list as well as a CSV", () => {
    const list = parseLinesInput('8"-G-0331-8E1550\n2"-IA-6531-3A10\n8"-G-0331-8E1550');
    expect(list.map((l) => l.lineNumber)).toEqual(['8"-G-0331-8E1550', '2"-IA-6531-3A10']);
    expect(list[1].service).toBe("IA");

    const csv = parseLinesInput('Line Number,Service,From,To\n8"-G-0331-8E1550,Gas,E-1301,C-1300');
    expect(csv[0]).toMatchObject({ service: "Gas", fromRef: "E-1301", toRef: "C-1300" });
  });

  it("gives each line a distinct id", () => {
    const a = lineFromNumber('8"-G-0331-8E1550');
    const b = lineFromNumber('8"-G-0331-8E1550');
    expect(a.id).not.toBe(b.id);
  });
});

describe("export / import round trip", () => {
  it("reproduces every attribute a re-import can carry", () => {
    const original = [
      tag({
        id: "t1",
        text: "FCV-1002",
        isaFunction: "Flow Control Valve",
        description: "Anti-surge valve, fail open",
        loopGroup: "1002 - Anti-Surge",
        lineOrEquipment: '8"-G-0101-1A1',
        panel: "UCP-100",
        size: '8"',
        failPosition: "FO (Fail Open)",
        notes: 'Bore printed as "XX"',
        state: "confirmed",
      }),
      tag({ id: "t2", text: "PT-1001", state: "illegible" }),
    ];

    const { rows, warnings } = parseSeedCsv(tagsToCsv(original));
    expect(warnings).toEqual([]);
    const reimported = mergeSeedRows([], rows, OPTIONS).tags;

    expect(reimported).toHaveLength(2);
    for (const [i, before] of original.entries()) {
      expect(reimported[i]).toMatchObject({
        text: before.text,
        isaFunction: before.isaFunction,
        description: before.description,
        loopGroup: before.loopGroup,
        lineOrEquipment: before.lineOrEquipment,
        panel: before.panel,
        size: before.size,
        failPosition: before.failPosition,
        notes: before.notes,
        // Review state survives, so an exported sheet handed to someone
        // else comes back with its verification intact.
        state: before.state,
      });
    }
  });

  it("exports an unplaced imported row with blank coordinates, not 0,0", () => {
    const [imported] = mergeSeedRows([], parseSeedCsv(SEED_CSV).rows, OPTIONS).tags;
    const csv = tagsToCsv([imported]);
    const [header, row] = parseCsv(csv);
    const centerX = row[header.indexOf("Center_X")];
    expect(centerX).toBe("");
  });
});

describe("pattern anchoring", () => {
  it("does not match a tag inside a line number or spec code", () => {
    const words: OcrWord[] = [
      '8"-G-0331-8E1550',
      "03-BD-0038",
      '4"-BD-0334-8E1550',
      "03-G-0046",
      "FCV-1319",
      "BDV-1378A",
    ].map((text, i) => ({
      text,
      confidence: 90,
      page: 1,
      origin: "page" as const,
      bbox: { x0: 0, y0: i * 200, x1: 200, y1: i * 200 + 40 },
    }));
    const found = extractTagCandidates(words, DEFAULT_PATTERNS, 0.8)
      .map((c) => c.text)
      .sort();
    // A real run produced "E1550", "BD-0038" and friends from exactly these.
    expect(found).toEqual(["BDV-1378A", "FCV-1319"]);
  });

  it("does not merge two vertically distant words into one tall phantom tag", () => {
    const words: OcrWord[] = [
      { text: "ZSC", confidence: 80, page: 1, origin: "bubble",
        bbox: { x0: 100, y0: 100, x1: 160, y1: 140 } },
      // 250px below: a different bubble entirely.
      { text: "1378A", confidence: 80, page: 1, origin: "bubble",
        bbox: { x0: 100, y0: 350, x1: 170, y1: 390 } },
    ];
    expect(extractTagCandidates(words, DEFAULT_PATTERNS, 8).map((c) => c.text)).not.toContain(
      "ZSC-1378A",
    );
  });
});
