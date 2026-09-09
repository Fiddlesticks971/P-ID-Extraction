import { useEffect, useRef, useState } from "react";
import type { PageImage, Tag } from "../types";

interface PidViewerProps {
  page: PageImage | null;
  pageCount: number;
  currentPageIndex: number;
  onPageChange: (index: number) => void;
  tags: Tag[];
  selectedTagId: string | null;
  onSelectTag: (id: string | null) => void;
  addMode: boolean;
  onAddTagAt: (xFraction: number, yFraction: number) => void;
}

export function PidViewer({
  page,
  pageCount,
  currentPageIndex,
  onPageChange,
  tags,
  selectedTagId,
  onSelectTag,
  addMode,
  onAddTagAt,
}: PidViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boxRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    if (!page || !canvasRef.current) return;
    const canvas = canvasRef.current;
    canvas.width = page.width;
    canvas.height = page.height;
    const ctx = canvas.getContext("2d");
    ctx?.drawImage(page.canvas, 0, 0);
  }, [page]);

  useEffect(() => {
    if (!selectedTagId) return;
    boxRefs.current.get(selectedTagId)?.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
  }, [selectedTagId]);

  if (!page) {
    return (
      <div className="viewer-empty">
        <p>Upload a P&amp;ID to get started.</p>
      </div>
    );
  }

  const displayWidth = page.width * zoom;
  const displayHeight = page.height * zoom;

  return (
    <div className="viewer">
      <div className="viewer-toolbar">
        {pageCount > 1 && (
          <div className="page-nav">
            <button
              disabled={currentPageIndex === 0}
              onClick={() => onPageChange(currentPageIndex - 1)}
            >
              &larr; Prev
            </button>
            <span>
              Page {currentPageIndex + 1} / {pageCount}
            </span>
            <button
              disabled={currentPageIndex === pageCount - 1}
              onClick={() => onPageChange(currentPageIndex + 1)}
            >
              Next &rarr;
            </button>
          </div>
        )}
        <div className="zoom-controls">
          <button onClick={() => setZoom((z) => Math.max(0.25, z - 0.25))}>&minus;</button>
          <span>{Math.round(zoom * 100)}%</span>
          <button onClick={() => setZoom((z) => Math.min(4, z + 0.25))}>+</button>
          <button onClick={() => setZoom(1)}>Reset</button>
        </div>
        {addMode && <span className="add-mode-hint">Click on the drawing to place a new tag</span>}
      </div>
      <div className="viewer-scroll">
        <div
          className={`viewer-canvas-wrap${addMode ? " add-mode" : ""}`}
          style={{ width: displayWidth, height: displayHeight }}
          onClick={(e) => {
            if (!addMode) return;
            const rect = e.currentTarget.getBoundingClientRect();
            const xFraction = (e.clientX - rect.left) / rect.width;
            const yFraction = (e.clientY - rect.top) / rect.height;
            onAddTagAt(xFraction, yFraction);
          }}
        >
          <canvas
            ref={canvasRef}
            style={{ width: displayWidth, height: displayHeight }}
          />
          <div className="overlay">
            {tags.map((tag) => {
              // Imported rows that were never placed on the sheet have a
              // zero-area box; drawing them would put a dot in the corner.
              if (tag.bbox.x1 <= tag.bbox.x0 && tag.bbox.y1 <= tag.bbox.y0) return null;
              const left = (tag.bbox.x0 / page.width) * 100;
              const top = (tag.bbox.y0 / page.height) * 100;
              const width = ((tag.bbox.x1 - tag.bbox.x0) / page.width) * 100;
              const height = ((tag.bbox.y1 - tag.bbox.y0) / page.height) * 100;
              const isSelected = tag.id === selectedTagId;
              return (
                <div
                  key={tag.id}
                  ref={(el) => {
                    if (el) boxRefs.current.set(tag.id, el);
                    else boxRefs.current.delete(tag.id);
                  }}
                  className={`tag-box ${tag.state}${isSelected ? " selected" : ""}`}
                  style={{ left: `${left}%`, top: `${top}%`, width: `${width}%`, height: `${height}%` }}
                  title={`${tag.text}${tag.description ? " — " + tag.description : ""}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelectTag(tag.id === selectedTagId ? null : tag.id);
                  }}
                >
                  <span className="tag-box-label">{tag.text}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
