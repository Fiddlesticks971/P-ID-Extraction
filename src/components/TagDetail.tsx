import { useEffect, useRef } from "react";
import type { PageImage, ReviewState, Tag } from "../types";
import { REVIEW_STATES } from "../types";

interface TagDetailProps {
  tag: Tag;
  page: PageImage | null;
  onUpdateTag: (id: string, patch: Partial<Tag>) => void;
  onClose: () => void;
  onLocate: () => void;
}

const CROP_WIDTH = 260;
const CROP_HEIGHT = 130;
/** How much drawing context to show around the tag box, as a multiple of its size. */
const CROP_CONTEXT = 1.8;

/**
 * Side-by-side verification: the cropped region of the drawing the tag was
 * read from, next to its editable fields. Reading a bubble at 1:1 in the
 * full-page view is hard even at high zoom, and the whole point of the
 * review step is that a value is confirmed against the source rather than
 * trusted because OCR produced it.
 */
function TagCrop({ tag, page }: { tag: Tag; page: PageImage | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const placed = tag.bbox.x1 > tag.bbox.x0 && tag.bbox.y1 > tag.bbox.y0;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !page || !placed) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const boxW = tag.bbox.x1 - tag.bbox.x0;
    const boxH = tag.bbox.y1 - tag.bbox.y0;
    // Expand the box to the crop's aspect ratio so the drawing isn't
    // stretched, then pad it for context.
    const scale = Math.min(CROP_WIDTH / boxW, CROP_HEIGHT / boxH) / CROP_CONTEXT;
    const srcW = CROP_WIDTH / scale;
    const srcH = CROP_HEIGHT / scale;
    const cx = (tag.bbox.x0 + tag.bbox.x1) / 2;
    const cy = (tag.bbox.y0 + tag.bbox.y1) / 2;
    const sx = Math.max(0, Math.min(page.width - srcW, cx - srcW / 2));
    const sy = Math.max(0, Math.min(page.height - srcH, cy - srcH / 2));

    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, CROP_WIDTH, CROP_HEIGHT);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(page.canvas, sx, sy, srcW, srcH, 0, 0, CROP_WIDTH, CROP_HEIGHT);

    ctx.strokeStyle = "#2563eb";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(
      (tag.bbox.x0 - sx) * scale,
      (tag.bbox.y0 - sy) * scale,
      boxW * scale,
      boxH * scale,
    );
  }, [tag, page, placed]);

  if (!placed) {
    return (
      <div className="tag-crop-empty">
        Not placed on the drawing. Use <strong>+ Add Tag</strong> to position it.
      </div>
    );
  }
  return <canvas ref={canvasRef} className="tag-crop" width={CROP_WIDTH} height={CROP_HEIGHT} />;
}

const FIELDS: { key: keyof Tag; label: string; placeholder?: string }[] = [
  { key: "text", label: "Tag" },
  { key: "isaFunction", label: "ISA Function", placeholder: "e.g. Position Switch - Closed" },
  { key: "description", label: "Description" },
  { key: "loopGroup", label: "Loop / Group", placeholder: "e.g. 1378A - Blowdown Valve" },
  { key: "lineOrEquipment", label: "Line / Equipment", placeholder: 'e.g. 4"-BD-0334-8E1550' },
  { key: "panel", label: "Panel", placeholder: "e.g. UCP-1300" },
  { key: "size", label: "Size", placeholder: 'e.g. 4"' },
  { key: "failPosition", label: "Fail Position", placeholder: "e.g. FO (Fail Open)" },
  { key: "continuesOn", label: "Continues On", placeholder: "e.g. SK-1310" },
  { key: "notes", label: "Notes" },
];

export function TagDetail({ tag, page, onUpdateTag, onClose, onLocate }: TagDetailProps) {
  return (
    <div className="tag-detail">
      <div className="tag-detail-header">
        <strong>{tag.text || "(untitled tag)"}</strong>
        <span className="muted">
          {tag.source} &middot; {Math.round(tag.confidence)}%
        </span>
        <button onClick={onLocate} disabled={tag.bbox.x1 <= tag.bbox.x0}>
          Locate
        </button>
        <button onClick={onClose}>Close</button>
      </div>

      <div className="tag-detail-body">
        <div className="tag-detail-crop">
          <TagCrop tag={tag} page={page} />
          <label className="tag-detail-state">
            <span>Review state</span>
            <select
              value={tag.state}
              onChange={(e) => onUpdateTag(tag.id, { state: e.target.value as ReviewState })}
            >
              {REVIEW_STATES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          {tag.updatedAt && (
            <p className="muted tag-detail-audit">
              Last edited {new Date(tag.updatedAt).toLocaleString()}
              {tag.updatedBy ? ` by ${tag.updatedBy}` : ""}
            </p>
          )}
        </div>

        <div className="tag-detail-fields">
          {FIELDS.map(({ key, label, placeholder }) => (
            <label key={key}>
              <span>{label}</span>
              <input
                value={String(tag[key] ?? "")}
                placeholder={placeholder}
                onChange={(e) => onUpdateTag(tag.id, { [key]: e.target.value } as Partial<Tag>)}
              />
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}
