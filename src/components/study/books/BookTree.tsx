'use client';

import React, { useRef, useState } from 'react';
import { useBooks } from '@/store/books';
import { RowMenu } from './RowMenu';
import {
  beginBooksDrag,
  booksClickSuppressed,
  isBooksDragBlockedTarget,
  isFolderInSubtree,
  useBooksDropTarget,
} from './dnd';
import {
  ChevronRight,
  ChevronDown,
  Folder,
  FolderOpen,
  Plus,
  FolderPlus,
  Pencil,
  Trash2,
  ClipboardPaste,
} from 'lucide-react';
import { cn } from '@/lib/utils';

/** Indent per nesting level, matching the folder cascade under a project */
const INDENT = 14;

function FolderNode({ folderId, level }: { folderId: string; level: number }) {
  const {
    folders,
    activeProjectId,
    selectedFolderId,
    setActiveProject,
    setSelectedFolder,
    toggleFolderCollapse,
    renameFolder,
    deleteFolder,
    createFolder,
    getFolderChildren,
    moveFiles,
    copyFiles,
    moveFolder,
    clipboard,
    pasteFromClipboard,
  } = useBooks();

  const folder = folders[folderId];
  const [editingName, setEditingName] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [creatingChild, setCreatingChild] = useState(false);
  const [childName, setChildName] = useState('');
  // Guards against the unmount blur firing after Enter/Escape already committed
  const childCommitted = useRef(false);

  // Drop zone for files (Alt/Option copies) and folders — registered with the
  // pointer-based drag engine; hovering adds the .drop-target classes itself.
  const dropRef = useBooksDropTarget<HTMLDivElement>({
    accepts: (payload) =>
      payload.kind === 'files' ||
      (payload.folderId !== folderId && !isFolderInSubtree(folders, folderId, payload.folderId)),
    onDrop: (payload, mode) => {
      if (!folder) return;
      if (payload.kind === 'files') {
        if (mode === 'copy') {
          const copied = copyFiles(payload.fileIds, folder.projectId, folderId);
          if (copied === 0) alert('Those files are already in this folder.');
        } else {
          moveFiles(payload.fileIds, folder.projectId, folderId);
        }
      } else {
        moveFolder(payload.folderId, folderId, folder.projectId);
      }
    },
  });

  if (!folder) return null;

  const children = getFolderChildren(folderId);
  const isSelected = selectedFolderId === folderId;
  const hasChildren = children.length > 0;

  const handleDragStart = (event: React.PointerEvent<HTMLElement>) => {
    if (isBooksDragBlockedTarget(event.target as Element)) return;
    beginBooksDrag(event, { kind: 'folder', folderId }, folder.name);
  };

  const handleSelect = () => {
    if (isEditing || booksClickSuppressed()) return;
    // The tree shows every project at once, so a folder click may also need
    // to make its project active before the folder selection sticks
    if (folder.projectId !== activeProjectId) setActiveProject(folder.projectId);
    setSelectedFolder(folderId);
  };

  const handleRename = () => {
    if (editingName.trim()) renameFolder(folderId, editingName.trim());
    setIsEditing(false);
  };

  const cancelCreateChild = () => {
    childCommitted.current = true;
    setChildName('');
    setCreatingChild(false);
  };

  const handleCreateChild = () => {
    if (childCommitted.current) {
      childCommitted.current = false;
      return;
    }
    childCommitted.current = true;
    if (childName.trim()) createFolder(folder.projectId, childName.trim(), folderId);
    setChildName('');
    setCreatingChild(false);
  };

  const pasteCount = clipboard?.fileIds.length ?? 0;

  return (
    <div className="folder-node">
      <div
        ref={dropRef}
        data-books-drop=""
        className={cn(
          'folder-row',
          isSelected && 'selected',
        )}
        style={{ paddingLeft: 5 + level * INDENT }}
        onPointerDown={isEditing ? undefined : handleDragStart}
        onClick={handleSelect}
      >
        {isEditing ? (
          <input
            type="text"
            className="folder-edit-input"
            value={editingName}
            onChange={(e) => setEditingName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleRename();
              if (e.key === 'Escape') setIsEditing(false);
            }}
            onBlur={handleRename}
            onClick={(e) => e.stopPropagation()}
            autoFocus
            dir="auto"
          />
        ) : (
          <>
            <button
              type="button"
              className="folder-chevron"
              onClick={(event) => {
                event.stopPropagation();
                toggleFolderCollapse(folderId);
              }}
              disabled={!hasChildren}
              aria-label={folder.collapsed ? 'Expand folder' : 'Collapse folder'}
            >
              {hasChildren && (folder.collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />)}
            </button>

            <div className="folder-main">
              {isSelected || !folder.collapsed ? <FolderOpen size={15} /> : <Folder size={15} />}
              <span className="folder-name" title={folder.name}>
                {folder.name}
              </span>
            </div>

            {folder.fileIds.length > 0 && (
              <span className="folder-count" title={`${folder.fileIds.length} file${folder.fileIds.length === 1 ? '' : 's'}`}>
                {folder.fileIds.length}
              </span>
            )}

            <RowMenu
              items={[
                ...(pasteCount > 0
                  ? [
                      {
                        label: `Paste ${pasteCount} file${pasteCount === 1 ? '' : 's'}`,
                        icon: <ClipboardPaste size={14} />,
                        onClick: () => {
                          const count = pasteFromClipboard(folder.projectId, folderId);
                          if (count === 0) alert('Those files are already in this folder.');
                        },
                      },
                    ]
                  : []),
                {
                  label: 'New subfolder',
                  icon: <FolderPlus size={14} />,
                  onClick: () => {
                    childCommitted.current = false;
                    setCreatingChild(true);
                  },
                },
                {
                  label: 'Rename',
                  icon: <Pencil size={14} />,
                  onClick: () => {
                    setEditingName(folder.name);
                    setIsEditing(true);
                  },
                },
                {
                  label: 'Delete',
                  icon: <Trash2 size={14} />,
                  danger: true,
                  dividerBefore: true,
                  onClick: () => {
                    if (
                      confirm(
                        `Delete "${folder.name}" and all its contents? This only removes references, not the actual files.`
                      )
                    ) {
                      deleteFolder(folderId);
                    }
                  },
                },
              ]}
            />
          </>
        )}
      </div>

      {creatingChild && (
        <div className="folder-new" style={{ paddingLeft: 19 + level * INDENT }}>
          <input
            type="text"
            className="folder-edit-input"
            placeholder="Folder name…"
            value={childName}
            onChange={(e) => setChildName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleCreateChild();
              if (e.key === 'Escape') cancelCreateChild();
            }}
            onBlur={handleCreateChild}
            autoFocus
            dir="auto"
          />
        </div>
      )}

      {!folder.collapsed && children.map((child) => (
        <FolderNode key={child.id} folderId={child.id} level={level + 1} />
      ))}
    </div>
  );
}

