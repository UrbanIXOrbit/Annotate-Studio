import { create } from 'zustand';
import {
  loadBooksState,
  saveBooksState,
  importExternalFiles,
  externalFilesExist,
  errorMessage,
} from '@/lib/tauri-commands';
import { createSaver } from '@/lib/persist';
import { searchLibrary } from '@/lib/books-search';
import { uid } from '@/lib/utils';
import { CITATION_FIELDS, CITATION_SOURCE_NAMES, type CitationField, type CitationSourceName } from '@/lib/citation-schema';

/**
 * Virtual File System for Books Manager
 * Files are referenced by path — no copying, purely organizational
 */

/** Where a citation field's value came from (see citation-schema for the catalogue list). */
export type { CitationField, CitationSourceName } from '@/lib/citation-schema';

/** A structured author name preserved from the merge (organisation names stay intact). */
export interface CitationAuthorName {
  family: string;
  given?: string;
  org?: boolean;
}

export type CitationWorkType = 'book' | 'article' | 'chapter' | 'conference' | 'preprint' | 'thesis' | 'other';

/**
 * Bibliographic record for a book — enough to render formatted citations
 * (APA/MLA/Chicago/Harvard/Vancouver) and reference-manager exports (BibTeX/RIS/CSL JSON).
 */
export interface BookCitation {
  title: string;
  /** Display names, "Family, Given" or "Given Family" */
  authors: string[];
  publisher?: string;
  /** Place of publication (Chicago and MLA use it) */
  city?: string;
  year?: string;
  edition?: string;
  isbn?: string;
  doi?: string;
  language?: string;
  pageCount?: number;
  /** Work type from the merge; absent on legacy records (treated as a book) */
  type?: CitationWorkType;
  /** Journal or venue — the book title for chapters */
  container?: string;
  /** Abbreviated journal name (Vancouver style) */
  containerShort?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  /** Editor display names, "Family, Given" */
  editors?: string[];
  /** Structured names preserved from the merge so formatters never mangle organisations */
  structuredAuthors?: CitationAuthorName[];
  url?: string;
  /** Small note carried from a source ("year is the first publication year…") */
  note?: string;
  /** How many independent evidence groups cross-checked the merge */
  confidence?: 'high' | 'medium' | 'low';
  /** At least one source marks the work as retracted */
  retracted?: boolean;
  /** Where the record came from: the file's own metadata, an online lookup, or manual entry */
  source: 'embedded' | 'enriched' | 'manual';
  /** ISO timestamp of when this record was saved */
  retrievedAt: string;
  /** Which source supplied each field (catalogue, the file, or a manual edit) */
  fieldSources?: Partial<Record<CitationField, CitationSourceName>>;
  /** Fields where the sources disagreed — a human should confirm the value */
  conflicts?: CitationField[];
}

export interface BookFile {
  id: string;
  /** Original file path on disk */
  filePath: string;
  /** Display name (editable) */
  name: string;
  /** Original file extension */
  extension: string;
  /** Size in bytes */
  size: number;
  /** When the file was added to the system */
  addedAt: string;
  /** Last modified timestamp of the actual file */
  modifiedAt: string;
  /** Custom tags */
  tags: string[];
  /** Custom notes/description */
  notes: string;
  /**
   * Display name set by a rename or adopted from a fetched citation's title.
   * Purely cosmetic — `name` keeps the original import filename and `filePath`
   * stays the identity used for duplicate detection and disk verification.
   */
  displayName?: string | null;
  /** Saved citation record, once generated or entered */
  citation?: BookCitation | null;
}

export interface BookFolder {
  id: string;
  name: string;
  /** Parent folder ID, null for root-level */
  parentId: string | null;
  /** Project this folder belongs to */
  projectId: string;
  /** File IDs in this folder */
  fileIds: string[];
  /** Child folder IDs */
  childIds: string[];
  /** Collapsed state in UI */
  collapsed: boolean;
  createdAt: string;
}

export interface BookProject {
  id: string;
  name: string;
  description: string;
  /** Root folder IDs for this project */
  rootFolderIds: string[];
  /** File IDs directly in project (no folder) */
  fileIds: string[];
  color: string;
  /** Collapsed state of the project node in the library tree */
  collapsed: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Ephemeral clipboard for copy/cut + paste of files between locations */
export interface BooksClipboard {
  mode: 'copy' | 'cut';
  fileIds: string[];
}

/** What actually happened during an import, so the UI can report partial failures. */
export interface BooksImportResult {
  /** Names of the files that were added */
  added: string[];
  /** Names skipped because the same path is already in the target location */
  duplicates: string[];
  /** Failures as "path — reason" strings */
  failures: string[];
}

/**
 * One step of undo history for destructive operations. Holds shallow
 * references to the pre-deletion state objects — zustand replaces objects
 * immutably, so a restore is just a `set` with these references.
 */
export interface BooksUndoEntry {
  id: string;
  label: string;
  projects: BookProject[];
  folders: Record<string, BookFolder>;
  files: Record<string, BookFile>;
  activeProjectId: string | null;
}

const MAX_UNDO_ENTRIES = 10;

function pushUndoEntry(stack: BooksUndoEntry[], state: BooksState, label: string): BooksUndoEntry[] {
  const entry: BooksUndoEntry = {
    id: uid(),
    label,
    projects: state.projects,
    folders: state.folders,
    files: state.files,
    activeProjectId: state.activeProjectId,
  };
  return [...stack, entry].slice(-MAX_UNDO_ENTRIES);
}

interface BooksState {
  hydrated: boolean;
  projects: BookProject[];
  folders: Record<string, BookFolder>;
  files: Record<string, BookFile>;
  activeProjectId: string | null;
  selectedFolderId: string | null;
  selectedFileIds: string[];
  clipboard: BooksClipboard | null;
  /** File ids whose referenced path failed the last disk verification (ephemeral, not saved) */
  missingFileIds: string[];
  /** In-memory undo history for destructive operations (ephemeral, not saved) */
  undoStack: BooksUndoEntry[];
}

interface BooksActions {
  hydrate: () => Promise<void>;
  
