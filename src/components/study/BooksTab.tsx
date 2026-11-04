'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useBooks, type BookProject } from '@/store/books';
import { BookTree } from './books/BookTree';
import { BookFileList } from './books/BookFileList';
import { BookFileDetails } from './books/BookFileDetails';
import Dialog from '@/components/ui/Dialog';
import { isTauri } from '@/lib/tauri-commands';
import { Check, ChevronDown, FileStack, FolderSearch, HelpCircle, History, Plus, RotateCcw, Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Where a Books search looks: the viewed project, a hand-picked subset, or everything. */
export type BooksSearchScope =
  | { kind: 'active' }
  | { kind: 'all' }
  | { kind: 'pick'; ids: string[] };

function searchScopeLabel(scope: BooksSearchScope, projects: BookProject[]): string {
  if (scope.kind === 'active') return 'This project';
  if (scope.kind === 'all') return 'All projects';
  if (scope.ids.length === 1) return projects.find((p) => p.id === scope.ids[0])?.name ?? 'This project';
  if (scope.ids.length === 0) return 'This project';
  return `${scope.ids.length} projects`;
}

function SearchScopePicker({
  scope,
  projects,
  activeProjectId,
  onChange,
}: {
  scope: BooksSearchScope;
  projects: BookProject[];
  activeProjectId: string | null;
  onChange: (scope: BooksSearchScope) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  // Close on outside press or Escape while the picker is open.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const label = searchScopeLabel(scope, projects);
  const pickIds = scope.kind === 'pick' ? scope.ids : null;

  const toggleProject = (id: string) => {
    const current =
      scope.kind === 'pick'
        ? scope.ids
        : scope.kind === 'all'
          ? projects.map((p) => p.id)
          : activeProjectId
            ? [activeProjectId]
            : [];
    const next = current.includes(id) ? current.filter((other) => other !== id) : [...current, id];
    onChange(next.length === 0 ? { kind: 'active' } : { kind: 'pick', ids: next });
  };

  return (
    <div ref={wrapRef} className="books-scope-wrap">
      <button
        type="button"
        className="btn btn-sm btn-ghost books-scope-btn"
        onClick={() => setOpen((was) => !was)}
        title="Choose which projects to search"
      >
        <FolderSearch size={14} />
        <span className="books-scope-label">{label}</span>
        <ChevronDown size={13} />
      </button>

      {open && (
        <div className="books-scope-pop" role="menu">
          <button
            type="button"
            className={cn('menu-item', scope.kind === 'active' && 'menu-item-active')}
            onClick={() => {
              onChange({ kind: 'active' });
              setOpen(false);
            }}
          >
            <span className="menu-item-icon">
              {scope.kind === 'active' ? <Check size={13} /> : null}
            </span>
            <span className="menu-item-label">This project</span>
          </button>
          <button
            type="button"
            className={cn('menu-item', scope.kind === 'all' && 'menu-item-active')}
            onClick={() => {
              onChange({ kind: 'all' });
              setOpen(false);
            }}
          >
            <span className="menu-item-icon">
              {scope.kind === 'all' ? <Check size={13} /> : null}
            </span>
            <span className="menu-item-label">All projects</span>
          </button>

          <div className="menu-separator" />

          {projects.map((project) => {
            const checked =
              scope.kind === 'all' ||
              (scope.kind === 'pick' && scope.ids.includes(project.id));
            return (
              <button
                key={project.id}
                type="button"
                className="menu-item"
                onClick={() => toggleProject(project.id)}
              >
                <span className="menu-item-icon">
                  {checked ? <Check size={13} /> : null}
                </span>
                <span className="project-dot" style={{ backgroundColor: project.color }} />
                <span className="menu-item-label">{project.name}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** "2m ago"-style relative time for the undo history pop-over */
function undoAge(ts: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

/** Cheat-sheet for everything reachable from the keyboard in the Books manager. */
function BooksShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const rows: Array<[string, string, string]> = [
    ['⌘/Ctrl + F', 'Focus the search box', 'Search'],
    ['⌘/Ctrl + A', 'Select every file in the current view', 'Selection'],
    ['Click / checkbox', 'Select one file / add to selection', 'Selection'],
    ['⌘/Ctrl + C', 'Copy the selection', 'Clipboard'],
    ['⌘/Ctrl + X', 'Cut the selection', 'Clipboard'],
    ['⌘/Ctrl + V', 'Paste into the viewed folder or project', 'Clipboard'],
    ['Drag', 'Move files or folders onto any project, folder or file row', 'Drag & drop'],
    ['⌥/Alt + drag', 'Copy instead of move', 'Drag & drop'],
    ['Double-click', 'Open the file on the canvas', 'Files'],
    ['F2', 'Rename the selected file', 'Files'],
    ['⌫ / Delete', 'Remove the selection from the library', 'Files'],
    ['Esc', 'Cancel a cut, close dialogs', 'General'],
    ['?', 'Show this cheat-sheet', 'General'],
  ];
  const groups = ['Search', 'Selection', 'Clipboard', 'Drag & drop', 'Files', 'General'];

  return (
    <Dialog open={open} onClose={onClose} title="Books shortcuts" width={520}>
      <div className="books-help">
        <p className="books-help-intro">
          Files are referenced in place — removing them from the library never deletes the actual file,
          and every deletion can be undone from the bar at the bottom of the page.
        </p>
        {groups.map((group) => (
          <div key={group} className="books-help-group">
            <h4>{group}</h4>
            <table>
              <tbody>
                {rows
                  .filter(([, , g]) => g === group)
                  .map(([keys, description]) => (
                    <tr key={keys}>
                      <td>
                        <kbd>{keys}</kbd>
                      </td>
                      <td>{description}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </Dialog>
  );
}

export default function BooksTab() {
  const { hydrated, hydrate, projects, files, activeProjectId, selectedFileIds, setSelectedFiles, undoStack, undoLast, undoTo } = useBooks();
  const [searchQuery, setSearchQuery] = useState('');
  const [searchScope, setSearchScope] = useState<BooksSearchScope>({ kind: 'active' });
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  /** Shortcut cheat-sheet modal (Help button or "?") */
  const [helpOpen, setHelpOpen] = useState(false);
  /** Undo history pop-over, opened from the count chip in the toast */
  const [historyOpen, setHistoryOpen] = useState(false);
  /** ⌘F target: the search input ref, attached to the search field below */
  const searchInputRef = useRef<HTMLInputElement>(null);

  // The concrete project ids the search runs over; null means "the project being viewed".
  // Pick lists are pruned against live projects so deletions can't leave ghosts.
  const searchProjectIds = useMemo<string[] | null>(() => {
    if (searchScope.kind === 'active') return null;
    if (searchScope.kind === 'all') return projects.map((p) => p.id);
    const ids = searchScope.ids.filter((id) => projects.some((p) => p.id === id));
    return ids.length === 0 ? null : ids;
  }, [searchScope, projects]);

  // Deleting a project removes it from a hand-picked scope instead of leaving stale ids behind.
  useEffect(() => {
    setSearchScope((current) => {
      if (current.kind !== 'pick') return current;
      const ids = current.ids.filter((id) => projects.some((p) => p.id === id));
      if (ids.length === current.ids.length) return current;
      return ids.length === 0 ? { kind: 'active' } : { kind: 'pick', ids };
    });
  }, [projects]);

  useEffect(() => {
    if (!hydrated) void hydrate();
  }, [hydrated, hydrate]);

  // Copy / cut / paste for file selections. Read state through getState() so
  // the listener never needs re-binding while the tab is open.
  useEffect(() => {
    const isTypingTarget = (target: EventTarget | null) => {
      const el = target as HTMLElement | null;
      return (
        !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
      );
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (useBooks.getState().clipboard?.mode === 'cut') useBooks.getState().clearClipboard();
        setHelpOpen(false);
        setHistoryOpen(false);
        return;
      }

      if (!(event.metaKey || event.ctrlKey)) return;
      const key = event.key.toLowerCase();

      // ? — open the shortcut cheat-sheet (unless typing in a field)
      if (event.key === '?' && !isTypingTarget(event.target)) {
        event.preventDefault();
        setHelpOpen(true);
        return;
      }

      // ⌘/Ctrl+F — jump to the search box, no matter what has focus
      if (key === 'f') {
        event.preventDefault();
        searchInputRef.current?.focus();
        return;
      }

      if (key !== 'c' && key !== 'x' && key !== 'v') return;
      if (isTypingTarget(event.target)) return;

      const store = useBooks.getState();
      if (!store.activeProjectId) return;

      if (key === 'c' && store.selectedFileIds.length > 0) {
        event.preventDefault();
        store.copyToClipboard(store.selectedFileIds);
      } else if (key === 'x' && store.selectedFileIds.length > 0) {
        event.preventDefault();
        store.cutToClipboard(store.selectedFileIds);
      } else if (key === 'v' && store.clipboard && store.clipboard.fileIds.length > 0) {
        event.preventDefault();
        const count = store.pasteFromClipboard(store.activeProjectId, store.selectedFolderId);
        if (count === 0) alert('Those files are already in this location.');
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Newest destructive op sits at the end of the stack
  const lastUndo = undoStack[undoStack.length - 1] ?? null;

  // The toast fades out instead of vanishing when the history empties (last
  // entry undone, or dismissed): capture the departing label once, keep the
  // toast mounted for the exit animation, then drop it. Hooks must run on
  // every render — before the early returns below, never after them.
  const [exitLabel, setExitLabel] = useState<string | null>(null);
  const lastLabelRef = useRef<string | null>(null);
  const lastUndoId = lastUndo?.id ?? null;
  /** When the toast's ✕ was pressed (keyed to the entry it dismissed) */
  const [toastDismissedId, setToastDismissedId] = useState<string | null>(null);
  useEffect(() => {
    setToastDismissedId(null);
    if (lastUndo) {
      lastLabelRef.current = lastUndo.label;
      return;
    }
    // lastUndo just became null — if the component still holds a label, fade it out
    if (lastLabelRef.current) {
      setExitLabel(lastLabelRef.current);
      lastLabelRef.current = null;
    } else {
      setExitLabel(null);
    }
  }, [lastUndoId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!exitLabel) return;
    const timer = setTimeout(() => setExitLabel(null), 200);
    return () => clearTimeout(timer);
  }, [exitLabel]);
  const toastLabel = lastUndo?.label ?? exitLabel;
  const toastIsFading = !lastUndo && !!toastLabel;

  if (!isTauri()) {
    return (
      <div className="page page-center">
        <div className="empty-state">
          <FileStack size={44} strokeWidth={1.4} />
          <h2>Desktop app required</h2>
          <p>The Books manager needs the Annotate Studio desktop app to access your local files.</p>
        </div>
      </div>
    );
  }

  if (!hydrated) {
    return (
      <div className="page page-center">
        <div className="empty-state">
          <div className="spinner" />
          <p>Loading your library…</p>
        </div>
      </div>
    );
  }

  const activeProject = projects.find((p) => p.id === activeProjectId);
  const totalFiles = Object.keys(files).length;
  const detailsFileId = selectedFileIds.length === 1 ? selectedFileIds[0] : null;

  return (
    <div className="books-page">
      <header className="page-header books-header">
        <div>
          <h1>Books</h1>
          <p>
            {projects.length} project{projects.length === 1 ? '' : 's'} · {totalFiles} file
            {totalFiles === 1 ? '' : 's'} in your library
          </p>
        </div>
        <div className="page-actions">
          <SearchScopePicker
            scope={searchScope}
            projects={projects}
            activeProjectId={activeProjectId}
            onChange={setSearchScope}
          />
          <div className="search-field books-search">
            <Search size={15} />
            <input
              ref={searchInputRef}
              className="input"
              type="text"
              placeholder="Search files, tags, notes… (⌘F)"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              dir="auto"
            />
          </div>
          {/* Undo lives in the header permanently so it can always be found —
              the bottom toast is only feedback for the most recent action. */}
          <div className="books-undo-header">
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              onClick={undoLast}
              disabled={undoStack.length === 0}
              title={
                undoStack.length === 0
                  ? 'Nothing to undo — Undo appears here after you delete something'
                  : `Undo the most recent deletion (${undoStack.length} undoable)`
              }
            >
              <RotateCcw size={13} />
              Undo
            </button>
            <button
              type="button"
              className={cn('books-undo-history-btn', historyOpen && 'books-undo-history-btn-open')}
              onClick={() => setHistoryOpen((v) => !v)}
              disabled={undoStack.length === 0}
              aria-expanded={historyOpen}
              title={
                undoStack.length === 0
                  ? 'History appears here after you delete something'
                  : 'See everything that can still be undone'
              }
            >
              <History size={13} />
              History
              {undoStack.length > 0 && <span className="books-undo-history-chip">{undoStack.length}</span>}
            </button>

            {historyOpen && undoStack.length > 0 && (
              <div className="books-undo-history books-undo-history-header" role="dialog" aria-label="Undo history">
                <div className="books-undo-history-head">
                  <History size={13} />
                  <span>Undo history · newest first</span>
                  <button
                    type="button"
                    className="icon-btn icon-btn-sm books-undo-history-close"
                    onClick={() => setHistoryOpen(false)}
                    aria-label="Close undo history"
                  >
                    <X size={12} />
                  </button>
                </div>
                {[...undoStack].reverse().map((entry, index) => (
                  <div key={entry.id} className="books-undo-history-row">
                    <div className="books-undo-history-info">
                      <span className="books-undo-history-label">{entry.label}</span>
                      <span className="books-undo-history-time">
                        {index === 0 ? `${undoAge(entry.ts)} · latest` : undoAge(entry.ts)}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost books-undo-history-restore"
                      title={
                        index === 0
                          ? 'Undo just this action'
                          : `Undoes this action and the ${index} newer one${index === 1 ? '' : 's'} — the library returns to how it was right before it`
                      }
                      onClick={() => {
                        undoTo(entry.id);
                        setHistoryOpen(false);
                      }}
                    >
                      Restore
                    </button>
                  </div>
                ))}
                <p className="books-undo-history-hint">
                  “Restore” rewinds the library to exactly how it was just before that action happened.
                </p>
              </div>
            )}
          </div>
          <button
            type="button"
            className="icon-btn"
            onClick={() => setHelpOpen(true)}
            title="Keyboard shortcuts (?)"
            aria-label="Show Books keyboard shortcuts"
          >
            <HelpCircle size={16} />
          </button>
        </div>
      </header>

      <div className={cn('books-layout', detailsFileId && 'with-details')}>
        <aside className="books-panel">
          <BookTree newProjectOpen={newProjectOpen} onNewProjectOpenChange={setNewProjectOpen} />
        </aside>

        {activeProject ? (
          <>
            <section className="books-panel">
              <BookFileList
                projectId={activeProject.id}
                searchQuery={searchQuery}
                searchProjectIds={searchProjectIds}
              />
            </section>

            {detailsFileId && (
              <aside className="books-panel">
                <BookFileDetails fileId={detailsFileId} onClose={() => setSelectedFiles([])} />
              </aside>
            )}
          </>
        ) : (
          <div className="books-panel books-start">
            <div className="books-panel-empty">
              <FileStack size={44} strokeWidth={1.4} />
              <h4>Create your first project</h4>
              <p>
                Projects group your books, papers and notes. Files are referenced in place — nothing is
                copied or moved on disk.
              </p>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                style={{ marginTop: 8 }}
                onClick={() => setNewProjectOpen(true)}
              >
                <Plus size={14} />
                New project
              </button>
            </div>
          </div>
        )}
      </div>

      {toastLabel && !(toastDismissedId && toastDismissedId === lastUndoId) && (
        <div className={cn('books-undo-toast', toastIsFading && 'books-undo-toast-exit')} role="status" aria-live="polite">
          <span className="books-undo-label">{toastLabel}</span>
          <span className="books-undo-spacer" />
          {!toastIsFading && (
            <>
              <button
                type="button"
                className="btn btn-sm btn-ghost books-undo-btn"
                onClick={undoLast}
                title={undoStack.length > 1 ? 'Undo the most recent deletion' : 'Undo this deletion'}
              >
                <RotateCcw size={13} />
                Undo
              </button>
              <button
                type="button"
                className="icon-btn icon-btn-sm"
                onClick={() => setToastDismissedId(lastUndoId)}
                aria-label="Hide this notification"
                title="Hide — Undo and History stay available in the header"
              >
                <X size={13} />
              </button>
            </>
          )}
        </div>
      )}

      <BooksShortcutsDialog open={helpOpen} onClose={() => setHelpOpen(false)} />
    </div>
  );
}
