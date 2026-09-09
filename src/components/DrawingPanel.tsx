import { useRef, useState } from "react";
import type { DrawingMeta, LineRecord, NoteRecord } from "../types";
import type { DrawingSummary } from "../lib/persist";
import { lineFromNumber, parseLinesInput } from "../lib/tagImport";

interface DrawingPanelProps {
  meta: DrawingMeta;
  onMetaChange: (patch: Partial<DrawingMeta>) => void;
  lines: LineRecord[];
  onLinesChange: (lines: LineRecord[]) => void;
  notes: NoteRecord[];
  onNotesChange: (notes: NoteRecord[]) => void;
  library: DrawingSummary[];
  currentDrawingId: string | null;
  onSave: () => void;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  saveState: string | null;
  hasDrawing: boolean;
}

const META_FIELDS: { key: keyof DrawingMeta; label: string; placeholder?: string }[] = [
  { key: "drawingNumber", label: "Drawing Number", placeholder: "FA34685-P01-0020" },
  { key: "revision", label: "Revision", placeholder: "C" },
  { key: "title", label: "Title", placeholder: "Unit 03 Discharge Cooler Skid" },
  { key: "project", label: "Project", placeholder: "Eastern Interstates – Indian Bayou CS" },
  { key: "client", label: "Client", placeholder: "Williams" },
  { key: "county", label: "County / Parish", placeholder: "Beauregard" },
  { key: "state", label: "State", placeholder: "Louisiana" },
  { key: "date", label: "Date" },
  { key: "matchLineRefs", label: "Match Line Refs", placeholder: "SK-1310" },
];

let noteCounter = 0;

export function DrawingPanel({
  meta,
  onMetaChange,
  lines,
  onLinesChange,
  notes,
  onNotesChange,
  library,
  currentDrawingId,
  onSave,
  onOpen,
  onDelete,
  saveState,
  hasDrawing,
}: DrawingPanelProps) {
  const [newLine, setNewLine] = useState("");
  const linesFileRef = useRef<HTMLInputElement>(null);

  function addLine() {
    const value = newLine.trim();
    if (!value) return;
    onLinesChange([...lines, lineFromNumber(value)]);
    setNewLine("");
  }

  async function importLines(file: File) {
    const parsed = parseLinesInput(await file.text());
    const existing = new Set(lines.map((l) => l.lineNumber.toUpperCase()));
    onLinesChange([...lines, ...parsed.filter((l) => !existing.has(l.lineNumber.toUpperCase()))]);
  }

  function updateLine(id: string, patch: Partial<LineRecord>) {
    onLinesChange(lines.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  }

  function addNote() {
    noteCounter += 1;
    onNotesChange([...notes, { id: `note-${Date.now()}-${noteCounter}`, flag: "", text: "" }]);
  }

  function updateNote(id: string, patch: Partial<NoteRecord>) {
    onNotesChange(notes.map((n) => (n.id === id ? { ...n, ...patch } : n)));
  }

  return (
    <div className="drawing-panel">
      <section>
        <h3>Title block</h3>
        <div className="meta-grid">
          {META_FIELDS.map(({ key, label, placeholder }) => (
            <label key={key}>
              <span>{label}</span>
              <input
                value={meta[key]}
                placeholder={placeholder}
                onChange={(e) => onMetaChange({ [key]: e.target.value } as Partial<DrawingMeta>)}
              />
            </label>
          ))}
        </div>
        {meta.sourceFileName && <p className="muted">Source file: {meta.sourceFileName}</p>}
      </section>

      <section>
        <div className="section-head">
          <h3>Line numbers ({lines.length})</h3>
          <button onClick={() => linesFileRef.current?.click()}>Import…</button>
          <input
            ref={linesFileRef}
            type="file"
            accept=".csv,.txt"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void importLines(file);
              e.target.value = "";
            }}
          />
        </div>
        <div className="add-row">
          <input
            value={newLine}
            placeholder='8"-G-0331-8E1550'
            onChange={(e) => setNewLine(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") addLine();
            }}
          />
          <button onClick={addLine} disabled={!newLine.trim()}>
            Add
          </button>
        </div>
        {lines.length > 0 && (
          <table className="mini-table">
            <thead>
              <tr>
                <th>Line Number</th>
                <th>Size</th>
                <th>Svc</th>
                <th>Spec</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => (
                <tr key={line.id}>
                  <td>
                    <input
                      value={line.lineNumber}
                      onChange={(e) => updateLine(line.id, { lineNumber: e.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      value={line.size}
                      onChange={(e) => updateLine(line.id, { size: e.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      value={line.service}
                      onChange={(e) => updateLine(line.id, { service: e.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      value={line.specCode}
                      onChange={(e) => updateLine(line.id, { specCode: e.target.value })}
                    />
                  </td>
                  <td>
                    <button
                      className="danger small"
                      onClick={() => onLinesChange(lines.filter((l) => l.id !== line.id))}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <div className="section-head">
          <h3>Note flags ({notes.length})</h3>
          <button onClick={addNote}>+ Add</button>
        </div>
        {notes.length === 0 && (
          <p className="muted">
            Hex-flagged note references on the sheet (e.g. 251A) and what they point to.
          </p>
        )}
        {notes.map((note) => (
          <div key={note.id} className="add-row">
            <input
              className="note-flag"
              value={note.flag}
              placeholder="251A"
              onChange={(e) => updateNote(note.id, { flag: e.target.value })}
            />
            <input
              value={note.text}
              placeholder="Note text"
              onChange={(e) => updateNote(note.id, { text: e.target.value })}
            />
            <button
              className="danger small"
              onClick={() => onNotesChange(notes.filter((n) => n.id !== note.id))}
            >
              ✕
            </button>
          </div>
        ))}
      </section>

      <section>
        <div className="section-head">
          <h3>Project library ({library.length})</h3>
          <button onClick={onSave} disabled={!hasDrawing}>
            Save drawing
          </button>
        </div>
        {saveState && <p className="muted">{saveState}</p>}
        {library.length === 0 && (
          <p className="muted">
            Saved drawings are kept in this browser so a project can span several sheets. Nothing is
            uploaded anywhere.
          </p>
        )}
        {library.map((d) => (
          <div key={d.id} className={`library-row${d.id === currentDrawingId ? " current" : ""}`}>
            <div className="library-row-main">
              <strong>{d.drawingNumber || d.sourceFileName || "(untitled)"}</strong>
              {d.revision && <span className="muted"> Rev {d.revision}</span>}
              <div className="muted">
                {d.title || "—"} · {d.confirmedCount}/{d.tagCount} confirmed ·{" "}
                {new Date(d.savedAt).toLocaleDateString()}
              </div>
            </div>
            <button onClick={() => onOpen(d.id)} disabled={!d.hasFile}>
              Open
            </button>
            <button className="danger small" onClick={() => onDelete(d.id)}>
              ✕
            </button>
          </div>
        ))}
      </section>
    </div>
  );
}