function ProjectNode({
  projectId,
  editing,
  editName,
  onEditNameChange,
  onEditStart,
  onRename,
  onRenameCancel,
  onDelete,
  creatingFolder,
  onStartCreateFolder,
  onEndCreateFolder,
}: {
  projectId: string;
  editing: boolean;
  editName: string;
  onEditNameChange: (value: string) => void;
  onEditStart: () => void;
  onRename: () => void;
  onRenameCancel: () => void;
  onDelete: () => void;
  creatingFolder: boolean;
  onStartCreateFolder: () => void;
  onEndCreateFolder: () => void;
}) {
  const {
    projects,
    folders,
    activeProjectId,
    selectedFolderId,
    setActiveProject,
    toggleProjectCollapse,
    createFolder,
    moveFiles,
    copyFiles,
    moveFolder,
    clipboard,
    pasteFromClipboard,
  } = useBooks();

  const project = projects.find((p) => p.id === projectId);
  const [childName, setChildName] = useState('');
  // Guards against the unmount blur firing after Enter/Escape already committed
  const childCommitted = useRef(false);

  // The project row doubles as the "root" drop target: dropping files here
  // moves (Alt/Option copies) them to the project's top level; a dropped
  // folder is re-homed into this project, subfolders and all
  const dropRef = useBooksDropTarget<HTMLDivElement>({
    accepts: () => !!project,
    onDrop: (payload, mode) => {
      if (!project) return;
      if (payload.kind === 'files') {
        if (mode === 'copy') {
          const copied = copyFiles(payload.fileIds, projectId, null);
          if (copied === 0) alert('Those files are already in this project.');
        } else {
          moveFiles(payload.fileIds, projectId, null);
        }
      } else {
        moveFolder(payload.folderId, null, projectId);
      }
    },
  });

  if (!project) return null;

  const isActive = activeProjectId === projectId;
  // Selected when the root itself is being viewed; "contains-selection" when
  // one of its folders is — a subtle breadcrumb back up the tree
  const isSelected = isActive && selectedFolderId === null;
  const containsSelection = isActive && selectedFolderId !== null;
  const expanded = !project.collapsed || creatingFolder;

  const rootFolders = project.rootFolderIds
    .map((id) => folders[id])
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));

  const folderFileCount = Object.values(folders)
    .filter((folder) => folder.projectId === projectId)
    .reduce((sum, folder) => sum + folder.fileIds.length, 0);
  const fileCount = project.fileIds.length + folderFileCount;

  const handleOpen = () => {
    if (editing || booksClickSuppressed()) return;
    // Activating shows the project's root files; also reveal its folders
    setActiveProject(projectId);
    if (project.collapsed) toggleProjectCollapse(projectId);
  };

  const cancelCreateChild = () => {
    childCommitted.current = true;
    setChildName('');
    onEndCreateFolder();
  };

  const handleCreateChild = () => {
    if (childCommitted.current) {
      childCommitted.current = false;
      return;
    }
    childCommitted.current = true;
    if (childName.trim()) createFolder(projectId, childName.trim(), null);
    setChildName('');
    onEndCreateFolder();
  };

  const pasteCount = clipboard?.fileIds.length ?? 0;

  return (
    <div className="project-node">
      <div
        ref={dropRef}
        data-books-drop=""
        className={cn(
          'project-row',
          isSelected && 'selected',
          containsSelection && 'contains-selection',
        )}
        onClick={handleOpen}
      >
        {editing ? (
          <input
            type="text"
            className="folder-edit-input"
            value={editName}
            onChange={(e) => onEditNameChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onRename();
              if (e.key === 'Escape') onRenameCancel();
            }}
            onBlur={onRename}
            onClick={(e) => e.stopPropagation()}
            autoFocus
            dir="auto"
          />
        ) : (
          <>
            <button
              type="button"
              className="folder-chevron"
              onClick={(event) => {
                event.stopPropagation();
                toggleProjectCollapse(projectId);
              }}
              disabled={rootFolders.length === 0 && !creatingFolder}
              aria-label={project.collapsed ? 'Expand project' : 'Collapse project'}
            >
              {rootFolders.length > 0 || creatingFolder ? (
                project.collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />
              ) : null}
            </button>

            <span className="project-dot" style={{ backgroundColor: project.color }} />

            <span className="project-name" title={project.name}>
              {project.name}
            </span>

            {fileCount > 0 && (
              <span
                className="folder-count"
                title={`${fileCount} file${fileCount === 1 ? '' : 's'} in this project`}
              >
                {fileCount}
              </span>
            )}

            <RowMenu
              items={[
                ...(pasteCount > 0
                  ? [
                      {
                        label: `Paste ${pasteCount} file${pasteCount === 1 ? '' : 's'}`,
                        icon: <ClipboardPaste size={14} />,
                        onClick: () => {
                          const count = pasteFromClipboard(projectId, null);
                          if (count === 0) alert('Those files are already in this project.');
                        },
                      },
                    ]
                  : []),
                {
                  label: 'New folder',
                  icon: <FolderPlus size={14} />,
                  onClick: () => {
                    childCommitted.current = false;
                    setChildName('');
                    onStartCreateFolder();
                  },
                },                {
                  label: 'Rename',
                  icon: <Pencil size={14} />,
                  onClick: onEditStart,
                },
                {
                  label: 'Delete',
                  icon: <Trash2 size={14} />,
                  danger: true,
                  dividerBefore: true,
                  onClick: onDelete,
                },
              ]}
            />
          </>
        )}
      </div>

      {creatingFolder && (
        <div className="folder-new" style={{ paddingLeft: 5 + INDENT }}>
          <input
            type="text"
            className="folder-edit-input"
            placeholder="Folder name…"
            value={childName}
            onChange={(e) => setChildName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleCreateChild();
              if (e.key === 'Escape') cancelCreateChild();
            }}
            onBlur={handleCreateChild}
            autoFocus
            dir="auto"
          />
        </div>
      )}

      {expanded && rootFolders.map((folder) => (
        <FolderNode key={folder.id} folderId={folder.id} level={1} />
      ))}
    </div>
  );
}

