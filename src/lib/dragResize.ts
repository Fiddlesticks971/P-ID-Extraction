/**
 * Shared plumbing for the app's drag-to-resize handles (the table's column
 * dividers and the splitter between the drawing and the review panel).
 *
 * The fiddly parts are the same wherever you do this and easy to get
 * subtly wrong: listeners have to go on the window rather than the handle
 * so the drag survives the pointer outrunning a 6px target, the body
 * cursor has to be pinned so it doesn't flicker back to a text caret over
 * intervening elements, and text selection has to be suppressed for the
 * duration or the drag paints a selection across the whole page.
 */

export interface DragOptions {
  /** Called on every move with the offset from where the drag started. */
  onMove: (delta: { dx: number; dy: number }) => void;
  /** Cursor to pin for the duration, e.g. "col-resize". */
  cursor?: string;
  onEnd?: () => void;
}

export function beginDrag(
  event: { clientX: number; clientY: number; preventDefault: () => void; stopPropagation: () => void },
  { onMove, cursor = "col-resize", onEnd }: DragOptions,
): void {
  event.preventDefault();
  event.stopPropagation();
  const startX = event.clientX;
  const startY = event.clientY;

  function handleMove(moveEvent: MouseEvent) {
    onMove({ dx: moveEvent.clientX - startX, dy: moveEvent.clientY - startY });
  }

  function handleUp() {
    window.removeEventListener("mousemove", handleMove);
    window.removeEventListener("mouseup", handleUp);
    document.body.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
    onEnd?.();
  }

  document.body.style.setProperty("cursor", cursor);
  document.body.style.setProperty("user-select", "none");
  window.addEventListener("mousemove", handleMove);
  window.addEventListener("mouseup", handleUp);
}

/**
 * A per-viewer layout preference. Worth remembering between sessions —
 * someone reviewing a wide drawing on a wide monitor should not have to
 * drag the splitter back every time — but never worth failing over: a
 * private window or blocked site data makes these throw, and the layout
 * has a perfectly good default.
 */
export function readStoredNumber(key: string, fallback: number): number {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

export function writeStoredNumber(key: string, value: number): void {
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    // A layout preference is not worth surfacing an error for.
  }
}
