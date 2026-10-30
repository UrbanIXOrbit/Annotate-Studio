import { create } from 'zustand';
import {
  loadBooksState,
  saveBooksState,
  importExternalFiles,
  type ExternalFileRef,
} from '@/lib/tauri-commands';
import { createSaver } from '@/lib/persist';
import { searchLibrary } from '@/lib/books-search';
import { uid } from '@/lib/utils';

/**
 * Virtual File System for Books Manager
 * Files are referenced by path — no copying, purely organizational
 */

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

interface BooksState {
  hydrated: boolean;
  projects: BookProject[];
  folders: Record<string, BookFolder>;
  files: Record<string, BookFile>;
  activeProjectId: string | null;
  selectedFolderId: string | null;
  selectedFileIds: string[];
  clipboard: BooksClipboard | null;
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
  importFiles: (projectId: string, folderId: string | null, paths: string[]) => Promise<void>;
  updateFile: (id: string, patch: Partial<Pick<BookFile, 'name' | 'tags' | 'notes'>>) => void;
  moveFiles: (fileIds: string[], targetProjectId: string, targetFolderId: string | null) => void;
  copyFiles: (fileIds: string[], targetProjectId: string, targetFolderId: string | null) => number;
  removeFiles: (fileIds: string[]) => void;
  setSelectedFiles: (fileIds: string[]) => void;
  toggleFileSelection: (id: string) => void;
  
  // Clipboard actions
  copyToClipboard: (fileIds: string[]) => void;
  cutToClipboard: (fileIds: string[]) => void;
  pasteFromClipboard: (targetProjectId: string, targetFolderId: string | null) => number;
  clearClipboard: () => void;
  
  // Queries
  getProjectFiles: (projectId: string, folderId?: string | null) => BookFile[];
  getFolderChildren: (folderId: string) => BookFolder[];
  searchFiles: (query: string, projectId?: string | string[] | null) => BookFile[];
}

type BooksStore = BooksState & BooksActions;

const PROJECT_COLORS = ['#3B82F6', '#8B5CF6', '#EC4899', '#F59E0B', '#10B981', '#06B6D4', '#6366F1'];

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
    
    const now = new Date().toISOString();
    set({
      folders,
      projects: projects.map(p =>
        p.id === folder.projectId || p.id === destinationProjectId ? { ...p, updatedAt: now } : p
      ),
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
  importFiles: async (projectId, folderId, paths) => {
    const state = get();
    if (!state.projects.some(p => p.id === projectId)) return;
    if (folderId && !state.folders[folderId]) return;
    
    try {
      const refs = await importExternalFiles(paths);
      const now = new Date().toISOString();
      
      const newFiles: Record<string, BookFile> = {};
      const fileIds: string[] = [];
      
      refs.forEach(ref => {
        const file: BookFile = {
          id: uid(),
          filePath: ref.path,
          name: ref.name,
          extension: ref.extension,
          size: ref.size,
          addedAt: now,
          modifiedAt: ref.modified_at,
          tags: [],
          notes: '',
        };
        newFiles[file.id] = file;
        fileIds.push(file.id);
      });
      
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
              ? { ...p, fileIds: [...p.fileIds, ...fileIds], updatedAt: new Date().toISOString() }
              : p
          ),
        });
      }
    } catch (error) {
      console.error('Failed to import files:', error);
    }
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
    
    set({ projects, folders });
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
    const files = { ...state.files };
    fileIds.forEach(id => delete files[id]);
    const removedSet = new Set(fileIds);
    
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
    });
  },
  
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
