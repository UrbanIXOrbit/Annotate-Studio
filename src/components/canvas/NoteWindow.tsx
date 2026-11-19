'use client';

import React, { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Bold,
  ChevronDown,
  ChevronRight,
  Code,
  Columns2,
  Eye,
  FileDown,
  Ghost,
  Heading2,
  Italic,
  Link2,
  List,
  ListChecks,
  ListOrdered,
  Loader2,
  PenLine,
  Quote,
  Sigma,
} from 'lucide-react';
import MarkdownEditor, { type MarkdownEditorHandle } from '@/components/markdown/MarkdownEditor';
import MarkdownRenderer from '@/components/markdown/MarkdownRenderer';
import { openContextMenu } from '@/components/ui/ContextMenu';
import { noteExportMenu } from '@/lib/note-export-actions';
import { lineForLink } from '@/lib/link-graph';
import { useNotes } from '@/store/notes';
import { useLibrary } from '@/store/library';
import { activeWorkspace, useCanvas } from '@/store/canvas';
import { computeGraph, useGraph } from '@/store/graph';
import { openFileOnCanvas, openWikiLink } from '@/lib/workspace-actions';
import { cn } from '@/lib/utils';

type Mode = 'edit' | 'split' | 'preview';

const modeMemory = new Map<string, Mode>();
/** Whether the backlinks strip is open, remembered per window. */
const linksMemory = new Map<string, boolean>();

function wordCount(text: string): number {
  const words = text.trim().match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu);
  return words ? words.length : 0;
}

/** Collapsible strip under the note body: what links here, and the note's
 * dangling links. Rows open the target next to this window. */
