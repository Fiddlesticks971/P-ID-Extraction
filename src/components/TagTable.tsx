import { useMemo, useState } from "react";
import type { ReviewState, Tag } from "../types";
import { REVIEW_STATES } from "../types";
import { beginDrag } from "../lib/dragResize";

interface TagTableProps {
  tags: Tag[];
  selectedTagId: string | null;
  onSelectTag: (id: string | null) => void;
  onUpdateTag: (id: string, patch: Partial<Tag>) => void;
  onDeleteTag: (id: string) => void;
  onSetStateAll: (state: ReviewState) => void;
  onDeleteUnconfirmed: () => void;
}

/**
 * Sized to fit the panel without horizontal scrolling. Line/Equipment,
 * size, fail position and notes are edited in the detail panel instead —
 * the table carries the fields you scan and filter by, not every field.
 */
const COLUMNS = [
  { key: "text", label: "Tag", width: 96 },
  { key: "isaFunction", label: "ISA Function", width: 132 },
  { key: "loopGroup", label: "Loop / Group", width: 110 },
  { key: "panel", label: "Panel", width: 74 },
  { key: "state", label: "State", width: 84 },
  { key: "page", label: "Pg", width: 26 },
  { key: "confidence", label: "Conf.", width: 42 },
  { key: "actions", label: "", width: 52 },
] as const;

const EDITABLE: Record<string, keyof Tag | undefined> = {
  text: "text",
  isaFunction: "isaFunction",
  loopGroup: "loopGroup",
  panel: "panel",
};

const MIN_COLUMN_WIDTH = 32;
const ALL = "__all__";
const INSTRUMENTS = "instruments";
const PAGE_TEXT = "page";

/**
 * Auto-extracted page text is the noise: on a dense sheet it is mostly
 * line numbers, spec codes and title-block matter. Bubble reads are the
 * instruments, and anything a person put there — typed in by hand or
 * imported from a reviewed list — is never noise, whatever its origin.
 */
function isPageNoise(tag: Tag): boolean {
  return tag.origin === "page" && tag.source === "auto";
}