interface BookTreeProps {
  newProjectOpen: boolean;
  onNewProjectOpenChange: (open: boolean) => void;
}

/**
 * The library sidebar: projects and their folders as one file-manager style
 * tree. Clicking a project shows its root files; clicking a folder shows that
 * folder's files in the panel beside the tree.
 */
export function BookTree({ newProjectOpen, onNewProjectOpenChange }: BookTreeProps) {
  const {
    projects,
    activeProjectId,
    createProject,
    updateProject,
    deleteProject,
    toggleProjectCollapse,
  } = useBooks();
  const [newProjectName, setNewProjectName] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [creatingInProjectId, setCreatingInProjectId] = useState<string | null>(null);
  // Guards against the unmount blur firing after Enter/Escape already committed
  const newProjectCommitted = useRef(false);

  const handleCreateProject = () => {
    if (newProjectCommitted.current) {
      newProjectCommitted.current = false;
      return;
    }
    newProjectCommitted.current = true;
    if (newProjectName.trim()) createProject(newProjectName.trim());
    setNewProjectName('');
    onNewProjectOpenChange(false);
  };

  const cancelCreateProject = () => {
    newProjectCommitted.current = true;
    setNewProjectName('');
    onNewProjectOpenChange(false);
  };

  const handleRename = (id: string) => {
    if (editName.trim()) updateProject(id, { name: editName.trim() });
    setEditingId(null);
  };

  const handleDelete = (id: string) => {
    if (confirm('Delete this project? All folders and file references will be removed (actual files remain untouched).')) {
      deleteProject(id);
    }
  };

  // Root-level folder creation lands inside the given project (the header
  // button targets the active one; a project's row menu can target any)
  const startCreateFolder = (projectId: string) => {
    const project = projects.find((p) => p.id === projectId);
    if (project?.collapsed) toggleProjectCollapse(projectId);
    setCreatingInProjectId(projectId);
  };

  return (
    <div className="book-tree">
      <div className="books-panel-header">
        <div className="books-panel-title">
          <span>Library</span>
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          <button
            type="button"
            className="icon-btn icon-btn-sm"
            title={activeProjectId ? 'New folder in current project' : 'Create a project first'}
            disabled={!activeProjectId}
            onClick={() => activeProjectId && startCreateFolder(activeProjectId)}
          >
            <FolderPlus size={15} />
          </button>
          <button
            type="button"
            className="icon-btn icon-btn-sm"
            title="New project"
            onClick={() => {
              newProjectCommitted.current = false;
              onNewProjectOpenChange(true);
            }}
          >
            <Plus size={15} />
          </button>
        </div>
      </div>

      <div className="folder-tree-list">
        {projects.map((project) => (
          <ProjectNode
            key={project.id}
            projectId={project.id}
            editing={editingId === project.id}
            editName={editName}
            onEditNameChange={setEditName}
            onEditStart={() => {
              setEditingId(project.id);
              setEditName(project.name);
            }}
            onRename={() => handleRename(project.id)}
            onRenameCancel={() => setEditingId(null)}
            onDelete={() => handleDelete(project.id)}
            creatingFolder={creatingInProjectId === project.id}
            onStartCreateFolder={() => startCreateFolder(project.id)}
            onEndCreateFolder={() => setCreatingInProjectId(null)}
          />
        ))}

        {newProjectOpen && (
          <div className="folder-new" style={{ paddingLeft: 7 }}>
            <input
              type="text"
              className="folder-edit-input"
              placeholder="Project name…"
              value={newProjectName}
              onChange={(e) => setNewProjectName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreateProject();
                if (e.key === 'Escape') cancelCreateProject();
              }}
              onBlur={handleCreateProject}
              autoFocus
              dir="auto"
            />
          </div>
        )}

        {projects.length === 0 && !newProjectOpen && (
          <div className="books-panel-empty">
            <FolderPlus size={28} strokeWidth={1.5} />
            <h4>No projects yet</h4>
            <p>Projects group your books, papers and notes into a tree of folders.</p>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              style={{ marginTop: 8 }}
              onClick={() => {
                newProjectCommitted.current = false;
                onNewProjectOpenChange(true);
              }}
            >
              <Plus size={14} />
              New project
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