function BacklinksPanel({
  resourceId,
  backlinks,
  unresolved,
  docs,
}: {
  resourceId: string;
  path: string;
  backlinks: { from: string; target: string }[];
  unresolved: string[];
  docs: Map<string, { path: string; title: string; markdown: string }>;
}) {
  // null = follow automatically (open once the note has backlinks).
  const [choice, setChoice] = useState<boolean | null>(() => {
    const remembered = linksMemory.get(resourceId);
    return remembered === undefined ? null : remembered;
  });
  const open = choice ?? backlinks.length > 0;
  const toggle = () => {
    const next = !open;
    linksMemory.set(resourceId, next);
    setChoice(next);
  };

  return (
    <div className="note-links" data-no-drag>
      <button type="button" className="note-links-toggle" onClick={toggle} aria-expanded={open}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <Link2 size={12} />
        Links here ({backlinks.length})
        {unresolved.length > 0 && <span className="note-links-phantom-count">{unresolved.length} unresolved</span>}
      </button>
      {open && (
        <div className="note-links-body">
          {backlinks.length === 0 && <div className="note-links-empty">No notes link here yet — write [[This note's name]] elsewhere.</div>}
          {backlinks.map((link, index) => {
            const doc = docs.get(link.from);
            const snippet = doc ? lineForLink(doc.markdown, link.target) : '';
            return (
              <button
                key={`${link.from}:${link.target}:${index}`}
                type="button"
                className="note-links-row"
                title={`Open “${doc?.title ?? link.from}”`}
                onClick={() => {
                  const file = useLibrary.getState().files.find((candidate) => candidate.path === link.from);
                  if (file) openFileOnCanvas(file, { near: resourceId });
                }}
              >
                <span className="note-links-row-title">{doc?.title ?? link.from}</span>
                {snippet && <span className="note-links-row-snippet">{snippet}</span>}
              </button>
            );
          })}
          {unresolved.length > 0 && (
            <>
              <div className="note-links-section">
                <Ghost size={12} /> Unresolved links — notes that don't exist yet
              </div>
              {unresolved.map((target) => (
                <button key={target} type="button" className="note-links-row note-links-row-phantom" onClick={() => void openWikiLink(target, resourceId)}>
                  <span className="note-links-row-title">{target}</span>
                  <span className="note-links-row-hint">Create or open…</span>
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function NoteWindow({ resourceId, path, title }: { resourceId: string; path: string; title: string }) {
  const buffer = useNotes((state) => state.buffers[path]);
  // Keep typing responsive: re-parse the preview only when React can afford it.
  const previewContent = useDeferredValue(buffer?.content ?? '');
  const load = useNotes((state) => state.load);
  const edit = useNotes((state) => state.edit);
  const save = useNotes((state) => state.save);
  const width = useCanvas((state) => activeWorkspace(state).resources.find((r) => r.id === resourceId)?.width ?? 700);
  const maximized = useCanvas((state) => activeWorkspace(state).resources.find((r) => r.id === resourceId)?.maximized ?? false);
  const [mode, setModeState] = useState<Mode>(() => modeMemory.get(resourceId) ?? (width >= 760 ? 'split' : 'edit'));
  const editorRef = useRef<MarkdownEditorHandle>(null);
  // Backlinks/graph index: recomputed when the index revision changes or the
  // window moves to another file (typing updates it on the next debounced save).
  const revision = useGraph((state) => state.revision);
  const links = useMemo(() => {
    const model = computeGraph();
    const outgoing = model.outgoing.get(path) ?? [];
    const unresolved = [...new Set(outgoing.filter((link) => !link.resolved).map((link) => link.target))];
    return {
      backlinks: (model.backlinks.get(path) ?? []).filter((link) => link.resolved),
      unresolved,
      docs: model.docs,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision, path]);

  const setMode = (next: Mode) => {
    modeMemory.set(resourceId, next);
    setModeState(next);
  };

  useEffect(() => {
    void load(path);
  }, [load, path]);

  const getFiles = useCallback(() => useLibrary.getState().files, []);
  const onChange = useCallback((value: string) => edit(path, value), [edit, path]);
  const onSave = useCallback(() => void save(path), [save, path]);

  if (!buffer || buffer.status === 'loading') {
    return (
      <div className="cw-state">
        <Loader2 size={18} className="spin" />
        <div>Loading {title}…</div>
      </div>
    );
  }
  if (buffer.status === 'error') {
    return (
      <div className="cw-state cw-state-error">
        <AlertTriangle size={20} />
        <div>{buffer.error ?? 'This note could not be opened.'}</div>
      </div>
    );
  }

  const canSplit = width >= 560 || maximized;
  const view: Mode = mode === 'split' && !canSplit ? 'edit' : mode;
  const showEditor = view !== 'preview';
  const showPreview = view !== 'edit';
  const status = buffer.error
    ? 'Not saved'
    : buffer.conflict
      ? 'Conflict'
      : buffer.saving
        ? 'Saving…'
        : buffer.dirty
          ? 'Unsaved changes'
          : buffer.savedAt
            ? 'Saved'
            : '';

  const format = (action: () => void) => (event: React.MouseEvent) => {
    event.preventDefault();
    action();
  };

  return (
    <div className="note-window">
      <div className="note-toolbar" data-no-drag>
        <div className="segmented">
          <button type="button" className={cn(mode === 'edit' && 'active')} onClick={() => setMode('edit')} title="Edit">
            <PenLine size={13} />
          </button>
          <button
            type="button"
            className={cn(mode === 'split' && 'active')}
            onClick={() => setMode('split')}
            title={canSplit ? 'Split view' : 'Split view (widen the window to see the preview)'}
          >
            <Columns2 size={13} />
          </button>
          <button type="button" className={cn(mode === 'preview' && 'active')} onClick={() => setMode('preview')} title="Preview">
            <Eye size={13} />
          </button>
        </div>
        {showEditor && buffer.editable && (
          <div className="note-format">
            <button type="button" className="tool-btn" onMouseDown={format(() => editorRef.current?.wrap('**'))} title="Bold (Ctrl+B)">
              <Bold size={14} />
            </button>
            <button type="button" className="tool-btn" onMouseDown={format(() => editorRef.current?.wrap('*'))} title="Italic (Ctrl+I)">
              <Italic size={14} />
            </button>
            <button type="button" className="tool-btn" onMouseDown={format(() => editorRef.current?.prefixLines('## '))} title="Heading">
              <Heading2 size={14} />
            </button>
            <button type="button" className="tool-btn" onMouseDown={format(() => editorRef.current?.prefixLines('- '))} title="Bulleted list">
              <List size={14} />
            </button>
            <button type="button" className="tool-btn" onMouseDown={format(() => editorRef.current?.prefixLines('1. '))} title="Numbered list">
              <ListOrdered size={14} />
            </button>
            <button type="button" className="tool-btn" onMouseDown={format(() => editorRef.current?.prefixLines('- [ ] '))} title="Checklist">
              <ListChecks size={14} />
            </button>
            <button type="button" className="tool-btn" onMouseDown={format(() => editorRef.current?.prefixLines('> '))} title="Quote">
              <Quote size={14} />
            </button>
            <button type="button" className="tool-btn" onMouseDown={format(() => editorRef.current?.wrap('`', '`', 'code'))} title="Inline code (Ctrl+E)">
              <Code size={14} />
            </button>
            <button type="button" className="tool-btn" onMouseDown={format(() => editorRef.current?.wrap('$', '$', 'x^2'))} title="Math">
              <Sigma size={14} />
            </button>
            <button type="button" className="tool-btn" onMouseDown={format(() => editorRef.current?.wrap('[[', ']]', 'Note'))} title="Link a note">
              <Link2 size={14} />
            </button>
          </div>
        )}
        <div className="note-toolbar-spacer" />
        <button
          type="button"
          className="tool-btn"
          title="Export this note (Markdown, text, Word, PDF)"
          onClick={(event) =>
            openContextMenu(
              event,
              noteExportMenu(() => ({ title: path.split(/[\\/]/).pop() || 'Note', content: useNotes.getState().buffers[path]?.content ?? buffer.content })),
            )
          }
        >
          <FileDown size={14} />
        </button>
        <span className="note-meta">{wordCount(buffer.content)} words</span>
        {buffer.error && buffer.dirty && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => void useNotes.getState().retrySave(path)}
            title="Try saving again"
          >
            Retry save
          </button>
        )}
        <span className={cn('save-state', buffer.error ? 'save-state-error' : buffer.dirty || buffer.saving ? 'save-state-pending' : 'save-state-saved')}>
          {status}
        </span>
      </div>
      {!buffer.editable && (
        <div className="note-readonly">
          <AlertTriangle size={13} /> This file is not UTF-8 text, so it opens read-only to keep its characters intact.
        </div>
      )}
      {buffer.conflict && (
        <div className="note-readonly" role="alert">
          <AlertTriangle size={13} />
          <span>This note changed on disk while you were editing. Choose which version to keep.</span>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => void useNotes.getState().resolveConflict(path, 'keep')}>
            Keep my changes
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void useNotes.getState().resolveConflict(path, 'disk')}>
            Use disk version
          </button>
        </div>
      )}
      <div className={cn('note-body', view === 'split' && 'note-body-split')}>
        <div className={cn('note-pane note-editor-pane', !showEditor && 'note-pane-hidden')}>
          <MarkdownEditor
            ref={editorRef}
            value={buffer.content}
            onChange={onChange}
            onSave={onSave}
            getFiles={getFiles}
            readOnly={!buffer.editable}
            placeholder="Start writing… Use [[ to link notes, $…$ for math"
          />
        </div>
        {showPreview && (
          <div className="note-pane note-preview-pane content-selectable">
            {buffer.content.trim() ? (
              <MarkdownRenderer content={previewContent} sourceId={resourceId} />
            ) : (
              <div className="note-empty">Nothing to preview yet.</div>
            )}
          </div>
        )}
      </div>
      {links && (links.backlinks.length > 0 || links.unresolved.length > 0) && (
        <BacklinksPanel resourceId={resourceId} path={path} backlinks={links.backlinks} unresolved={links.unresolved} docs={links.docs} />
      )}
    </div>
  );
}

export default memo(NoteWindow);
