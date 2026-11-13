'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { BookMarked, ChevronDown, ChevronRight, ChevronUp, Copy, Download, FolderClosed, ListPlus, Loader2, Plus, Search, Trash2, X } from 'lucide-react';
import { toast } from '@/store/toast';
import { useBooks, type BookCitation, type BookFile, type BookFolder, type BookProject } from '@/store/books';
import { citationReview, isCitationCapable } from '@/lib/book-citations';
import {
  orderBibliography,
  renderBibliography,
  resolveBibliographyEntries,
  type ResolvedEntry,
} from '@/lib/bibliography';
import { EXPORT_FORMATS, formatCitationHtml, type CitationStyle, type ExportFormat } from '@/lib/citation-formats';
import { saveExportedFile } from '@/lib/export-file';
import { copyRichText, copyText } from '@/lib/utils';
import Dialog from '@/components/ui/Dialog';
import { AddCitationDialog } from './AddCitationDialog';
import { CitationStylePicker, ExportFormatPicker } from './CitationPickers';

interface BibliographyDialogProps {
  open: boolean;
  onClose: () => void;
  /** File ids to seed a fresh bibliography from (the view's selection at open time). */
  seedFileIds?: string[];
}

/** Compact manual record form — cited works that are not in the library. */
function ManualEntryForm({ onAdd, onClose }: { onAdd: (citation: BookCitation) => void; onClose: () => void }) {
  const [title, setTitle] = useState('');
  const [authors, setAuthors] = useState('');
  const [year, setYear] = useState('');
  const [publisher, setPublisher] = useState('');

  const submit = () => {
    if (!title.trim()) return;
    onAdd({
      title: title.trim(),
      authors: authors.split(/[,;]|\band\b/).map((name) => name.trim()).filter(Boolean),
      ...(year.trim() ? { year: year.trim() } : {}),
      ...(publisher.trim() ? { publisher: publisher.trim() } : {}),
      source: 'manual',
      retrievedAt: new Date().toISOString(),
    });
    setTitle('');
    setAuthors('');
    setYear('');
    setPublisher('');
  };

  return (
    <div className="bib-manual">
      <div className="bib-manual-row">
        <input className="input" placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} dir="auto" />
        <input className="input" placeholder="Authors (comma separated)" value={authors} onChange={(e) => setAuthors(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} dir="auto" />
      </div>
      <div className="bib-manual-row">
        <input className="input" placeholder="Year" value={year} onChange={(e) => setYear(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} dir="auto" />
        <input className="input" placeholder="Publisher" value={publisher} onChange={(e) => setPublisher(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} dir="auto" />
      </div>
      <div className="bib-manual-actions">
        <button type="button" className="btn btn-sm btn-primary" onClick={submit} disabled={!title.trim()}>
          <Plus size={13} /> Add
        </button>
        <button type="button" className="btn btn-sm btn-ghost" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** One selectable book row inside the source picker. */
function PickerBook({
  file,
  checked,
  added,
  onToggle,
}: {
  file: BookFile;
  checked: boolean;
  added: boolean;
  onToggle: (id: string) => void;
}) {
  return (
    <label className={`bib-picker-book${added ? ' bib-picker-book-added' : ''}`} title={file.filePath}>
      <input
        type="checkbox"
        checked={added || checked}
        disabled={added}
        onChange={() => onToggle(file.id)}
      />
      <span className="bib-picker-book-name">{file.displayName || file.name}</span>
      {!file.citation && <span className="citations-status-label citations-status-label-review">no citation</span>}
      {added && <span className="citations-status-label">added</span>}
    </label>
  );
}

interface PickerLevel {
  folders: Array<{ folder: BookFolder; children: PickerLevel }>;
  files: BookFile[];
}

/** Walk the folder tree of a project into renderable levels. */
function buildLevel(folderIds: string[], folders: Record<string, BookFolder>, citatableById: Map<string, BookFile>): PickerLevel {
  const level: PickerLevel = { folders: [], files: [] };
  for (const id of folderIds) {
    const folder = folders[id];
    if (!folder) continue;
    level.folders.push({
      folder,
      children: buildLevel(folder.childIds, folders, citatableById),
    });
    for (const fileId of folder.fileIds) {
      const file = citatableById.get(fileId);
      if (file) level.files.push(file);
    }
  }
  return level;
}

/**
 * "Add books" panel: projects first, folders and their books nested under
 * each, with a search that falls back to a flat, project-grouped list.
 */
function SourcePicker({
  projects,
  folders,
  files,
  inList,
  onAdd,
  onClose,
}: {
  projects: BookProject[];
  folders: Record<string, BookFolder>;
  files: Record<string, BookFile>;
  inList: Set<string>;
  onAdd: (fileIds: string[]) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [checked, setChecked] = useState<Set<string>>(new Set());

  const citatable = useMemo(() => Object.values(files).filter((f) => isCitationCapable(f.extension)), [files]);
  const citatableById = useMemo(() => new Map(citatable.map((f) => [f.id, f])), [citatable]);


  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return null;
    return citatable.filter((f) => (f.displayName || f.name).toLowerCase().includes(needle));
  }, [query, citatable]);

  const folderOf = useMemo(() => {
    // file id → folder label inside its project, for the search grouping
    const map = new Map<string, string>();
    for (const folder of Object.values(folders)) {
      for (const id of folder.fileIds) map.set(id, folder.name);
    }
    return map;
  }, [folders]);

  const toggle = (id: string) =>
    setChecked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleProject = (projectId: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });

  const commit = () => {
    if (checked.size === 0) return;
    onAdd([...checked]);
    setChecked(new Set());
    onClose();
  };

  const renderLevel = (level: PickerLevel, depth: number) => (
    <>
      {level.files.map((file) => (
        <PickerBook key={file.id} file={file} checked={checked.has(file.id)} added={inList.has(file.id)} onToggle={toggle} />
      ))}
      {level.folders.map(({ folder, children }) => {
        const open = !collapsed.has(folder.id);
        const count = countCitatable(children, citatableById);
        return (
          <div key={folder.id} className="bib-picker-folder" style={{ marginLeft: depth * 14 }}>
            <button type="button" className="bib-picker-header" onClick={() => toggleProject(folder.id)} aria-expanded={open}>
              {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              <FolderClosed size={13} />
              <span>{folder.name}</span>
              <span className="bib-picker-count">{count}</span>
            </button>
            {open && renderLevel(children, depth + 1)}
          </div>
        );
      })}
    </>
  );

  const addable = [...checked].filter((id) => !inList.has(id));

  return (
    <div className="bib-picker">
      <div className="search-field bib-picker-search">
        <Search size={14} />
        <input className="input input-sm" value={query} placeholder="Find a book…" onChange={(event) => setQuery(event.target.value)} dir="auto" />
      </div>
      <div className="bib-picker-tree">
        {filtered ? (
          filtered.length === 0 ? (
            <p className="citation-hint">No books match “{query.trim()}”.</p>
          ) : (
            projects.map((project) => {
              const matches = filtered.filter((f) => projectContains(project, folders, f.id));
              if (matches.length === 0) return null;
              return (
                <div key={project.id}>
                  <div className="bib-picker-header bib-picker-header-static">
                    <BookMarked size={13} />
                    <span>{project.name}</span>
                    <span className="bib-picker-count">{matches.length}</span>
                  </div>
                  {matches.map((file) => (
                    <PickerBook key={file.id} file={file} checked={checked.has(file.id)} added={inList.has(file.id)} onToggle={toggle} />
                  ))}
                </div>
              );
            })
          )
        ) : (
          projects.map((project) => {
            const level: PickerLevel = {
              folders: buildLevel(
                project.rootFolderIds.filter((id) => folders[id] && folders[id].projectId === project.id),
                folders,
                citatableById,
              ).folders,
              files: project.fileIds.map((id) => citatableById.get(id)).filter((file): file is BookFile => !!file),
            };
            const open = !collapsed.has(project.id);
            const count = countCitatable(level, citatableById);
            return (
              <div key={project.id} className="bib-picker-project">
                <button type="button" className="bib-picker-header" onClick={() => toggleProject(project.id)} aria-expanded={open}>
                  {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  <BookMarked size={13} />
                  <span>{project.name}</span>
                  <span className="bib-picker-count">{count}</span>
                </button>
                {open && renderLevel(level, 1)}
              </div>
            );
          })
        )}
      </div>
      <div className="bib-picker-footer">
        <span className="citation-hint">
          {addable.length === 0 ? 'Pick books to add' : `${addable.length} book${addable.length === 1 ? '' : 's'} ready`}
        </span>
        <span className="citations-output-spacer" />
        <button type="button" className="btn btn-sm btn-ghost" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn btn-sm btn-primary" onClick={commit} disabled={addable.length === 0}>
          <Plus size={13} /> Add {addable.length > 0 ? addable.length : ''}
        </button>
      </div>
    </div>
  );
}

function countCitatable(level: PickerLevel, citatableById: Map<string, BookFile>): number {
  let total = level.files.length;
  for (const branch of level.folders) total += countCitatable(branch.children, citatableById);
  return total;
}

function projectContains(project: BookProject, folders: Record<string, BookFolder>, fileId: string): boolean {
  if (project.fileIds.includes(fileId)) return true;
  return Object.values(folders).some((folder) => folder.projectId === project.id && folder.fileIds.includes(fileId));
}

/**
 * Saved bibliographies: named, ordered lists of citations that survive the
 * session — entries point at library books (live citations) or manual works,
 * can be omitted, grouped and reordered, and render in every citation style
 * and export format.
 */
export function BibliographyDialog({ open, onClose, seedFileIds }: BibliographyDialogProps) {
  const bibliographies = useBooks((state) => state.bibliographies);
  const files = useBooks((state) => state.files);
  const projects = useBooks((state) => state.projects);
  const folders = useBooks((state) => state.folders);
  const {
    createBibliography,
    updateBibliography,
    deleteBibliography,
    addBibliographyEntries,
    removeBibliographyEntry,
    updateBibliographyEntry,
    moveBibliographyEntry,
  } = useBooks.getState();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [exportFormat, setExportFormat] = useState<ExportFormat>('txt');
  const [exporting, setExporting] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [seedConsumed, setSeedConsumed] = useState(false);
  const [fixFileId, setFixFileId] = useState<string | null>(null);

  const list = useMemo(() => Object.values(bibliographies).sort((a, b) => a.createdAt.localeCompare(b.createdAt)), [bibliographies]);
  const selected = selectedId ? bibliographies[selectedId] ?? null : null;

  // Reset the local state each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setSelectedId(list[0]?.id ?? null);
    setSeedConsumed(false);
    setManualOpen(false);
    setPickerOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // A view selection was handed in: offer it as a fresh bibliography once.
  useEffect(() => {
    if (!open || seedConsumed || !seedFileIds || seedFileIds.length === 0) return;
    if (list.length > 0) {
      // Existing bibliographies keep the choice explicit — preselect the newest.
      setSelectedId(list[list.length - 1]?.id ?? null);
      setSeedConsumed(true);
      return;
    }
    const id = createBibliography('Bibliography', 'apa', seedFileIds);
    setSelectedId(id);
    setSeedConsumed(true);
    toast.success(`Started a bibliography with ${seedFileIds.length} source${seedFileIds.length === 1 ? '' : 's'}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, seedFileIds, seedConsumed, list.length]);

  const resolved = useMemo(
    () => (selected ? resolveBibliographyEntries(files, selected.entries) : []),
    [selected, files],
  );
  const rendered = useMemo(
    () => (selected ? renderBibliography(resolved, selected.style, exportFormat) : { citations: [], html: '', text: '' }),
    [selected, resolved, exportFormat],
  );
  const duplicateCount = resolved.filter((item) => item.duplicateOfId).length;
  const missingCount = resolved.filter((item) => item.missing || !item.citation).length;

  if (!open) return null;

  const inList = new Set(
    selected?.entries.map((entry) => entry.fileId).filter((id): id is string => typeof id === 'string'),
  );

  const handleCreate = () => {
    const id = createBibliography(`Bibliography ${list.length + 1}`);
    setSelectedId(id);
  };

  const handleCopy = async () => {
    if (!selected || rendered.citations.length === 0) return;
    let copied: boolean;
    if (exportFormat === 'txt') copied = await copyRichText(rendered.html, rendered.text);
    else copied = await copyText(rendered.text);
    if (copied) toast.success(`Copied ${rendered.citations.length} reference${rendered.citations.length === 1 ? '' : 's'}`);
    else toast.error('Could not copy to the clipboard');
  };

  const handleExport = async () => {
    if (!selected || rendered.citations.length === 0) return;
    const meta = EXPORT_FORMATS.find((f) => f.id === exportFormat) ?? EXPORT_FORMATS[0];
    setExporting(true);
    try {
      const bytes = new TextEncoder().encode(rendered.text);
      const name = `${selected.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'bibliography'}.${meta.extension}`;
      const result = await saveExportedFile(bytes, name, meta);
      if (result.status === 'saved') toast.success('Bibliography exported', result.path);
      else if (result.status === 'downloaded') toast.success('Bibliography downloaded');
    } catch (error) {
      toast.error('Could not export the bibliography', error);
    } finally {
      setExporting(false);
    }
  };

  return (
    <Dialog open onClose={onClose} title="Bibliographies" width={780}>
      <div className="bib-layout">
        <aside className="bib-list">
          <button type="button" className="btn btn-sm btn-secondary bib-new" onClick={handleCreate}>
            <Plus size={13} /> New
          </button>
          {list.length === 0 && <p className="citation-hint">No saved bibliographies yet.</p>}
          {list.map((bibliography) => (
            <button
              key={bibliography.id}
              type="button"
              className={`bib-item${bibliography.id === selectedId ? ' bib-item-active' : ''}`}
              onClick={() => setSelectedId(bibliography.id)}
            >
              <span className="bib-item-title">{bibliography.title}</span>
              <span className="bib-item-count">{bibliography.entries.length}</span>
            </button>
          ))}
        </aside>

        {selected ? (
          <div className="bib-detail">
            <div className="bib-detail-header">
              <input
                className="input bib-title"
                value={selected.title}
                onChange={(event) => updateBibliography(selected.id, { title: event.target.value })}
                aria-label="Bibliography name"
                dir="auto"
              />
              <button type="button" className="icon-btn" title="Delete this bibliography" onClick={() => { deleteBibliography(selected.id); setSelectedId(null); }}>
                <Trash2 size={14} />
              </button>
            </div>

            <div className="bib-toolbar">
              <button
                type="button"
                className={`btn btn-sm ${pickerOpen ? 'btn-secondary' : 'btn-ghost'}`}
                onClick={() => setPickerOpen((current) => !current)}
                title="Add library books — their saved citations stay live"
              >
                <BookMarked size={13} /> Add books
              </button>
              <button
                type="button"
                className={`btn btn-sm ${manualOpen ? 'btn-secondary' : 'btn-ghost'}`}
                onClick={() => setManualOpen((current) => !current)}
                title="Cite a work that is not in the library"
              >
                <ListPlus size={13} /> Add manually
              </button>
              <span className="bib-toolbar-stats">
                <span className="bib-chip">{resolved.length} entr{resolved.length === 1 ? 'y' : 'ies'}</span>
                {missingCount > 0 && <span className="bib-chip bib-chip-warn">{missingCount} without citation</span>}
                {duplicateCount > 0 && <span className="bib-chip bib-chip-info">{duplicateCount} duplicate{duplicateCount === 1 ? '' : 's'} skipped</span>}
              </span>
            </div>

            {pickerOpen && (
              <SourcePicker
                projects={projects}
                folders={folders}
                files={files}
                inList={inList}
                onAdd={(fileIds) => addBibliographyEntries(selected.id, fileIds.map((fileId) => ({ fileId })))}
                onClose={() => setPickerOpen(false)}
              />
            )}

            {manualOpen && (
              <ManualEntryForm
                onAdd={(citation) => {
                  addBibliographyEntries(selected.id, [{ manual: citation }]);
                }}
                onClose={() => setManualOpen(false)}
              />
            )}

            <div className="bib-entries">
              {resolved.length === 0 && <p className="citation-hint citations-preview-empty">Empty — add books or manual records above.</p>}
              {orderBibliography(resolved, selected.style).map((item) => (
                <BibliographyRow
                  key={item.entry.id}
                  item={item}
                  style={selected.style}
                  onInclude={(included) => updateBibliographyEntry(selected.id, item.entry.id, { included })}
                  onSection={(section) => updateBibliographyEntry(selected.id, item.entry.id, { section })}
                  onMove={(direction) => moveBibliographyEntry(selected.id, item.entry.id, direction)}
                  onRemove={() => removeBibliographyEntry(selected.id, item.entry.id)}
                  onFix={item.entry.fileId && !item.missing && !item.citation ? () => setFixFileId(item.entry.fileId!) : undefined}
                />
              ))}
            </div>

            <div className="citations-output">
              <div className="citations-output-toolbar">
                <CitationStylePicker
                  value={selected.style}
                  onChange={(style) => updateBibliography(selected.id, { style })}
                  disabled={exportFormat !== 'txt'}
                  disabledTitle="Styles apply to formatted text output only"
                />
                <ExportFormatPicker value={exportFormat} onChange={setExportFormat} />
                <span className="bib-preview-count">
                  {rendered.citations.length} reference{rendered.citations.length === 1 ? '' : 's'}
                </span>
                <span className="citations-output-spacer" />
                <button type="button" className="btn btn-sm btn-secondary" onClick={handleCopy} disabled={rendered.citations.length === 0}>
                  <Copy size={14} /> Copy
                </button>
                <button type="button" className="btn btn-sm btn-primary" onClick={handleExport} disabled={exporting || rendered.citations.length === 0}>
                  {exporting ? <Loader2 size={14} className="btn-spin" /> : <Download size={14} />} Export
                </button>
              </div>
              {rendered.citations.length ? (
                exportFormat === 'txt' ? (
                  <div className="bib-preview" aria-label="Bibliography preview">
                    {rendered.citations.map((citation, index) => (
                      <div key={`${citation.title}-${index}`} className="bib-preview-row">
                        {selected.style === 'vancouver' && <span className="bib-preview-num">{index + 1}.</span>}
                        <span
                          className="bib-preview-text"
                          dangerouslySetInnerHTML={{ __html: formatCitationHtml(selected.style, citation) }}
                        />
                      </div>
                    ))}
                  </div>
                ) : (
                  <pre className="citations-preview">{rendered.text.trimEnd()}</pre>
                )
              ) : (
                <p className="citation-hint citations-preview-empty">
                  Nothing to output yet — include entries above (checked) and make sure they have citations.
                </p>
              )}
            </div>
          </div>
        ) : (
          <div className="bib-detail bib-detail-empty">
            <p className="citation-hint citations-preview-empty">
              {list.length === 0
                ? 'Create a bibliography to keep an ordered, styled list of your sources — not just one-off copies.'
                : 'Select a bibliography on the left.'}
            </p>
          </div>
        )}
      </div>

      <AddCitationDialog
        key={fixFileId ?? 'none'}
        open={fixFileId !== null}
        onClose={() => setFixFileId(null)}
        fileId={fixFileId}
      />
    </Dialog>
  );
}

/** One bibliography entry: include checkbox, formatted citation, section, controls. */
function BibliographyRow({
  item,
  style,
  onInclude,
  onSection,
  onMove,
  onRemove,
  onFix,
}: {
  item: ResolvedEntry;
  style: CitationStyle;
  onInclude: (included: boolean) => void;
  onSection: (section: string) => void;
  onMove: (direction: -1 | 1) => void;
  onRemove: () => void;
  onFix?: () => void;
}) {
  const entry = item.entry;
  const review = item.citation ? citationReview(item.citation) : null;

  return (
    <div className={`bib-row${entry.included ? '' : ' bib-row-omitted'}`}>
      <label className="book-file-checkbox" title="Include in the output">
        <input type="checkbox" checked={entry.included} onChange={(event) => onInclude(event.target.checked)} />
      </label>
      <div className="bib-row-main">
        <span className="bib-row-label" title={item.label}>
          {item.label}
        </span>
        {item.citation && !item.duplicateOfId ? (
          <span
            className={`bib-row-ref${review && review.state === 'review' ? ' bib-row-ref-review' : ''}`}
            title={review && review.state === 'review' ? review.reasons.join(' · ') : undefined}
            dangerouslySetInnerHTML={{ __html: formatCitationHtml(style, item.citation) }}
          />
        ) : item.missing ? (
          <span className="citations-status-label citations-status-label-error">source removed</span>
        ) : !item.citation ? (
          <span className="citations-status-label citations-status-label-review">no citation yet</span>
        ) : null}
        {item.duplicateOfId && <span className="citations-status-label citations-status-label-review">same work — skipped</span>}
        {review && review.state === 'review' && item.citation && !item.duplicateOfId && (
          <span className="citations-status-label citations-status-label-review" title={review.reasons.join(' · ')}>
            needs review
          </span>
        )}
      </div>
      <input
        className="input input-sm bib-section"
        placeholder="Section"
        value={entry.section ?? ''}
        onChange={(event) => onSection(event.target.value)}
        aria-label="Section label"
        dir="auto"
      />
      <div className="bib-row-actions">
        <button type="button" className="icon-btn" title="Move up" onClick={() => onMove(-1)}>
          <ChevronUp size={13} />
        </button>
        <button type="button" className="icon-btn" title="Move down" onClick={() => onMove(1)}>
          <ChevronDown size={13} />
        </button>
        {onFix && (
          <button type="button" className="icon-btn" title="Create this citation from the file's metadata" onClick={onFix}>
            <BookMarked size={13} />
          </button>
        )}
        <button type="button" className="icon-btn" title="Remove from bibliography" onClick={onRemove}>
          <X size={13} />
        </button>
      </div>
    </div>
  );
}
