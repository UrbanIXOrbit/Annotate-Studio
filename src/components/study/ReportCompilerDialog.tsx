'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { BookText, FileText, Layers, Loader2, NotebookPen } from 'lucide-react';
import Dialog from '@/components/ui/Dialog';
import { CitationStylePicker } from '@/components/study/books/CitationPickers';
import {
  ALL_GROUPS,
  buildReport,
  type ReportItem,
} from '@/lib/annotations';
import {
  compileReport,
  type CompileInput,
  type CompileNote,
  type CompileSourceBook,
} from '@/lib/report-compiler';
import {
  resolveBibliographyEntries,
  orderBibliography,
  type BibliographyEntry,
  type BibliographyFile,
  type ResolvedEntry,
} from '@/lib/bibliography';
import type { CardClip } from '@/lib/note-clip';
import { noteLabel } from '@/lib/note-clip';
import { currentNoteText, exportNoteWithToasts, type NoteExportInput } from '@/lib/note-export-actions';
import { NOTE_FORMATS, NOTE_FORMAT_ORDER, type NoteFormat } from '@/lib/note-export';
import type { CitationStyle } from '@/lib/citation-formats';
import type { StudyFile } from '@/lib/tauri-commands';
import { stripExtension } from '@/lib/utils';
import { useLibrary } from '@/store/library';
import { useBooks, type BookFile } from '@/store/books';
import { useAnnotations } from '@/store/annotations';
import { useCanvas } from '@/store/canvas';
import { cn } from '@/lib/utils';

/** One selectable canvas card, flattened for the checklist. */
interface CardRow {
  id: string;
  workspace: string;
  title: string;
  clip: CardClip;
}

/** A note checklist row: the file plus where it sits in the compile order. */
function noteRowTitle(file: StudyFile): string {
  return file.file_type === 'Markdown' ? stripExtension(file.name) : noteLabel(file.name);
}

