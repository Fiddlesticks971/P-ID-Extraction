import type { DrawingRecord } from "../types";

/**
 * Local project store.
 *
 * The framework calls for SQLite plus PDFs on disk. This app has no
 * backend by design — drawings never leave the browser — so the same shape
 * is kept in IndexedDB instead: one record per drawing sheet holding its
 * metadata, tags, lines and notes, with the original file stored alongside
 * so a saved drawing can be reopened and re-rendered rather than merely
 * listed. Multi-drawing support is the point: a project is several sheets
 * that cross-reference each other by match line.
 */

const DB_NAME = "pid-extractor";
const DB_VERSION = 1;
const STORE = "drawings";

interface StoredDrawing {
  record: DrawingRecord;
  /** The uploaded source file, so the sheet can be re-rendered on reopen. */
  file?: Blob;
  fileName?: string;
  fileType?: string;
}

export interface DrawingSummary {
  id: string;
  drawingNumber: string;
  title: string;
  revision: string;
  sourceFileName: string;
  tagCount: number;
  confirmedCount: number;
  savedAt: string;
  hasFile: boolean;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    const opening = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) {
          req.result.createObjectStore(STORE, { keyPath: "record.id" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("Could not open the local project store"));
    });
    dbPromise = opening.catch((err: unknown) => {
      // Let the next call retry — a failure here is often a private-mode or
      // quota condition rather than something permanent.
      dbPromise = null;
      throw err;
    });
  }
  return dbPromise;
}

async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => Promise<T>,
): Promise<T> {
  const db = await openDb();
  const tx = db.transaction(STORE, mode);
  const result = await fn(tx.objectStore(STORE));
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
  return result;
}

export async function saveDrawing(record: DrawingRecord, file?: File): Promise<void> {
  const stored: StoredDrawing = {
    record: { ...record, savedAt: new Date().toISOString() },
    ...(file ? { file, fileName: file.name, fileType: file.type } : {}),
  };
  await withStore("readwrite", (store) => request(store.put(stored)));
}

export async function listDrawings(): Promise<DrawingSummary[]> {
  const all = await withStore("readonly", (store) => request(store.getAll() as IDBRequest<StoredDrawing[]>));
  return all
    .map(({ record, file }) => ({
      id: record.id,
      drawingNumber: record.meta.drawingNumber,
      title: record.meta.title,
      revision: record.meta.revision,
      sourceFileName: record.meta.sourceFileName,
      tagCount: record.tags.length,
      confirmedCount: record.tags.filter((t) => t.state === "confirmed").length,
      savedAt: record.savedAt,
      hasFile: Boolean(file),
    }))
    .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

export async function loadDrawing(
  id: string,
): Promise<{ record: DrawingRecord; file: File | null } | null> {
  const stored = await withStore("readonly", (store) =>
    request(store.get(id) as IDBRequest<StoredDrawing | undefined>),
  );
  if (!stored) return null;
  const file =
    stored.file && stored.fileName
      ? new File([stored.file], stored.fileName, { type: stored.fileType || "application/pdf" })
      : null;
  return { record: stored.record, file };
}

export async function deleteDrawing(id: string): Promise<void> {
  await withStore("readwrite", (store) => request(store.delete(id)));
}

/** Every tag across every saved drawing, for project-wide search and export. */
export async function loadAllTags(): Promise<{ drawing: DrawingSummary; record: DrawingRecord }[]> {
  const all = await withStore("readonly", (store) => request(store.getAll() as IDBRequest<StoredDrawing[]>));
  return all.map(({ record, file }) => ({
    drawing: {
      id: record.id,
      drawingNumber: record.meta.drawingNumber,
      title: record.meta.title,
      revision: record.meta.revision,
      sourceFileName: record.meta.sourceFileName,
      tagCount: record.tags.length,
      confirmedCount: record.tags.filter((t) => t.state === "confirmed").length,
      savedAt: record.savedAt,
      hasFile: Boolean(file),
    },
    record,
  }));
}
