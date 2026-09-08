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
          <thead>
            <tr>
              <th>Tag</th>
              <th>Type</th>
              <th>Description</th>
              <th>Page</th>
              <th>Conf.</th>
              <th>Verified</th>
              <th></th>
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
