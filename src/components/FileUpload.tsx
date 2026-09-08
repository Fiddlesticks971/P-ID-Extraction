import { useRef, useState } from "react";
import type { DragEvent } from "react";

interface FileUploadProps {
  onFileSelected: (file: File) => void;
  disabled: boolean;
  currentFileName: string | null;
}

const ACCEPTED_EXTENSIONS = [".pdf", ".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp"];

export function FileUpload({ onFileSelected, disabled, currentFileName }: FileUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  function handleFiles(files: FileList | null) {
    const file = files?.[0];
    if (file) onFileSelected(file);
  }

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setIsDragging(false);
    if (disabled) return;
    handleFiles(e.dataTransfer.files);
  }

  return (
    <div
      className={`upload-dropzone${isDragging ? " dragging" : ""}${disabled ? " disabled" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setIsDragging(true);
      }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={handleDrop}
      onClick={() => !disabled && inputRef.current?.click()}
      role="button"
      tabIndex={0}
    >
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED_EXTENSIONS.join(",")}
        className="visually-hidden"
        disabled={disabled}
        onChange={(e) => handleFiles(e.target.files)}
      />
      <div className="upload-icon" aria-hidden>
        &#8593;
      </div>
      {currentFileName ? (
        <div>
          <strong>{currentFileName}</strong>
          <p className="muted">Click or drop a file to replace</p>
        </div>
      ) : (
        <div>
          <strong>Upload a P&amp;ID</strong>
          <p className="muted">PDF or image (PNG, JPG, TIFF) &mdash; drag &amp; drop or click</p>
        </div>
      )}
    </div>
  );
}
