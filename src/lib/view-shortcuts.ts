import type { ViewMode } from '@/store/app';

/** Single source of truth for view shortcuts (sidebar labels, handler, Settings). */
export const VIEW_SHORTCUTS: Array<{ key: string; view: ViewMode; label: string }> = [
  { key: '1', view: 'canvas', label: 'Canvas' },
  { key: '2', view: 'library', label: 'Library' },
  { key: '3', view: 'books', label: 'Books' },
  { key: '4', view: 'annotations', label: 'Annotations' },
  { key: '5', view: 'flashcards', label: 'Flashcards' },
  { key: '6', view: 'exams', label: 'Exams' },
  { key: '7', view: 'pomodoro', label: 'Pomodoro' },
  { key: '8', view: 'motivation', label: 'Motivation' },
  { key: '9', view: 'inbox', label: 'Inbox' },
  { key: ',', view: 'settings', label: 'Settings' },
];

export function shortcutFor(view: ViewMode): string {
  const entry = VIEW_SHORTCUTS.find((item) => item.view === view);
  return entry ? `Ctrl+${entry.key}` : '';
}

export const VIEW_KEYS: Record<string, ViewMode> = Object.fromEntries(
  VIEW_SHORTCUTS.map(({ key, view }) => [key, view]),
);

/** Full shortcut sheet, derived from the same map as the handlers. */
export const APP_SHORTCUTS: Array<{ keys: string; action: string }> = [
  {
    keys: `Ctrl + ${VIEW_SHORTCUTS.map((item) => item.key).join(' / ')}`,
    action: `Go to ${VIEW_SHORTCUTS.map((item) => item.label.toLowerCase()).join(', ')}`,
  },
  { keys: 'Ctrl + K', action: 'Search across notes, PDFs, books and highlights' },
  { keys: '?', action: 'Show this shortcut sheet' },
  { keys: 'Ctrl + J', action: 'Show or hide the assistant' },
  { keys: 'Drag background / Space + drag / middle mouse', action: 'Pan the canvas' },
  { keys: 'Ctrl + scroll, pinch', action: 'Zoom the canvas around the pointer' },
  { keys: 'Ctrl + = / Ctrl + - / Ctrl + 0', action: 'Zoom in, out, reset (PDF zoom when a PDF window is active)' },
  { keys: 'Shift + 1 / Shift + 2', action: 'Fit all windows / zoom to the selected window' },
  { keys: 'Ctrl + Z / Ctrl + Shift + Z', action: 'Undo / redo (layout, or annotations in the active PDF)' },
  { keys: 'Double-click canvas', action: 'Create a note at that spot' },
  { keys: 'Double-click title bar', action: 'Maximize or restore a window' },
  { keys: 'Shift while dragging', action: 'Snap windows to a 20px grid' },
  { keys: 'Alt while dragging or resizing', action: 'Move freely, with no snapping or guides' },
  { keys: 'Alt + ← → ↑ ↓', action: 'Align the selection edges (left, right, top, bottom)' },
  { keys: 'Alt + Shift + ← → / ↑ ↓', action: 'Spread the selection out evenly across or down' },
  { keys: 'M', action: 'Show or hide the canvas minimap' },
  { keys: 'Esc while dragging or resizing', action: 'Cancel the move and put everything back' },
  { keys: 'Esc', action: 'Restore a maximized window / deselect' },
  { keys: 'Ctrl + Alt + N', action: 'New note' },
  { keys: 'V H P M T R O A E', action: 'PDF tools: select, highlight, pen, marker, text, rectangle, ellipse, arrow, eraser' },
  { keys: 'Delete', action: 'Delete selected PDF annotations' },
  { keys: 'Ctrl + B / I / E / K', action: 'Bold, italic, code, link in notes' },
  { keys: 'Space, 1–4', action: 'Flip card and rate it while reviewing flashcards' },
];
