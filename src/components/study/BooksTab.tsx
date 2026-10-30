'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useBooks, type BookProject } from '@/store/books';
import { BookTree } from './books/BookTree';
import { BookFileList } from './books/BookFileList';
import { BookFileDetails } from './books/BookFileDetails';
import { isTauri } from '@/lib/tauri-commands';
import { Check, ChevronDown, FileStack, FolderSearch, Plus, Search } from 'lucide-react';
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

export default function BooksTab() {
  const { hydrated, hydrate, projects, files, activeProjectId, selectedFileIds, setSelectedFiles } = useBooks();
  const [searchQuery, setSearchQuery] = useState('');
  const [searchScope, setSearchScope] = useState<BooksSearchScope>({ kind: 'active' });
  const [newProjectOpen, setNewProjectOpen] = useState(false);

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
        return;
      }

      if (!(event.metaKey || event.ctrlKey)) return;
      const key = event.key.toLowerCase();
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
              className="input"
              type="text"
              placeholder="Search files, tags, notes…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              dir="auto"
            />
          </div>
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
    </div>
  );
}