/** Distinct non-empty values of a field, for the dropdown filters. */
function distinct(tags: Tag[], key: keyof Tag): string[] {
  const set = new Set<string>();
  for (const tag of tags) {
    const value = String(tag[key] ?? "").trim();
    if (value) set.add(value);
  }
  return [...set].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

export function TagTable({
  tags,
  selectedTagId,
  onSelectTag,
  onUpdateTag,
  onDeleteTag,
  onSetStateAll,
  onDeleteUnconfirmed,
}: TagTableProps) {
  const [filter, setFilter] = useState("");
  const [loopFilter, setLoopFilter] = useState(ALL);
  const [panelFilter, setPanelFilter] = useState(ALL);
  const [stateFilter, setStateFilter] = useState<string>(ALL);
  // Page text starts hidden: it is the bulk of the rows and almost none
  // of the instruments.
  const [originFilter, setOriginFilter] = useState<string>(INSTRUMENTS);
  const [columnWidths, setColumnWidths] = useState<number[]>(COLUMNS.map((c) => c.width));

  function startColumnResize(index: number, e: React.MouseEvent) {
    const startWidth = columnWidths[index];
    beginDrag(e, {
      onMove: ({ dx }) => {
        const nextWidth = Math.max(MIN_COLUMN_WIDTH, startWidth + dx);
        setColumnWidths((prev) => prev.map((w, i) => (i === index ? nextWidth : w)));
      },
    });
  }

  const loopGroups = useMemo(() => distinct(tags, "loopGroup"), [tags]);
  const panels = useMemo(() => distinct(tags, "panel"), [tags]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    // A bare prefix like "ZSC-" or "ZSC" should behave as "all ZSC tags"
    // rather than a substring match that also catches descriptions.
    return tags.filter((t) => {
      if (loopFilter !== ALL && t.loopGroup !== loopFilter) return false;
      if (panelFilter !== ALL && t.panel !== panelFilter) return false;
      if (stateFilter !== ALL && t.state !== stateFilter) return false;
      if (originFilter === INSTRUMENTS && isPageNoise(t)) return false;
      if (originFilter === PAGE_TEXT && !isPageNoise(t)) return false;
      if (!q) return true;
      return (
        t.text.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q) ||
        t.isaFunction.toLowerCase().includes(q) ||
        t.loopGroup.toLowerCase().includes(q) ||
        t.lineOrEquipment.toLowerCase().includes(q) ||
        t.panel.toLowerCase().includes(q) ||
        t.notes.toLowerCase().includes(q)
      );
    });
  }, [tags, filter, loopFilter, panelFilter, stateFilter, originFilter]);

  const pageTagCount = useMemo(() => tags.filter(isPageNoise).length, [tags]);

  const counts = useMemo(() => {
    const c: Record<ReviewState, number> = { confirmed: 0, uncertain: 0, illegible: 0 };
    for (const tag of tags) c[tag.state]++;
    return c;
  }, [tags]);

  const filtersActive =
    loopFilter !== ALL ||
    panelFilter !== ALL ||
    stateFilter !== ALL ||
    originFilter !== INSTRUMENTS ||
    filter.trim() !== "";

  return (
    <div className="tag-table-panel">
      <div className="tag-table-toolbar">
        <input
          type="search"
          placeholder="Search tags, lines, notes..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <select value={loopFilter} onChange={(e) => setLoopFilter(e.target.value)} title="Loop / group">
          <option value={ALL}>All loops</option>
          {loopGroups.map((g) => (
            <option key={g} value={g}>
              {g}
            </option>
          ))}
        </select>
        <select value={panelFilter} onChange={(e) => setPanelFilter(e.target.value)} title="Panel">
          <option value={ALL}>All panels</option>
          {panels.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <select value={stateFilter} onChange={(e) => setStateFilter(e.target.value)} title="Review state">
          <option value={ALL}>All states</option>
          {REVIEW_STATES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select
          value={originFilter}
          onChange={(e) => setOriginFilter(e.target.value)}
          title="Where the text came from"
        >
          <option value={INSTRUMENTS}>Instruments &amp; imported</option>
          <option value={PAGE_TEXT}>Other page text</option>
          <option value={ALL}>Everything</option>
        </select>
        {filtersActive && (
          <button
            onClick={() => {
              setFilter("");
              setLoopFilter(ALL);
              setPanelFilter(ALL);
              setStateFilter(ALL);
              setOriginFilter(INSTRUMENTS);
            }}
          >
            Clear
          </button>
        )}
      </div>

      <div className="tag-table-toolbar secondary">
        <span className="muted">
          {filtered.length === tags.length
            ? `${tags.length} tags`
            : `${filtered.length} of ${tags.length} tags`}
          {originFilter === INSTRUMENTS && pageTagCount > 0 && (
            <>
              {" "}
              <button className="link" onClick={() => setOriginFilter(ALL)}>
                (+{pageTagCount} from page text)
              </button>
            </>
          )}
          {" — "}
          <span className="state-dot confirmed" /> {counts.confirmed}
          {"  "}
          <span className="state-dot uncertain" /> {counts.uncertain}
          {"  "}
          <span className="state-dot illegible" /> {counts.illegible}
        </span>
        <button onClick={() => onSetStateAll("confirmed")} disabled={tags.length === 0}>
          Confirm All
        </button>
        <button onClick={onDeleteUnconfirmed} disabled={tags.length === 0} className="danger">
          Remove Unconfirmed
        </button>
      </div>

      <div className="tag-table-scroll">
        <table className="tag-table">
          <colgroup>
            {columnWidths.map((w, i) => (
              // eslint-disable-next-line react/no-array-index-key -- column count/order is fixed
              <col key={i} style={{ width: w }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              {COLUMNS.map((col, i) => (
                <th key={col.key}>
                  {col.label}
                  <span
                    className="col-resize-handle"
                    onMouseDown={(e) => startColumnResize(i, e)}
                    onClick={(e) => e.stopPropagation()}
                  />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((tag) => (
              <tr
                key={tag.id}
                className={`${tag.id === selectedTagId ? "selected " : ""}state-${tag.state}`}
                onClick={() => onSelectTag(tag.id === selectedTagId ? null : tag.id)}
                // Most cells are inputs that stop the click from reaching the
                // row, so without this, clicking anywhere useful in a row
                // would fail to select it. Focus selects (never deselects) so
                // typing in an already-selected row doesn't close its detail.
                onFocus={() => onSelectTag(tag.id)}
              >
                {COLUMNS.map((col) => {
                  const field = EDITABLE[col.key];
                  if (field) {
                    return (
                      <td key={col.key}>
                        <input
                          value={String(tag[field] ?? "")}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) =>
                            onUpdateTag(tag.id, { [field]: e.target.value } as Partial<Tag>)
                          }
                        />
                      </td>
                    );
                  }
                  if (col.key === "state") {
                    return (
                      <td key={col.key} onClick={(e) => e.stopPropagation()}>
                        <select
                          className={`state-select ${tag.state}`}
                          value={tag.state}
                          onChange={(e) =>
                            onUpdateTag(tag.id, { state: e.target.value as ReviewState })
                          }
                        >
                          {REVIEW_STATES.map((s) => (
                            <option key={s} value={s}>
                              {s}
                            </option>
                          ))}
                        </select>
                      </td>
                    );
                  }
                  if (col.key === "page") return <td key={col.key}>{tag.page}</td>;
                  if (col.key === "confidence")
                    return <td key={col.key}>{Math.round(tag.confidence)}%</td>;
                  return (
                    <td key={col.key} onClick={(e) => e.stopPropagation()}>
                      <button className="danger small" onClick={() => onDeleteTag(tag.id)}>
                        Delete
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={COLUMNS.length} className="muted empty-row">
                  {tags.length === 0 ? "No tags yet." : "No tags match the current filters."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
