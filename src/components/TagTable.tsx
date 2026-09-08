import { useMemo, useState } from "react";
import type { Tag } from "../types";

interface TagTableProps {
  tags: Tag[];
  selectedTagId: string | null;
  onSelectTag: (id: string | null) => void;
  onUpdateTag: (id: string, patch: Partial<Tag>) => void;
  onDeleteTag: (id: string) => void;
  onConfirmAll: () => void;
  onDeleteUnconfirmed: () => void;
}

// Tag, Type, Description, Page, Conf., Verified, actions
const DEFAULT_COLUMN_WIDTHS = [110, 90, 160, 50, 55, 65, 70];
const MIN_COLUMN_WIDTH = 32;

export function TagTable({
  tags,
  selectedTagId,
  onSelectTag,
  onUpdateTag,
  onDeleteTag,
  onConfirmAll,
  onDeleteUnconfirmed,
}: TagTableProps) {
  const [filter, setFilter] = useState("");
  const [columnWidths, setColumnWidths] = useState<number[]>(DEFAULT_COLUMN_WIDTHS);

  function startColumnResize(index: number, e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startWidth = columnWidths[index];

    function onMouseMove(moveEvent: MouseEvent) {
      const nextWidth = Math.max(MIN_COLUMN_WIDTH, startWidth + (moveEvent.clientX - startX));
      setColumnWidths((prev) => prev.map((w, i) => (i === index ? nextWidth : w)));
    }
    function onMouseUp() {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
    }

    document.body.style.setProperty("cursor", "col-resize");
    document.body.style.setProperty("user-select", "none");
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return tags;
    return tags.filter(
      (t) =>
        t.text.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q) ||
        t.type.toLowerCase().includes(q),
    );
  }, [tags, filter]);

  const confirmedCount = tags.filter((t) => t.confirmed).length;

  return (
    <div className="tag-table-panel">
      <div className="tag-table-toolbar">
        <input
          type="search"
          placeholder="Filter tags..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <span className="muted">
          {confirmedCount}/{tags.length} verified
        </span>
        <button onClick={onConfirmAll} disabled={tags.length === 0}>
          Verify All
        </button>
        <button onClick={onDeleteUnconfirmed} disabled={tags.length === 0} className="danger">
          Remove Unverified
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
              {["Tag", "Type", "Description", "Page", "Conf.", "Verified", ""].map((label, i) => (
                <th key={label || "actions"}>
                  {label}
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
                className={tag.id === selectedTagId ? "selected" : ""}
                onClick={() => onSelectTag(tag.id === selectedTagId ? null : tag.id)}
              >
                <td>
                  <input
                    value={tag.text}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => onUpdateTag(tag.id, { text: e.target.value })}
                  />
                </td>
                <td>
                  <input
                    value={tag.type}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => onUpdateTag(tag.id, { type: e.target.value })}
                  />
                </td>
                <td>
                  <input
                    value={tag.description}
                    placeholder="add description"
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => onUpdateTag(tag.id, { description: e.target.value })}
                  />
                </td>
                <td>{tag.page}</td>
                <td>{Math.round(tag.confidence)}%</td>
                <td onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={tag.confirmed}
                    onChange={(e) => onUpdateTag(tag.id, { confirmed: e.target.checked })}
                  />
                </td>
                <td onClick={(e) => e.stopPropagation()}>
                  <button className="danger small" onClick={() => onDeleteTag(tag.id)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={7} className="muted empty-row">
                  No tags yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