  // Project actions
  createProject: (name: string, description?: string) => string;
  updateProject: (id: string, patch: Partial<Pick<BookProject, 'name' | 'description' | 'color'>>) => void;
  deleteProject: (id: string) => void;
  setActiveProject: (id: string | null) => void;
  toggleProjectCollapse: (id: string) => void;
  
  // Folder actions
  createFolder: (projectId: string, name: string, parentId?: string | null) => string;
  renameFolder: (id: string, name: string) => void;
  moveFolder: (id: string, newParentId: string | null, targetProjectId?: string | null) => void;
  deleteFolder: (id: string) => void;
  toggleFolderCollapse: (id: string) => void;
  setSelectedFolder: (id: string | null) => void;
  
  // File actions
  importFiles: (projectId: string, folderId: string | null, paths: string[]) => Promise<BooksImportResult>;
  verifyLibrary: () => Promise<string[]>;
  updateFile: (id: string, patch: Partial<Pick<BookFile, 'name' | 'displayName' | 'tags' | 'notes' | 'citation'>>) => void;
  moveFiles: (fileIds: string[], targetProjectId: string, targetFolderId: string | null) => void;
  copyFiles: (fileIds: string[], targetProjectId: string, targetFolderId: string | null) => number;
  removeFiles: (fileIds: string[]) => void;
  setSelectedFiles: (fileIds: string[]) => void;
  toggleFileSelection: (id: string) => void;

  // Undo actions (ephemeral history, newest first from the end of the stack)
  undoLast: () => void;
  clearUndo: () => void;
  
  // Clipboard actions
  copyToClipboard: (fileIds: string[]) => void;
  cutToClipboard: (fileIds: string[]) => void;
  pasteFromClipboard: (targetProjectId: string, targetFolderId: string | null) => number;
  clearClipboard: () => void;
  
  // Queries
  getProjectFiles: (projectId: string, folderId?: string | null) => BookFile[];
  getFolderChildren: (folderId: string) => BookFolder[];
  getFolderFileCount: (folderId: string) => number;
  getFileLocation: (fileId: string) => { projectId: string; folderId: string | null } | null;
  searchFiles: (query: string, projectId?: string | string[] | null) => BookFile[];
}

type BooksStore = BooksState & BooksActions;

const PROJECT_COLORS = ['#3B82F6', '#8B5CF6', '#EC4899', '#F59E0B', '#10B981', '#06B6D4', '#6366F1'];

function migrateBookCitation(raw: unknown): BookCitation | null {
  if (!raw || typeof raw !== 'object') return null;
  const data = raw as Record<string, unknown>;
  if (typeof data.title !== 'string' || !data.title.trim()) return null;
  if (data.source !== 'embedded' && data.source !== 'enriched' && data.source !== 'manual') return null;

  const isField = (value: string): value is CitationField => (CITATION_FIELDS as readonly string[]).includes(value);
  const isSourceName = (value: string): value is CitationSourceName =>
    (CITATION_SOURCE_NAMES as readonly string[]).includes(value);
  const WORK_TYPES = ['book', 'article', 'chapter', 'conference', 'preprint', 'thesis', 'other'];
  const str = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value : undefined);

  let fieldSources: BookCitation['fieldSources'];
  if (data.fieldSources && typeof data.fieldSources === 'object' && !Array.isArray(data.fieldSources)) {
    const mapped: Partial<Record<CitationField, CitationSourceName>> = {};
    for (const [key, value] of Object.entries(data.fieldSources as Record<string, unknown>)) {
      if (isField(key) && typeof value === 'string' && isSourceName(value)) mapped[key] = value;
    }
    if (Object.keys(mapped).length > 0) fieldSources = mapped;
  }
  const conflicts = Array.isArray(data.conflicts)
    ? data.conflicts.filter((c): c is CitationField => typeof c === 'string' && isField(c))
    : undefined;

