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
