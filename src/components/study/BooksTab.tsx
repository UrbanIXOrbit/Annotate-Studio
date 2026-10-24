'use client';

import React, { useEffect, useState } from 'react';
import { useBooks } from '@/store/books';
import { BookTree } from './books/BookTree';
import { BookFileList } from './books/BookFileList';
import { BookFileDetails } from './books/BookFileDetails';
import { isTauri } from '@/lib/tauri-commands';
import { FileStack, Plus, Search } from 'lucide-react';
import { cn } from '@/lib/utils';

export default function BooksTab() {
  const { hydrated, hydrate, projects, files, activeProjectId, selectedFileIds, setSelectedFiles } = useBooks();
  const [searchQuery, setSearchQuery] = useState('');
  const [newProjectOpen, setNewProjectOpen] = useState(false);

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
              <BookFileList projectId={activeProject.id} searchQuery={searchQuery} />
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