  const structuredAuthors = Array.isArray(data.structuredAuthors)
    ? (data.structuredAuthors as unknown[])
        .map((a) => {
          if (!a || typeof a !== 'object') return null;
          const rec = a as Record<string, unknown>;
          if (typeof rec.family !== 'string' || !rec.family.trim()) return null;
          return {
            family: rec.family.trim(),
            ...(typeof rec.given === 'string' && rec.given.trim() ? { given: rec.given.trim() } : {}),
            ...(rec.org === true ? { org: true } : {}),
          };
        })
        .filter((a): a is NonNullable<typeof a> => !!a)
    : undefined;

  return {
    title: data.title,
    authors: Array.isArray(data.authors) ? data.authors.filter((a): a is string => typeof a === 'string' && !!a.trim()) : [],
    publisher: str(data.publisher),
    city: str(data.city),
    year: str(data.year),
    edition: str(data.edition),
    isbn: str(data.isbn),
    doi: str(data.doi),
    language: str(data.language),
    pageCount: typeof data.pageCount === 'number' ? data.pageCount : undefined,
    type: WORK_TYPES.includes(data.type as string) ? (data.type as BookCitation['type']) : undefined,
    container: str(data.container),
    containerShort: str(data.containerShort),
    volume: str(data.volume),
    issue: str(data.issue),
    pages: str(data.pages),
    editors: Array.isArray(data.editors) ? data.editors.filter((e): e is string => typeof e === 'string' && !!e.trim()) : undefined,
    structuredAuthors: structuredAuthors && structuredAuthors.length ? structuredAuthors : undefined,
    url: str(data.url),
    note: str(data.note),
    confidence:
      data.confidence === 'high' || data.confidence === 'medium' || data.confidence === 'low' ? data.confidence : undefined,
    retracted: data.retracted === true ? true : undefined,
    source: data.source,
    retrievedAt: typeof data.retrievedAt === 'string' ? data.retrievedAt : new Date().toISOString(),
    fieldSources,
    conflicts: conflicts && conflicts.length > 0 ? conflicts : undefined,
  };
}

function migrateBookFile(raw: unknown): BookFile | null {
  if (!raw || typeof raw !== 'object') return null;
  const data = raw as Record<string, unknown>;
  
  if (typeof data.filePath !== 'string' || !data.filePath.trim()) return null;
  
  return {
    id: typeof data.id === 'string' && data.id ? data.id : uid(),
    filePath: data.filePath.trim(),
    name: typeof data.name === 'string' && data.name.trim() ? data.name.trim() : '',
    extension: typeof data.extension === 'string' ? data.extension : '',
    size: typeof data.size === 'number' ? data.size : 0,
    addedAt: typeof data.addedAt === 'string' ? data.addedAt : new Date().toISOString(),
    modifiedAt: typeof data.modifiedAt === 'string' ? data.modifiedAt : new Date().toISOString(),
    tags: Array.isArray(data.tags) ? data.tags.filter((t): t is string => typeof t === 'string') : [],
    notes: typeof data.notes === 'string' ? data.notes : '',
    displayName: typeof data.displayName === 'string' && data.displayName.trim() ? data.displayName.trim() : undefined,
    // Absent (not null) so legacy files keep their exact stored shape
    citation: migrateBookCitation(data.citation) ?? undefined,
  };
}

function migrateBookFolder(raw: unknown, projectIds: Set<string>): BookFolder | null {
  if (!raw || typeof raw !== 'object') return null;
  const data = raw as Record<string, unknown>;
  
  if (typeof data.projectId !== 'string' || !projectIds.has(data.projectId)) return null;
  
  return {
    id: typeof data.id === 'string' && data.id ? data.id : uid(),
    name: typeof data.name === 'string' && data.name.trim() ? data.name.trim() : 'Untitled Folder',
    parentId: typeof data.parentId === 'string' && data.parentId ? data.parentId : null,
    projectId: data.projectId,
    fileIds: Array.isArray(data.fileIds) ? data.fileIds.filter((id): id is string => typeof id === 'string') : [],
    childIds: Array.isArray(data.childIds) ? data.childIds.filter((id): id is string => typeof id === 'string') : [],
    collapsed: data.collapsed === true,
    createdAt: typeof data.createdAt === 'string' ? data.createdAt : new Date().toISOString(),
  };
}

function migrateBookProject(raw: unknown, index: number): BookProject | null {
  if (!raw || typeof raw !== 'object') return null;
  const data = raw as Record<string, unknown>;
  
  return {
    id: typeof data.id === 'string' && data.id ? data.id : uid(),
    name: typeof data.name === 'string' && data.name.trim() ? data.name.trim() : `Project ${index + 1}`,
    description: typeof data.description === 'string' ? data.description : '',
    rootFolderIds: Array.isArray(data.rootFolderIds) ? data.rootFolderIds.filter((id): id is string => typeof id === 'string') : [],
    fileIds: Array.isArray(data.fileIds) ? data.fileIds.filter((id): id is string => typeof id === 'string') : [],
    color: typeof data.color === 'string' && /^#[0-9A-Fa-f]{6}$/.test(data.color) ? data.color : PROJECT_COLORS[index % PROJECT_COLORS.length],
    collapsed: data.collapsed === true,
    createdAt: typeof data.createdAt === 'string' ? data.createdAt : new Date().toISOString(),
    updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : new Date().toISOString(),
  };
}