function Section({
  icon,
  label,
  hint,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="compiler-section">
      <div className="compiler-section-head">
        {icon}
        <span className="compiler-section-label">{label}</span>
        {hint && <span className="compiler-section-hint">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function CheckRow({
  checked,
  onToggle,
  title,
  meta,
  snippet,
  indent,
}: {
  checked: boolean;
  onToggle: () => void;
  title: string;
  meta?: string;
  snippet?: string;
  indent?: boolean;
}) {
  return (
    <label className={cn('compiler-row', indent && 'compiler-row-indent')}>
      <input type="checkbox" checked={checked} onChange={onToggle} />
      <span className="compiler-row-body">
        <span className="compiler-row-title">{title}</span>
        {snippet && <span className="compiler-row-snippet">{snippet}</span>}
      </span>
      {meta && <span className="compiler-row-meta">{meta}</span>}
    </label>
  );
}

export default function ReportCompilerDialog({ onClose }: { onClose: () => void }) {
  const files = useLibrary((state) => state.files);
  const bookFiles = useBooks((state) => state.files);
  const bibliographies = useBooks((state) => state.bibliographies);
  const annotationBooks = useAnnotations((state) => state.books);
  const workspaces = useCanvas((state) => state.workspaces);
  const [scanTick, setScanTick] = useState(0);

  const [title, setTitle] = useState('Research report');
  const [selectedNotes, setSelectedNotes] = useState<Set<string>>(new Set());
  const [selectedSources, setSelectedSources] = useState<Set<string>>(new Set());
  const [selectedCards, setSelectedCards] = useState<Set<string>>(new Set());
  const [bibliographyId, setBibliographyId] = useState('');
  const [style, setStyle] = useState<CitationStyle>('apa');
  const [format, setFormat] = useState<NoteFormat>('md');
  const [includeToc, setIncludeToc] = useState(true);
  const [includeHighlights, setIncludeHighlights] = useState(true);
  const [includeBibliography, setIncludeBibliography] = useState(true);
  const [compiling, setCompiling] = useState(false);

  // Highlight counts come from the annotations scans; kick one off for every
  // source on the shelf (progress is live in the Annotations tab, too).
  useEffect(() => {
    const scannable = files.filter((file) => file.file_type === 'Pdf' || file.file_type === 'Book');
    if (scannable.length === 0) return;
    void useAnnotations
      .getState()
      .scan(scannable)
      .then(() => setScanTick((tick) => tick + 1))
      .catch(() => undefined);
  }, [files]);

  const notes = useMemo(() => files.filter((file) => file.file_type === 'Markdown' || file.file_type === 'Text'), [files]);

  const sources = useMemo(
    () =>
      files.filter((file) => file.file_type === 'Pdf' || file.file_type === 'Book').map((file) => ({
        file,
        count: annotationBooks[file.path]?.data?.entries.length ?? -1,
      })),
    // scanTick refreshes the counts when the background scan finishes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [files, annotationBooks, scanTick],
  );

  const cards = useMemo<CardRow[]>(
    () =>
      workspaces.flatMap((workspace) =>
        workspace.resources
          .filter((resource) => resource.type === 'card')
          .map((resource) => ({
            id: `res:${workspace.id}/${resource.id}`,
            workspace: workspace.name,
            title: resource.title,
            clip: {
              text: resource.content ?? '',
              comment: resource.note ?? '',
              source: resource.source && resource.source.page ? { title: resource.source.title, page: resource.source.page } : undefined,
            },
          })),
      ),
    [workspaces],
  );

  const bibliographyOptions = useMemo(() => Object.values(bibliographies), [bibliographies]);

  const pickBibliography = (id: string) => {
    setBibliographyId(id);
    const picked = bibliographies[id];
    if (picked) setStyle(picked.style);
  };

  const toggle = (set: Set<string>, path: string, apply: (next: Set<string>) => void) => {
    const next = new Set(set);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    apply(next);
  };

  const selectionSummary = useMemo(() => {
    const highlightCount =
      selectedCards.size + [...selectedSources].reduce((sum, path) => sum + Math.max(0, annotationBooks[path]?.data?.entries.length ?? 0), 0);
    const citationCount = bibliographyId && includeBibliography ? (bibliographies[bibliographyId]?.entries.length ?? 0) : 0;
    return `${selectedNotes.size} note${selectedNotes.size === 1 ? '' : 's'} · ${highlightCount} highlight${
      highlightCount === 1 ? '' : 's'
    } · ${citationCount} citation${citationCount === 1 ? '' : 's'}`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedNotes, selectedSources, selectedCards, annotationBooks, bibliographyId, includeBibliography, bibliographies]);

  const compile = async () => {
    setCompiling(true);
    try {
      // Notes: read at click time, so unsaved editor buffers are included.
      const selectedNoteFiles = notes.filter((file) => selectedNotes.has(file.path));
      const noteInputs: CompileNote[] = await Promise.all(
        selectedNoteFiles.map(async (file) => ({
          path: file.path,
          title: noteRowTitle(file),
          markdown: await currentNoteText(file.path),
        })),
      );

      const cardInputs: CardClip[] = cards.filter((card) => selectedCards.has(card.id)).map((card) => card.clip);

      const sourceInputs: CompileSourceBook[] = [...selectedSources].flatMap((path): CompileSourceBook[] => {
        const data = annotationBooks[path]?.data;
        if (!data) return [];
        const report = buildReport([data], { groups: { ...ALL_GROUPS }, query: '' }, data.title);
        const book = report.books[0];
        if (!book) return [];
        return [
          {
            title: book.title,
            locationUnit: book.locationUnit,
            pages: book.pages.map((page) => ({ page: page.page, items: page.items as ReportItem[] })),
          },
        ];
      });

      // Bibliography: resolve against the books store's citation records, in style order.
      const bibliographyEntries = bibliographyForCompile(bibliographyId, bibliographies, bookFiles, style);

      const input: CompileInput = {
        title,
        notes: noteInputs,
        cards: cardInputs,
        sourceBooks: sourceInputs,
        bibliography: bibliographyEntries,
        options: { includeToc, includeHighlights, includeBibliography, style },
      };
      const { markdown } = compileReport(input);
      const manuscript: NoteExportInput = { title, content: markdown };
      await exportNoteWithToasts(() => manuscript, format);
      onClose();
    } finally {
      setCompiling(false);
    }
  };

  return (
    <Dialog open onClose={onClose} title="Compile report" width={640}>
      <div className="compiler">
        <div className="compiler-title-row">
          <BookText size={15} />
          <input
            className="input"
            value={title}
            placeholder="Report title"
            onChange={(event) => setTitle(event.target.value)}
            data-autofocus
            dir="auto"
          />
        </div>

        <Section icon={<NotebookPen size={14} />} label="Notes" hint="compiled in this order">
          <div className="compiler-list">
            {notes.length === 0 && <p className="compiler-empty">No notes in the library yet.</p>}
            {notes.map((file) => (
              <CheckRow
                key={file.path}
                checked={selectedNotes.has(file.path)}
                onToggle={() => toggle(selectedNotes, file.path, setSelectedNotes)}
                title={noteRowTitle(file)}
              />
            ))}
          </div>
        </Section>

        <Section icon={<FileText size={14} />} label="PDF & book highlights" hint="from your annotations">
          <div className="compiler-list compiler-list-scroll">
            {sources.length === 0 && <p className="compiler-empty">No PDFs or books in the library yet.</p>}
            {sources.map(({ file, count }) => (
              <CheckRow
                key={file.path}
                checked={selectedSources.has(file.path)}
                onToggle={() => toggle(selectedSources, file.path, setSelectedSources)}
                title={stripExtension(file.name)}
                meta={count < 0 ? 'reading…' : `${count} highlight${count === 1 ? '' : 's'}`}
              />
            ))}
          </div>
        </Section>

        <Section icon={<Layers size={14} />} label="Canvas cards" hint={cards.length > 0 ? `${cards.length} on canvas` : undefined}>
          <div className="compiler-list compiler-list-scroll">
            {cards.length === 0 && <p className="compiler-empty">No cards on the canvas yet.</p>}
            {cards.map((card) => (
              <CheckRow
                key={card.id}
                checked={selectedCards.has(card.id)}
                onToggle={() => toggle(selectedCards, card.id, setSelectedCards)}
                title={card.title}
                snippet={card.clip.text.slice(0, 90) || card.clip.comment.slice(0, 90)}
                meta={card.workspace}
              />
            ))}
          </div>
        </Section>

        <Section icon={<BookText size={14} />} label="Bibliography">
          <div className="compiler-bibliography-row">
            <select className="select" value={bibliographyId} onChange={(event) => pickBibliography(event.target.value)} aria-label="Bibliography">
              <option value="">None</option>
              {bibliographyOptions.map((bibliography) => (
                <option key={bibliography.id} value={bibliography.id}>
                  {bibliography.title} ({bibliography.entries.length})
                </option>
              ))}
            </select>
            <CitationStylePicker value={style} onChange={setStyle} />
          </div>
        </Section>

        <div className="compiler-options">
          <label>
            <input type="checkbox" checked={includeToc} onChange={(event) => setIncludeToc(event.target.checked)} /> Contents page
          </label>
          <label>
            <input type="checkbox" checked={includeHighlights} onChange={(event) => setIncludeHighlights(event.target.checked)} /> Highlights
            section
          </label>
          <label>
            <input type="checkbox" checked={includeBibliography} onChange={(event) => setIncludeBibliography(event.target.checked)} /> Annotated
            bibliography
          </label>
        </div>

        <div className="compiler-footer">
          <span className="compiler-summary">{selectionSummary}</span>
          <div className="segmented" role="tablist" aria-label="Export format">
            {NOTE_FORMAT_ORDER.map((id) => (
              <button key={id} type="button" className={cn(format === id && 'active')} onClick={() => setFormat(id)}>
                {NOTE_FORMATS[id].label}
              </button>
            ))}
          </div>
          <button type="button" className="btn btn-primary" disabled={compiling} onClick={() => void compile()}>
            {compiling ? <Loader2 size={15} className="spin" /> : <BookText size={15} />} Compile & save
          </button>
        </div>
      </div>
    </Dialog>
  );
}

/** Resolve the chosen bibliography's entries against the books store's
 * citation records, ordered for the chosen style. */
function bibliographyForCompile(
  bibliographyId: string,
  bibliographies: Record<string, { entries: BibliographyEntry[] }>,
  bookFiles: Record<string, BookFile>,
  style: CitationStyle,
): ResolvedEntry[] {
  const bibliography = bibliographies[bibliographyId];
  if (!bibliography) return [];
  const files: Record<string, BibliographyFile> = {};
  for (const file of Object.values(bookFiles)) {
    files[file.id] = { name: file.name, displayName: file.displayName ?? null, citation: file.citation ?? null };
  }
  return orderBibliography(resolveBibliographyEntries(files, bibliography.entries), style);
}
