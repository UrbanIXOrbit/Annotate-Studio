'use client';

import React, { useEffect, useMemo, useState } from 'react';
import {
  BookOpen,
  BookOpenCheck,
  BookText,
  ExternalLink,
  FileImage,
  FileText,
  FileType2,
  Film,
  FolderOpen,
  Headphones,
  Inbox,
  Layers,
  MoreHorizontal,
  NotebookPen,
  Network,
  Pencil,
  RefreshCw,
  ScrollText,
  Search,
  Star,
  Tag,
  TextSearch,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { openContextMenu, type MenuEntry } from '@/components/ui/ContextMenu';
import { currentNoteText, noteExportMenu } from '@/lib/note-export-actions';
import { allTags, matchFile, parseTagInput, tagUsageCount, type CollectionCriteria, type FileMeta, type SavedCollection } from '@/lib/library-metadata';
import { useLibrary } from '@/store/library';
import { useSettings } from '@/store/settings';
import { useToasts } from '@/store/toast';
import { setCurrentWorkspace } from '@/store/workspace-context';
import { useApp } from '@/store/app';
import { activeWorkspace, useCanvas } from '@/store/canvas';
import { useWorkspaceScopes } from '@/store/workspace-scopes';
import { useSearch } from '@/store/search';
import { useGraph } from '@/store/graph';
import { openInboxSection } from '@/lib/scratch-actions';
import ReportCompilerDialog from '@/components/study/ReportCompilerDialog';
import { confirmDialog, promptDialog } from '@/store/dialogs';
import type { FileType, StudyFile } from '@/lib/tauri-commands';
import {
  createNewNote,
  deleteFile,
  displayTitle,
  openFileOnCanvas,
  pickAndImport,
  renameFile,
  resourceTypeFor,
  revealInExplorer,
  resolveNoteFolder,
} from '@/lib/workspace-actions';
import { cn, formatBytes, formatRelativeTime, isExternalPath, stripExtension } from '@/lib/utils';

const EMPTY_FILE_META: Record<string, FileMeta> = {};
const EMPTY_FILE_META_RECENT: Record<string, number> = {};
const EMPTY_COLLECTIONS: SavedCollection[] = [];

type Filter = 'all' | 'pdf' | 'notes' | 'images' | 'audio' | 'books' | 'videos' | 'documents';
type Sort = 'recent' | 'modified' | 'name' | 'size';

const FILTERS: { id: Filter; label: string; types: FileType[] }[] = [
  { id: 'all', label: 'All', types: [] },
  { id: 'pdf', label: 'PDFs', types: ['Pdf'] },
  { id: 'notes', label: 'Notes', types: ['Markdown', 'Text'] },
  { id: 'images', label: 'Images', types: ['Image'] },
  { id: 'audio', label: 'Audio', types: ['Audio'] },
  { id: 'books', label: 'Books', types: ['Book'] },
  { id: 'videos', label: 'Videos', types: ['Video'] },
  { id: 'documents', label: 'Documents', types: ['Document'] },
];

const TYPE_META: Record<FileType, { label: string; icon: React.ReactNode; tone: string }> = {
  Pdf: { label: 'PDF', icon: <FileText size={26} />, tone: 'tone-red' },
  Markdown: { label: 'Note', icon: <NotebookPen size={26} />, tone: 'tone-blue' },
  Text: { label: 'Text', icon: <FileType2 size={26} />, tone: 'tone-slate' },
  Image: { label: 'Image', icon: <FileImage size={26} />, tone: 'tone-green' },
  Book: { label: 'Book', icon: <BookOpen size={26} />, tone: 'tone-amber' },
  Video: { label: 'Video', icon: <Film size={26} />, tone: 'tone-violet' },
  Audio: { label: 'Audio', icon: <Headphones size={26} />, tone: 'tone-teal' },
  Document: { label: 'Doc', icon: <FileType2 size={26} />, tone: 'tone-violet' },
  Unknown: { label: 'File', icon: <FileText size={26} />, tone: 'tone-slate' },
};

/** Map a criteria's fileTypes back onto the filter chips; unknown sets stay on All. */
function filterForTypes(fileTypes: string[] | undefined): Filter {
  if (!fileTypes || fileTypes.length === 0) return 'all';
  return FILTERS.find((entry) => entry.types.length === fileTypes.length && entry.types.every((type) => fileTypes.includes(type)))?.id ?? 'all';
}

/** Inline tags + note editor on a file card. */
function FileMetaEditor({
  meta,
  onSave,
  onClose,
}: {
  meta: FileMeta;
  onSave: (tags: string[], note: string) => void;
  onClose: () => void;
}) {
  const [tagsText, setTagsText] = useState(meta.tags.join(', '));
  const [noteText, setNoteText] = useState(meta.note ?? '');
  return (
    <div className="file-card-editor" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
      <div className="file-card-editor-row">
        <Tag size={13} />
        <input
          className="input input-sm"
          value={tagsText}
          placeholder="Tags, comma separated"
          onChange={(event) => setTagsText(event.target.value)}
          onKeyDown={(event) => event.key === 'Enter' && onSave(parseTagInput(tagsText), noteText)}
          dir="auto"
        />
      </div>
      <textarea
        className="textarea input-sm file-card-editor-note"
        value={noteText}
        placeholder="Private note about this file…"
        onChange={(event) => setNoteText(event.target.value)}
        rows={2}
        dir="auto"
      />
      <div className="file-card-editor-actions">
        <button type="button" className="btn btn-sm btn-primary" onClick={() => onSave(parseTagInput(tagsText), noteText.trim())}>
          Save
        </button>
        <button type="button" className="btn btn-sm btn-ghost" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export default function LibraryTab() {
  const files = useLibrary((state) => state.files);
  const allFiles = useLibrary((state) => state.allFiles);
  const allWorkspaces = useWorkspaceScopes((state) => state.allWorkspaces);
  const allScopes = useWorkspaceScopes((state) => state.scopes);
  const loading = useLibrary((state) => state.loading);
  const refresh = useLibrary((state) => state.refresh);
  const activeWorkspaceId = useCanvas((state) => state.activeWorkspaceId);
  const activeScope = useWorkspaceScopes((state) => state.scopes[activeWorkspaceId]);
  const recent = activeScope?.recentFiles ?? EMPTY_FILE_META_RECENT;
  const fileMeta = activeScope?.fileMeta ?? EMPTY_FILE_META;
  const collections = activeScope?.collections ?? EMPTY_COLLECTIONS;
  const { toggleFileStar, setFileMeta, createCollection, updateCollection, deleteCollection, renameTagEverywhere, removeTagEverywhere } = useSettings.getState();
  const firstRunSeen = useSettings((state) => state.firstRunSeen);
  const resources = useCanvas((state) => activeWorkspace(state).resources);
  const openSet = useMemo(() => new Set(resources.map((r) => r.filePath).filter((p): p is string => Boolean(p))), [resources]);
  const setView = useApp((state) => state.setView);
  const requestChat = useApp((state) => state.requestChat);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<Sort>('recent');
  const [tagFilter, setTagFilter] = useState<string[]>([]);
  const [starredOnly, setStarredOnly] = useState(false);
  const [activeCollectionId, setActiveCollectionId] = useState<string | null>(null);
  const [editingPath, setEditingPath] = useState<string | null>(null);
  const [compileOpen, setCompileOpen] = useState(false);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // The criteria of the current manual controls; a collection is the same
  // shape saved under a name, so both paths share the matcher.
  const currentCriteria = useMemo<CollectionCriteria>(() => {
    const types = FILTERS.find((f) => f.id === filter)?.types ?? [];
    return {
      ...(types.length > 0 ? { fileTypes: types } : {}),
      ...(query.trim() ? { query: query.trim() } : {}),
      ...(tagFilter.length > 0 ? { tags: tagFilter } : {}),
      ...(starredOnly ? { starred: true } : {}),
    };
  }, [filter, query, tagFilter, starredOnly]);

  const activeCollection = activeCollectionId ? collections.find((collection) => collection.id === activeCollectionId) ?? null : null;

  const visible = useMemo(() => {
    const criteria = activeCollection ? activeCollection.criteria : currentCriteria;
    const source = allWorkspaces ? allFiles : files;
    const list = source.filter((file) => matchFile(file, fileMeta[file.path], criteria));
    return [...list].sort((a, b) => {
      switch (sort) {
        case 'name':
          return a.name.localeCompare(b.name);
        case 'size':
          return b.size - a.size;
        case 'modified':
          return b.modified_at.localeCompare(a.modified_at);
        default:
          return (recent[b.path] ?? Date.parse(b.modified_at)) - (recent[a.path] ?? Date.parse(a.modified_at));
      }
    });
  }, [files, allFiles, allWorkspaces, fileMeta, currentCriteria, activeCollection, sort, recent]);

  const ownerNames = useMemo(() => {
    const workspaces = useCanvas.getState().workspaces;
    const names = new Map(workspaces.map((workspace) => [workspace.id, workspace.name]));
    const map = new Map<string, string>();
    for (const [id, scope] of Object.entries(allScopes)) {
      for (const path of scope.files) if (!map.has(path)) map.set(path, names.get(id) ?? 'Workspace');
    }
    return map;
  }, [allScopes]);

  const tags = useMemo(() => allTags(fileMeta), [fileMeta]);
  const starredCount = useMemo(() => Object.values(fileMeta).filter((meta) => meta.starred).length, [fileMeta]);
  const filtersActive = Boolean(query.trim()) || filter !== 'all' || tagFilter.length > 0 || starredOnly;

  const applyCollection = (collection: SavedCollection) => {
    setActiveCollectionId(collection.id);
    setQuery(collection.criteria.query ?? '');
    setFilter(filterForTypes(collection.criteria.fileTypes));
    setTagFilter(collection.criteria.tags ?? []);
    setStarredOnly(collection.criteria.starred === true);
  };
  const clearCollection = () => {
    setActiveCollectionId(null);
    setQuery('');
    setFilter('all');
    setTagFilter([]);
    setStarredOnly(false);
  };

  const saveCurrentSearch = async () => {
    const name = await promptDialog({
      title: 'Save collection',
      label: 'Name',
      placeholder: 'e.g. Exam prep papers',
      confirmLabel: 'Save',
    });
    if (!name) return;
    createCollection(name, currentCriteria);
  };

  const open = (file: StudyFile) => {
    // In the global view, a file belongs to another workspace — switch there
    // before opening it so the window lands on the canvas that owns it.
    if (allWorkspaces) {
      const owners = Object.entries(allScopes)
        .filter(([, scope]) => scope.files.includes(file.path))
        .map(([id]) => id);
      const owner = owners.includes(activeWorkspaceId) ? activeWorkspaceId : owners[0];
      if (owner && owner !== activeWorkspaceId) {
        useCanvas.getState().switchWorkspace(owner);
        setCurrentWorkspace(owner);
      }
    }
    if (!resourceTypeFor(file)) {
      requestChat({ kind: 'summarize', title: file.name, path: file.path });
      return;
    }
    if (openFileOnCanvas(file)) setView('canvas');
  };

  const rename = async (file: StudyFile) => {
    const name = await promptDialog({
      title: 'Rename file',
      initialValue: file.file_type === 'Markdown' ? stripExtension(file.name) : file.name,
      selectBaseName: file.file_type !== 'Markdown',
      confirmLabel: 'Rename',
    });
    if (name) await renameFile(file.path, name);
  };

  const remove = async (file: StudyFile) => {
    const external = isExternalPath(file.path);
    const ok = await confirmDialog({
      title: external ? `Remove “${file.name}” from the library?` : `Delete “${file.name}”?`,
      message: external
        ? 'The file stays on your device at its own path; only the library reference is removed. This cannot be undone here.'
        : 'The file is removed from your workspace and closed on every canvas. This cannot be undone.',
      confirmLabel: external ? 'Remove from library' : 'Delete file',
      danger: true,
    });
    if (ok) await deleteFile(file.path);
  };

  const menuFor = (file: StudyFile): MenuEntry[] => {
    if (allWorkspaces) return [{ label: 'View only — switch to the owning workspace to edit', disabled: true, onSelect: () => undefined }];
    const meta = fileMeta[file.path];
    const items: MenuEntry[] = [];
    if (resourceTypeFor(file)) items.push({ label: 'Open on canvas', icon: <ExternalLink size={13} />, onSelect: () => open(file) });
    items.push({
      label: meta?.starred ? 'Unstar' : 'Star',
      icon: <Star size={13} className={meta?.starred ? 'starred-icon' : undefined} />,
      onSelect: () => toggleFileStar(file.path),
    });
    items.push({ label: 'Tags & note…', icon: <Tag size={13} />, onSelect: () => setEditingPath(file.path) });
    if (file.file_type !== 'Image' && file.file_type !== 'Audio') {
      items.push(
        'separator',
        { label: 'Summarize with AI', icon: <ScrollText size={13} />, onSelect: () => requestChat({ kind: 'summarize', title: file.name, path: file.path }) },
        { label: 'Explain step by step', icon: <BookOpenCheck size={13} />, onSelect: () => requestChat({ kind: 'explain', topic: displayTitle(file), path: file.path }) },
        { label: 'Make flashcards', icon: <Layers size={13} />, onSelect: () => requestChat({ kind: 'flashcards', title: file.name, text: '', path: file.path }) },
      );
    }
    if (file.file_type === 'Markdown' || file.file_type === 'Text') {
      items.push('separator', ...noteExportMenu(async () => ({ title: file.name, content: await currentNoteText(file.path) }), 'Export as '));
    }
    const workspaces = useCanvas.getState().workspaces;
    if (workspaces.length > 1) {
      items.push(
        'separator',
        ...workspaces
          .filter((workspace) => workspace.id !== activeWorkspaceId)
          .map((workspace) => ({
            label: `Move to ${workspace.name}`,
            icon: <Layers size={13} />,
            onSelect: () => {
              useWorkspaceScopes.getState().moveFile(file.path, activeWorkspaceId, workspace.id);
              void useLibrary.getState().reloadForWorkspace();
              useToasts.getState().push({ kind: 'success', title: `Moved to ${workspace.name}` });
            },
          })),
      );
    }
    items.push('separator', { label: 'View in explorer', icon: <FolderOpen size={13} />, onSelect: () => void revealInExplorer(file.path) });
    items.push(
      { label: 'Rename…', icon: <Pencil size={13} />, onSelect: () => void rename(file) },
      isExternalPath(file.path)
        ? { label: 'Remove from library', icon: <Trash2 size={13} />, danger: true, onSelect: () => void remove(file) }
        : { label: 'Delete…', icon: <Trash2 size={13} />, danger: true, onSelect: () => void remove(file) },
    );
    return items;
  };

  const tagMenu = (tag: string): MenuEntry[] => {
    const count = tagUsageCount(fileMeta, tag);
    return [
      {
        label: `Rename everywhere (${count} file${count === 1 ? '' : 's'})…`,
        icon: <Pencil size={13} />,
        onSelect: async () => {
          const name = await promptDialog({
            title: `Rename “${tag}” on all files`,
            initialValue: tag,
            confirmLabel: 'Rename',
            validate: (value) => (value.trim() ? null : 'Please enter a tag name'),
          });
          if (name) renameTagEverywhere(tag, name);
        },
      },
      {
        label: `Remove from all files (${count})`,
        icon: <Trash2 size={13} />,
        danger: true,
        onSelect: async () => {
          const ok = await confirmDialog({
            title: `Remove “${tag}” everywhere?`,
            message: `The tag is taken off ${count} file${count === 1 ? '' : 's'}. Files and their other tags are not touched.`,
            confirmLabel: 'Remove tag',
            danger: true,
          });
          if (ok) {
            removeTagEverywhere(tag);
            setTagFilter((current) => current.filter((entry) => entry.toLowerCase() !== tag.toLowerCase()));
          }
        },
      },
    ];
  };

  const collectionMenu = (collection: SavedCollection): MenuEntry[] => [
    { label: 'Show results', icon: <Search size={13} />, onSelect: () => applyCollection(collection) },
    {
      label: 'Rename…',
      icon: <Pencil size={13} />,
      onSelect: async () => {
        const name = await promptDialog({ title: 'Rename collection', initialValue: collection.name, confirmLabel: 'Rename' });
        if (name) updateCollection(collection.id, { name });
      },
    },
    {
      label: 'Delete collection',
      icon: <Trash2 size={13} />,
      danger: true,
      onSelect: async () => {
        const ok = await confirmDialog({ title: `Delete “${collection.name}”?`, message: 'The collection is only a saved filter — files are not touched.', confirmLabel: 'Delete', danger: true });
        if (ok) {
          deleteCollection(collection.id);
          if (activeCollectionId === collection.id) clearCollection();
        }
      },
    },
  ];

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Library</h1>
          <p>
            {files.length} file{files.length === 1 ? '' : 's'} in your workspace
          </p>
        </div>
        <div className="page-actions">
          <button type="button" className="btn btn-ghost" onClick={() => void refresh()} title="Refresh">
            <RefreshCw size={15} className={loading ? 'spin' : undefined} />
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            title="Compile notes, highlights and bibliography into one report"
            onClick={() => setCompileOpen(true)}
          >
            <BookText size={15} /> Compile
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            title="Knowledge graph — see what links to what"
            onClick={() => useGraph.getState().show()}
          >
            <Network size={15} /> Graph
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            title="Open the Inbox board where quick captures land"
            onClick={() => openInboxSection()}
          >
            <Inbox size={15} /> Inbox
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={async () => {
              const file = await createNewNote();
              if (file) setView('canvas');
            }}
          >
            <NotebookPen size={15} /> New note
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void pickAndImport('any')}>
            <Upload size={15} /> Open external files
          </button>
        </div>
      </header>

      <div className="library-controls">
        <div className="search-field">
          <Search size={15} />
          <input
            className="input"
            value={query}
            placeholder="Search names, tags, notes…"
            onChange={(event) => {
              setQuery(event.target.value);
              // A saved collection overrides the manual criteria; editing the
              // search must switch back to the live controls.
              setActiveCollectionId(null);
            }}
            dir="auto"
          />
        </div>
        <button
          type="button"
          className="btn btn-ghost library-search-contents"
          title="Search inside notes, PDFs and books (⌘K / Ctrl+K)"
          onClick={() => useSearch.getState().show()}
        >
          <TextSearch size={15} /> Search contents <kbd>⌘K</kbd>
        </button>
        <div className="segmented">
          {FILTERS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={cn(filter === entry.id && 'active')}
              onClick={() => {
                setFilter(entry.id);
                setActiveCollectionId(null);
              }}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <select className="select" value={sort} onChange={(event) => setSort(event.target.value as Sort)} aria-label="Sort files">
          <option value="recent">Recently opened</option>
          <option value="modified">Last modified</option>
          <option value="name">Name</option>
          <option value="size">Size</option>
        </select>
      </div>

      {(collections.length > 0 || filtersActive || tags.length > 0 || starredCount > 0) && (
        <div className="library-facets" role="toolbar" aria-label="Collections and tags">
          <span className="library-facets-label">Collections</span>
          {collections.map((collection) => (
            <button
              key={collection.id}
              type="button"
              className={cn('facet-chip', activeCollectionId === collection.id && 'facet-chip-active')}
              onClick={() => applyCollection(collection)}
              onContextMenu={(event) => openContextMenu(event, collectionMenu(collection))}
              title={`${collection.name} — right-click to rename or delete`}
            >
              <Search size={11} />
              {collection.name}
            </button>
          ))}
          {filtersActive && (
            <button type="button" className="facet-chip facet-chip-action" onClick={() => void saveCurrentSearch()} title="Save the current filters as a collection">
              Save this search
            </button>
          )}
          {activeCollection && (
            <button type="button" className="facet-chip facet-chip-clear" onClick={clearCollection} title="Stop using this collection">
              <X size={11} /> Clear
            </button>
          )}
          {tags.length > 0 && <span className="library-facets-label">Tags</span>}
          {starredCount > 0 && (
            <button
              type="button"
              className={cn('facet-chip', starredOnly && 'facet-chip-active')}
              onClick={() => {
                setStarredOnly((current) => !current);
                setActiveCollectionId(null);
              }}
            >
              <Star size={11} className={starredOnly ? 'starred-icon' : undefined} />
              Starred
            </button>
          )}
          {tags.map((tag) => {
            const active = tagFilter.some((entry) => entry.toLowerCase() === tag.toLowerCase());
            return (
              <button
                key={tag}
                type="button"
                className={cn('facet-chip facet-chip-tag', active && 'facet-chip-active')}
                onClick={() => {
                  setTagFilter((current) => (active ? current.filter((entry) => entry.toLowerCase() !== tag.toLowerCase()) : [...current, tag]));
                  setActiveCollectionId(null);
                }}
                onContextMenu={(event) => openContextMenu(event, tagMenu(tag))}
                title={`${tag} — click to filter, right-click to rename or remove everywhere`}
              >
                <Tag size={11} />
                {tag}
              </button>
            );
          })}
          {(tagFilter.length > 0 || starredOnly) && activeCollection === null && (
            <button
              type="button"
              className="facet-chip facet-chip-clear"
              onClick={() => {
                setTagFilter([]);
                setStarredOnly(false);
              }}
            >
              <X size={11} /> Clear
            </button>
          )}
        </div>
      )}

      {!firstRunSeen && (
        <div className="settings-card">
          <h3>Welcome to Annotate Studio</h3>
          <p className="muted">Your files stay where they are — the library only references them. Pick a notes folder for captures, or look at the keyboard shortcuts to get around.</p>
          <div className="page-actions">
            <button type="button" className="btn btn-primary" onClick={() => void resolveNoteFolder().then((folder) => { if (folder) useSettings.getState().update({ noteFolder: folder }); })}>
              <FolderOpen size={14} /> Choose notes folder
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => window.dispatchEvent(new Event('annotate:show-shortcuts'))}>See shortcuts</button>
            <button type="button" className="btn btn-ghost" onClick={() => useSettings.getState().dismissFirstRun()}>Got it</button>
          </div>
        </div>
      )}
      {visible.length === 0 ? (
        <div className="empty-state">
          <FolderOpen size={40} strokeWidth={1.4} />
          <h2>{filtersActive || activeCollection ? 'No matching files' : 'Your library is empty'}</h2>
          <p>{filtersActive || activeCollection ? 'Try another search or filter.' : 'Open PDFs, audio, images or notes from where they live, or drop files onto the window.'}</p>
          {!filtersActive && !activeCollection && (
            <div className="empty-actions">
              <button type="button" className="btn btn-primary" onClick={() => void pickAndImport('any')}>
                <FolderOpen size={15} /> Open external files
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => void createNewNote()}>
                <BookText size={15} /> New note
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="library-grid">
          {visible.map((file) => {
            const meta = TYPE_META[file.file_type] ?? TYPE_META.Unknown;
            const fileMetaEntry = fileMeta[file.path];
            return (
              <div
                key={file.path}
                className="file-card"
                role="button"
                tabIndex={0}
                onClick={() => open(file)}
                onKeyDown={(event) => {
                  if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
                  event.preventDefault();
                  open(file);
                }}
                onContextMenu={(event) => {
                  if (!allWorkspaces) openContextMenu(event, menuFor(file));
                }}
              >
                <div className={cn('file-card-icon', meta.tone)}>{meta.icon}</div>
                <div className="file-card-body">
                  <div className="file-card-name" dir="auto" title={file.name}>
                    {displayTitle(file)}
                    {allWorkspaces && (
                      <span className="library-owner-badge" title="Workspace that owns this file">
                        {ownerNames.get(file.path) ?? 'Workspace'}
                      </span>
                    )}
                  </div>
                  <div className="file-card-meta">
                    <span className={cn('badge', meta.tone)}>{meta.label}</span>
                    <span
                      className={cn('badge', isExternalPath(file.path) ? 'tone-blue' : 'tone-slate')}
                      title={isExternalPath(file.path)
                        ? 'External file — edits are saved back to the original'
                        : 'Managed by Annotate Studio in its own storage'}
                    >
                      {isExternalPath(file.path) ? 'External' : 'Managed'}
                    </span>
                    <span>{formatBytes(file.size)}</span>
                    <span>{formatRelativeTime(recent[file.path] ?? file.modified_at)}</span>
                    {openSet.has(file.path) && <span className="badge tone-primary">On canvas</span>}
                  </div>
                  {(fileMetaEntry?.tags.length ?? 0) > 0 && (
                    <div className="file-card-tags">
                      {fileMetaEntry!.tags.slice(0, 3).map((tag) => (
                        <span key={tag} className="file-card-tag">
                          #{tag}
                        </span>
                      ))}
                      {fileMetaEntry!.tags.length > 3 && <span className="file-card-tag file-card-tag-more">+{fileMetaEntry!.tags.length - 3}</span>}
                    </div>
                  )}
                </div>
                <div className="file-card-actions">
                  <button
                    type="button"
                    className={cn('icon-btn file-card-star', fileMetaEntry?.starred && 'starred')}
                    title={fileMetaEntry?.starred ? 'Unstar' : 'Star'}
                    aria-label={fileMetaEntry?.starred ? 'Unstar file' : 'Star file'}
                    aria-pressed={!!fileMetaEntry?.starred}
                    onClick={(event) => {
                      event.stopPropagation();
                      toggleFileStar(file.path);
                    }}
                  >
                    <Star size={15} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn file-card-menu"
                    onClick={(event) => {
                      if (!allWorkspaces) openContextMenu(event, menuFor(file));
                    }}
                    title="More actions"
                  >
                    <MoreHorizontal size={16} />
                  </button>
                </div>
                {editingPath === file.path && (
                  <FileMetaEditor
                    meta={fileMetaEntry ?? { tags: [] }}
                    onSave={(tagsForFile, note) => {
                      setFileMeta(file.path, { tags: tagsForFile, note });
                      setEditingPath(null);
                    }}
                    onClose={() => setEditingPath(null)}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}

      {compileOpen && <ReportCompilerDialog onClose={() => setCompileOpen(false)} />}
    </div>
  );
}