function migrateBooksState(raw: unknown): BooksState {
  const data = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  
  const projects: BookProject[] = [];
  if (Array.isArray(data.projects)) {
    data.projects.forEach((p, index) => {
      const project = migrateBookProject(p, index);
      if (project) projects.push(project);
    });
  }
  
  const projectIds = new Set(projects.map(p => p.id));
  
  const folders: Record<string, BookFolder> = {};
  if (data.folders && typeof data.folders === 'object') {
    Object.entries(data.folders as Record<string, unknown>).forEach(([id, raw]) => {
      const folder = migrateBookFolder(raw, projectIds);
      if (folder) folders[id] = folder;
    });
  }
  
  const files: Record<string, BookFile> = {};
  if (data.files && typeof data.files === 'object') {
    Object.entries(data.files as Record<string, unknown>).forEach(([id, raw]) => {
      const file = migrateBookFile(raw);
      if (file) files[id] = file;
    });
  }
  
  // Clean up orphaned references
  const validFileIds = new Set(Object.keys(files));
  const validFolderIds = new Set(Object.keys(folders));
  
  projects.forEach(project => {
    project.fileIds = project.fileIds.filter(id => validFileIds.has(id));
    project.rootFolderIds = project.rootFolderIds.filter(id => validFolderIds.has(id));
  });
  
  Object.values(folders).forEach(folder => {
    folder.fileIds = folder.fileIds.filter(id => validFileIds.has(id));
    folder.childIds = folder.childIds.filter(id => validFolderIds.has(id));
  });
  
  const activeProjectId = typeof data.activeProjectId === 'string' && projectIds.has(data.activeProjectId)
    ? data.activeProjectId
    : projects[0]?.id ?? null;
  
  return {
    hydrated: false,
    projects,
    folders,
    files,
    activeProjectId,
    selectedFolderId: null,
    selectedFileIds: [],
    clipboard: null,
    missingFileIds: [],
    undoStack: [],
  };
}

function snapshotBooksState(state: BooksStore) {
  return {
    projects: state.projects,
    folders: state.folders,
    files: state.files,
    activeProjectId: state.activeProjectId,
  };
}

const saver = createSaver<ReturnType<typeof snapshotBooksState>>(
  (value) => saveBooksState(value),
  500,
  (error) => console.error('Failed to save books library:', error),
);

export const useBooks = create<BooksStore>((set, get) => ({
  // Initial state
  hydrated: false,
  projects: [],
  folders: {},
  files: {},
  activeProjectId: null,
  selectedFolderId: null,
  selectedFileIds: [],
  clipboard: null,
  missingFileIds: [],
  undoStack: [],
  
  // Hydrate
  hydrate: async () => {
    if (get().hydrated) return;
    let state = migrateBooksState(null);
    try {
      state = migrateBooksState(await loadBooksState());
    } catch {
      state = migrateBooksState(null);
    }
    set({ ...state, hydrated: true });
  },
  
  // Project actions
  createProject: (name, description = '') => {
    const project: BookProject = {
      id: uid(),
      name: name.trim() || 'Untitled Project',
      description,
      rootFolderIds: [],
      fileIds: [],
      color: PROJECT_COLORS[get().projects.length % PROJECT_COLORS.length],
      collapsed: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    set(state => ({
      projects: [...state.projects, project],
      activeProjectId: project.id,
    }));
    return project.id;
  },
  
  updateProject: (id, patch) => {
    set(state => ({
      projects: state.projects.map(p =>
        p.id === id ? { ...p, ...patch, updatedAt: new Date().toISOString() } : p
      ),
    }));
  },
  
  deleteProject: (id) => {
    const state = get();
    const project = state.projects.find(p => p.id === id);
    if (!project) return;

    const undoStack = pushUndoEntry(get().undoStack, state, `Deleted project “${project.name}”`);

    // Collect all folders in this project
    const foldersToDelete = Object.keys(state.folders).filter(
      folderId => state.folders[folderId].projectId === id
    );
    
    // Remove folders
    const folders = { ...state.folders };
    foldersToDelete.forEach(folderId => delete folders[folderId]);
    
    // Remove files (they're just references, not actual files)
    const allFileIds = new Set([
      ...project.fileIds,
      ...foldersToDelete.flatMap(fId => state.folders[fId].fileIds),
    ]);
    
    const files = { ...state.files };
    allFileIds.forEach(fileId => delete files[fileId]);
    
    set({
      projects: state.projects.filter(p => p.id !== id),
      folders,
      files,
      activeProjectId: state.activeProjectId === id
        ? state.projects.find(p => p.id !== id)?.id ?? null
        : state.activeProjectId,
      selectedFolderId: foldersToDelete.includes(state.selectedFolderId ?? '')
        ? null
        : state.selectedFolderId,
      selectedFileIds: state.selectedFileIds.filter(fId => !allFileIds.has(fId)),
      undoStack,
    });
  },
  
  setActiveProject: (id) => set({ activeProjectId: id, selectedFolderId: null, selectedFileIds: [] }),

  toggleProjectCollapse: (id) => {
    set(state => ({
      projects: state.projects.map(p =>
        p.id === id ? { ...p, collapsed: !p.collapsed } : p
      ),
    }));
  },
  
  // Folder actions
  createFolder: (projectId, name, parentId = null) => {
    const state = get();
    if (!state.projects.some(p => p.id === projectId)) return '';
    
    const folder: BookFolder = {
      id: uid(),
      name: name.trim() || 'Untitled Folder',
      parentId,
      projectId,
      fileIds: [],
      childIds: [],
      collapsed: false,
      createdAt: new Date().toISOString(),
    };
    
    const folders = { ...state.folders, [folder.id]: folder };
    
    // Add to parent or project
    if (parentId && folders[parentId]) {
      folders[parentId] = {
        ...folders[parentId],
        childIds: [...folders[parentId].childIds, folder.id],
      };
    } else {
      set({
        projects: state.projects.map(p =>
          p.id === projectId
            ? { ...p, rootFolderIds: [...p.rootFolderIds, folder.id], updatedAt: new Date().toISOString() }
            : p
        ),
      });
    }
    
    set({ folders });
    return folder.id;
  },
  
  renameFolder: (id, name) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    set(state => ({
      folders: {
        ...state.folders,
        [id]: state.folders[id] ? { ...state.folders[id], name: trimmed } : state.folders[id],
      },
    }));
  },
  
  moveFolder: (id, newParentId, targetProjectId = null) => {
    const state = get();
    const folder = state.folders[id];
    if (!folder) return;
    
    // Resolve the destination: a parent folder pins the project, otherwise
    // fall back to the explicit target project (or the folder's own project)
    let destinationProjectId = folder.projectId;
    if (newParentId) {
      const parent = state.folders[newParentId];
      if (!parent) return;
      destinationProjectId = parent.projectId;
    } else if (targetProjectId) {
      destinationProjectId = targetProjectId;
    }
    if (!state.projects.some(p => p.id === destinationProjectId)) return;
    
    // Prevent moving into self or descendants
    const isDescendant = (checkId: string, ancestorId: string): boolean => {
      const check = state.folders[checkId];
      if (!check || checkId === ancestorId) return true;
      return check.parentId ? isDescendant(check.parentId, ancestorId) : false;
    };
    
    if (newParentId && isDescendant(newParentId, id)) return;
    if (folder.parentId === newParentId && folder.projectId === destinationProjectId) return;
    
    const folders = { ...state.folders };
    const projects = state.projects.map(p => ({ ...p }));
    
    // Remove from old container
    if (folder.parentId && folders[folder.parentId]) {
      folders[folder.parentId] = {
        ...folders[folder.parentId],
        childIds: folders[folder.parentId].childIds.filter(cId => cId !== id),
      };
    } else {
      const oldProject = projects.find(p => p.id === folder.projectId);
      if (oldProject) oldProject.rootFolderIds = oldProject.rootFolderIds.filter(fId => fId !== id);
    }
    
    // Add to new container
    if (newParentId && folders[newParentId]) {
      folders[newParentId] = {
        ...folders[newParentId],
        childIds: [...folders[newParentId].childIds, id],
      };
    } else {
      const destinationProject = projects.find(p => p.id === destinationProjectId);
      if (destinationProject) destinationProject.rootFolderIds = [...destinationProject.rootFolderIds, id];
    }
    
    folders[id] = { ...folder, parentId: newParentId, projectId: destinationProjectId };
    
    // A cross-project move re-homes the whole subtree
    if (folder.projectId !== destinationProjectId) {
      const relabel = (folderId: string) => {
        const f = folders[folderId];
        if (!f) return;
        folders[folderId] = { ...f, projectId: destinationProjectId };
        f.childIds.forEach(relabel);
      };
      folder.childIds.forEach(relabel);
    }

    // Dropping the folder being viewed (or one of its ancestors) into another
    // project moves the view target away: reset the location and prune the
    // selection that would otherwise linger under the old project
    let selectedFolderId = state.selectedFolderId;
    let selectedFileIds = state.selectedFileIds;
    if (folder.projectId !== destinationProjectId && state.selectedFolderId) {
      const subtree = new Set([id]);
      const collectSubtree = (folderId: string) => {
        const f = folders[folderId];
        if (!f) return;
        f.childIds.forEach(childId => {
          if (!subtree.has(childId)) {
            subtree.add(childId);
            collectSubtree(childId);
          }
        });
      };
      collectSubtree(id);
      if (subtree.has(state.selectedFolderId)) {
        const subtreeFileIds = new Set<string>();
        subtree.forEach(fId => folders[fId]?.fileIds.forEach(fileId => subtreeFileIds.add(fileId)));
        selectedFolderId = null;
        selectedFileIds = selectedFileIds.filter(fId => !subtreeFileIds.has(fId));
      }
    }

    const now = new Date().toISOString();
    set({
      folders,
      projects: projects.map(p =>
        p.id === folder.projectId || p.id === destinationProjectId ? { ...p, updatedAt: now } : p
      ),
      selectedFolderId,
      selectedFileIds,
    });
  },
  
  deleteFolder: (id) => {
    const state = get();
    const folder = state.folders[id];
    if (!folder) return;

    // Collect all descendants
    const collectDescendants = (folderId: string): string[] => {
      const f = state.folders[folderId];
      if (!f) return [folderId];
      return [folderId, ...f.childIds.flatMap(collectDescendants)];
    };

    const toDelete = collectDescendants(id);
    const folders = { ...state.folders };
    const filesToRemove = new Set<string>();

    toDelete.forEach(fId => {
      if (folders[fId]) {
        folders[fId].fileIds.forEach(fileId => filesToRemove.add(fileId));
        delete folders[fId];
      }
    });

    // Snapshot before anything is mutated — the label reflects the whole subtree
    const removedCount = filesToRemove.size;
    const scope = removedCount > 0 ? ` and ${removedCount} file${removedCount === 1 ? '' : 's'}` : '';
    const undoStack = pushUndoEntry(get().undoStack, state, `Deleted folder “${folder.name}”${scope}`);
    
    // Remove from parent or project
    if (folder.parentId && folders[folder.parentId]) {
      folders[folder.parentId] = {
        ...folders[folder.parentId],
        childIds: folders[folder.parentId].childIds.filter(cId => cId !== id),
      };
    } else {
      set({
        projects: state.projects.map(p =>
          p.id === folder.projectId
            ? { ...p, rootFolderIds: p.rootFolderIds.filter(fId => fId !== id), updatedAt: new Date().toISOString() }
            : p
        ),
      });
    }
    
    const files = { ...state.files };
    filesToRemove.forEach(fileId => delete files[fileId]);
    
    set({
      folders,
      files,
      selectedFolderId: state.selectedFolderId === id ? null : state.selectedFolderId,
      selectedFileIds: state.selectedFileIds.filter(fId => !filesToRemove.has(fId)),
      undoStack,
    });
  },
  
  toggleFolderCollapse: (id) => {
    set(state => ({
      folders: {
        ...state.folders,
        [id]: state.folders[id] ? { ...state.folders[id], collapsed: !state.folders[id].collapsed } : state.folders[id],
      },
    }));
  },
  
  setSelectedFolder: (id) => set({ selectedFolderId: id, selectedFileIds: [] }),
  
  // File actions
  importFiles: async (projectId, folderId, requestedPaths) => {
    const empty: BooksImportResult = { added: [], duplicates: [], failures: [] };
    // The dialog can hand back the same path repeatedly; import each path once
    const paths = [...new Set(requestedPaths)];
    if (paths.length === 0) return empty;

    try {
      const outcomes = await importExternalFiles(paths);

      // Re-read the state after the await: the library may have changed while
      // the dialog/promise was in flight, and a pre-await snapshot would clobber it
      const state = get();
      if (!state.projects.some(p => p.id === projectId)) return empty;
      if (folderId && !state.folders[folderId]) return empty;

      // Same rule as copyFiles: a path already in the target location is skipped
      const targetFileIds = folderId
        ? state.folders[folderId].fileIds
        : state.projects.find(p => p.id === projectId)?.fileIds ?? [];
      const pathsAtTarget = new Set(
        targetFileIds.map(fId => state.files[fId]?.filePath).filter((p): p is string => !!p)
      );

      const added: string[] = [];
      const duplicates: string[] = [];
      const failures: string[] = [];
      const newFiles: Record<string, BookFile> = {};
      const fileIds: string[] = [];

      for (const outcome of outcomes) {
        if (!outcome.file) {
          const reason = outcome.error ?? 'Unknown failure';
          failures.push(`${outcome.path} — ${reason}`);
          continue;
        }
        const ref = outcome.file;
        if (pathsAtTarget.has(ref.path)) {
          duplicates.push(ref.name);
          continue;
        }
        pathsAtTarget.add(ref.path);

        const file: BookFile = {
          id: uid(),
          filePath: ref.path,
          name: ref.name,
          extension: ref.extension,
          size: ref.size,
          addedAt: new Date().toISOString(),
          modifiedAt: ref.modified_at,
          tags: [],
          notes: '',
        };
        newFiles[file.id] = file;
        fileIds.push(file.id);
        added.push(file.name);
      }

      if (fileIds.length === 0) return { added, duplicates, failures };

      const now = new Date().toISOString();
      if (folderId) {
        set({
          files: { ...state.files, ...newFiles },
          folders: {
            ...state.folders,
            [folderId]: {
              ...state.folders[folderId],
              fileIds: [...state.folders[folderId].fileIds, ...fileIds],
            },
          },
        });
      } else {
        set({
          files: { ...state.files, ...newFiles },
          projects: state.projects.map(p =>
            p.id === projectId
              ? { ...p, fileIds: [...p.fileIds, ...fileIds], updatedAt: now }
              : p
          ),
        });
      }
      return { added, duplicates, failures };
    } catch (error) {
      const message = errorMessage(error);
      console.error('Failed to import files:', error);
      return { added: [], duplicates: [], failures: paths.map(path => `${path} — ${message}`) };
    }
  },

  /**
   * Check every referenced path against the disk and flag the files whose
   * paths are gone (moved, renamed or deleted). Returns the missing file ids.
   * Ephemeral state only — cleaned up by re-running or by re-adding the file.
   */
  verifyLibrary: async () => {
    const state = get();
    const entries = Object.values(state.files);
    if (entries.length === 0) {
      set({ missingFileIds: [] });
      return [];
    }

    const statuses = await externalFilesExist(entries.map(file => file.filePath));
    const missingPaths = new Set(statuses.filter(s => !s.exists).map(s => s.path));
    const missingFileIds = entries.filter(file => missingPaths.has(file.filePath)).map(file => file.id);
    set({ missingFileIds });
    return missingFileIds;
  },
  
  updateFile: (id, patch) => {
    set(state => ({
      files: {
        ...state.files,
        [id]: state.files[id] ? { ...state.files[id], ...patch } : state.files[id],
      },
    }));
  },
  
  moveFiles: (fileIds, targetProjectId, targetFolderId) => {
    const state = get();
    if (!state.projects.some(p => p.id === targetProjectId)) return;
    if (targetFolderId && !state.folders[targetFolderId]) return;
    
    // Only move files that exist and aren't already at the destination
    const alreadyAtTarget = new Set(targetFolderId
      ? state.folders[targetFolderId].fileIds
      : state.projects.find(p => p.id === targetProjectId)?.fileIds ?? []
    );
    const toMove = fileIds.filter(fId => state.files[fId] && !alreadyAtTarget.has(fId));
    if (toMove.length === 0) return;
    
    const fileIdsSet = new Set(toMove);
    
    const projects = state.projects.map(project => ({
      ...project,
      fileIds: project.fileIds.filter(fId => !fileIdsSet.has(fId)),
      updatedAt: new Date().toISOString(),
    }));
    
    const folders = { ...state.folders };
    Object.keys(folders).forEach(fId => {
      folders[fId] = {
        ...folders[fId],
        fileIds: folders[fId].fileIds.filter(fileId => !fileIdsSet.has(fileId)),
      };
    });
    
    // Add to target
    if (targetFolderId) {
      folders[targetFolderId] = {
        ...folders[targetFolderId],
        fileIds: [...folders[targetFolderId].fileIds, ...toMove],
      };
    } else {
      const targetProject = projects.find(p => p.id === targetProjectId);
      if (targetProject) {
        targetProject.fileIds = [...targetProject.fileIds, ...toMove];
      }
    }

    set({
      projects,
      folders,
      // Moved files stop being selected — they acted on and often leave the
      // view, so a stale "N selected" bar would otherwise linger
      selectedFileIds: state.selectedFileIds.filter(fId => !fileIdsSet.has(fId)),
    });
  },
  
  copyFiles: (fileIds, targetProjectId, targetFolderId) => {
    const state = get();
    if (!state.projects.some(p => p.id === targetProjectId)) return 0;
    if (targetFolderId && !state.folders[targetFolderId]) return 0;
    
    // The library references files in place, so a copy is a new reference to
    // the same path. Skip sources that no longer exist or paths already at
    // the destination to prevent stacking duplicates.
    const targetFileIds = targetFolderId
      ? state.folders[targetFolderId].fileIds
      : state.projects.find(p => p.id === targetProjectId)?.fileIds ?? [];
    const pathsAtTarget = new Set(
      targetFileIds.map(fId => state.files[fId]?.filePath).filter((p): p is string => !!p)
    );
    
    const now = new Date().toISOString();
    const copies: BookFile[] = [];
    fileIds.forEach(fId => {
      const source = state.files[fId];
      if (!source || pathsAtTarget.has(source.filePath)) return;
      pathsAtTarget.add(source.filePath);
      copies.push({ ...source, id: uid(), addedAt: now });
    });
    if (copies.length === 0) return 0;
    
    const newFiles: Record<string, BookFile> = {};
    copies.forEach(file => { newFiles[file.id] = file; });
    const newIds = copies.map(file => file.id);
    
    if (targetFolderId) {
      set({
        files: { ...state.files, ...newFiles },
        folders: {
          ...state.folders,
          [targetFolderId]: {
            ...state.folders[targetFolderId],
            fileIds: [...state.folders[targetFolderId].fileIds, ...newIds],
          },
        },
      });
    } else {
      set({
        files: { ...state.files, ...newFiles },
        projects: state.projects.map(p =>
          p.id === targetProjectId
            ? { ...p, fileIds: [...p.fileIds, ...newIds], updatedAt: now }
            : p
        ),
      });
    }
    return copies.length;
  },
  
  removeFiles: (fileIds) => {
    const state = get();
    const existing = fileIds.filter(fId => state.files[fId]);
    if (existing.length === 0) return;

    const label = `Removed ${existing.length} file${existing.length === 1 ? '' : 's'} from the library`;
    const undoStack = pushUndoEntry(get().undoStack, state, label);

    const files = { ...state.files };
    existing.forEach(id => delete files[id]);
    const removedSet = new Set(existing);

    set({
      files,
      projects: state.projects.map(p => ({
        ...p,
        fileIds: p.fileIds.filter(fId => !removedSet.has(fId)),
        updatedAt: new Date().toISOString(),
      })),
      folders: Object.fromEntries(
        Object.entries(state.folders).map(([id, folder]) => [
          id,
          { ...folder, fileIds: folder.fileIds.filter(fId => !removedSet.has(fId)) },
        ])
      ),
      selectedFileIds: state.selectedFileIds.filter(fId => !removedSet.has(fId)),
      clipboard: state.clipboard
        ? { ...state.clipboard, fileIds: state.clipboard.fileIds.filter(fId => !removedSet.has(fId)) }
        : null,
      undoStack,
    });
  },

  // Undo actions
  undoLast: () => {
    const { undoStack } = get();
    const last = undoStack[undoStack.length - 1];
    if (!last) return;

    set({
      projects: last.projects,
      folders: last.folders,
      files: last.files,
      activeProjectId: last.activeProjectId,
      // Selection / missing flags may reference restored ids; missing is
      // deliberately stale-safe, selection ids become valid again
      undoStack: undoStack.slice(0, -1),
    });
  },

  clearUndo: () => set({ undoStack: [] }),
  
  setSelectedFiles: (fileIds) => set({ selectedFileIds: fileIds }),
  
  toggleFileSelection: (id) => {
    set(state => ({
      selectedFileIds: state.selectedFileIds.includes(id)
        ? state.selectedFileIds.filter(fId => fId !== id)
        : [...state.selectedFileIds, id],
    }));
  },
  
  // Clipboard actions
  copyToClipboard: (fileIds) => {
    const state = get();
    const valid = fileIds.filter(fId => state.files[fId]);
    set({ clipboard: valid.length ? { mode: 'copy', fileIds: valid } : null });
  },
  
  cutToClipboard: (fileIds) => {
    const state = get();
    const valid = fileIds.filter(fId => state.files[fId]);
    set({ clipboard: valid.length ? { mode: 'cut', fileIds: valid } : null });
  },
  
  pasteFromClipboard: (targetProjectId, targetFolderId) => {
    const clipboard = get().clipboard;
    if (!clipboard || clipboard.fileIds.length === 0) return 0;
    
    if (clipboard.mode === 'copy') {
      return get().copyFiles(clipboard.fileIds, targetProjectId, targetFolderId);
    }
    
    get().moveFiles(clipboard.fileIds, targetProjectId, targetFolderId);
    set({ clipboard: null });
    return clipboard.fileIds.length;
  },
  
  clearClipboard: () => set({ clipboard: null }),
  
  // Queries
  getProjectFiles: (projectId, folderId = null) => {
    const state = get();
    const project = state.projects.find(p => p.id === projectId);
    if (!project) return [];
    
    let fileIds: string[];
    if (folderId === null) {
      fileIds = project.fileIds;
    } else {
      const folder = state.folders[folderId];
      if (!folder) return [];
      fileIds = folder.fileIds;
    }
    
    return fileIds
      .map(id => state.files[id])
      .filter((f): f is BookFile => !!f)
      .sort((a, b) => a.name.localeCompare(b.name));
  },
  
  getFolderChildren: (folderId) => {
    const state = get();
    const folder = state.folders[folderId];
    if (!folder) return [];
    
    return folder.childIds
      .map(id => state.folders[id])
      .filter((f): f is BookFolder => !!f)
      .sort((a, b) => a.name.localeCompare(b.name));
  },
  
  /** Files in this folder and, recursively, every subfolder — matches the project count */
  getFolderFileCount: (folderId) => {
    const state = get();
    const visit = (id: string): number => {
      const folder = state.folders[id];
      if (!folder) return 0;
      return (
        folder.fileIds.length +
        folder.childIds.reduce((sum, childId) => sum + visit(childId), 0)
      );
    };
    return visit(folderId);
  },
  
  /** Where a file lives — lets search-result rows accept drops into their own location */
  getFileLocation: (fileId) => {
    const state = get();
    const project = state.projects.find(p => p.fileIds.includes(fileId));
    if (project) return { projectId: project.id, folderId: null };
    const folder = Object.values(state.folders).find(f => f.fileIds.includes(fileId));
    if (folder) return { projectId: folder.projectId, folderId: folder.id };
    return null;
  },
  
  searchFiles: (query, projectId = null) => {
    const state = get();
    return searchLibrary(
      Object.values(state.files),
      state.projects,
      Object.values(state.folders),
      query,
      projectId,
    );
  },
}));

useBooks.subscribe((state, previous) => {
  if (!state.hydrated || !previous.hydrated) return;
  const current = snapshotBooksState(state);
  const before = snapshotBooksState(previous);
  if (current !== before) saver.schedule(current);
});
