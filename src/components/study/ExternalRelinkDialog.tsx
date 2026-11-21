'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { FolderOpen, Loader2, Link2, RefreshCw, Trash2 } from 'lucide-react';
import Dialog from '@/components/ui/Dialog';
import { useSettings } from '@/store/settings';
import { useWorkspaceScopes } from '@/store/workspace-scopes';
import { currentWorkspace } from '@/store/workspace-context';
import { useLibrary } from '@/store/library';
import { useBooks } from '@/store/books';
import { useCanvas } from '@/store/canvas';
import { useAnnotations } from '@/store/annotations';
import { toast } from '@/store/toast';
import { isTauri, pathExists, statExternalFile, type StudyFile } from '@/lib/tauri-commands';
import { isExternalPath, baseName, stripExtension } from '@/lib/utils';

type RefKind = 'file' | 'folder';

interface MissingRef {
  path: string;
  name: string;
  kind: RefKind;
  size?: number;
  modifiedAt?: string;
}

interface Mapping {
  path: string;
  file?: StudyFile;
}

/** Every absolute path the app references, including folder settings. */
function referencedRefs(): MissingRef[] {
  const settings = useSettings.getState();
  const library = useLibrary.getState();
  const books = useBooks.getState();
  const canvas = useCanvas.getState();
  const found = new Map<string, MissingRef>();
  const add = (path: string | undefined | null, kind: RefKind = 'file') => {
    if (!path || !isExternalPath(path) || found.has(path)) return;
    found.set(path, { path, name: baseName(path), kind });
  };
  settings.externalFiles.forEach((path) => add(path));
  settings.captureNotes.forEach((note) => add(note.path));
  add(settings.inboxNotePath);
  add(settings.noteFolder, 'folder');
  add(settings.recordingFolder, 'folder');
  add(settings.noteClip.lastNote);
  const scope = useWorkspaceScopes.getState().get(currentWorkspace());
  Object.keys(scope.recentFiles).forEach((path) => add(path));
  Object.keys(scope.fileMeta).forEach((path) => add(path));
  library.files.forEach((file) => add(file.path));
  Object.values(books.files).forEach((file) => add(file.filePath));
  canvas.workspaces.forEach((workspace) =>
    workspace.resources.forEach((resource) => {
      add(resource.filePath);
      add(resource.source?.filePath);
    }),
  );
  return [...found.values()];
}

export default function ExternalRelinkDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [loading, setLoading] = useState(false);
  const [missing, setMissing] = useState<MissingRef[]>([]);
  const [mapping, setMapping] = useState<Record<string, Mapping>>({});
  const [busy, setBusy] = useState(false);

  const scan = useCallback(async () => {
    setLoading(true);
    setMapping({});
    try {
      const refs = await Promise.all(
        referencedRefs().map(async (ref) => {
          const exists = ref.kind === 'folder'
            ? await pathExists(ref.path).catch(() => false)
            : !!(await statExternalFile(ref.path).catch(() => null));
          return exists ? null : ref;
        }),
      );
      setMissing(refs.filter((ref): ref is MissingRef => ref !== null));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void scan();
  }, [open, scan]);

  const chooseFolder = async () => {
    if (!isTauri()) return;
    const { open: pick } = await import('@tauri-apps/plugin-dialog');
    const folder = await pick({ directory: true, multiple: false });
    if (!folder || Array.isArray(folder)) return;
    const next: Record<string, Mapping> = {};
    const fileRefs = missing.filter((ref) => ref.kind === 'file');
    if (fileRefs.length > 0) {
      const { readDir } = await import('@tauri-apps/plugin-fs');
      const byName = new Map<string, string[]>();
      let scanned = 0;
      const sep = /\\/.test(folder) && !folder.includes('/') ? '\\' : '/';
      const walk = async (dir: string, depth: number): Promise<void> => {
        if (depth > 4 || scanned > 4000) return;
        for (const entry of await readDir(dir)) {
          scanned += 1;
          const full = `${dir.replace(/[\\/]+$/, '')}${sep}${entry.name}`;
          if (entry.isFile) {
            const key = entry.name.toLowerCase();
            byName.set(key, [...(byName.get(key) ?? []), full]);
          } else if (entry.isDirectory) {
            await walk(full, depth + 1);
          }
        }
      };
      try {
        await walk(folder, 0);
      } catch (error) {
        toast.error('Could not read that folder', error);
        return;
      }
      await Promise.all(
        fileRefs.map(async (ref) => {
          for (const candidate of byName.get(ref.name.toLowerCase()) ?? []) {
            const file = await statExternalFile(candidate).catch(() => null);
            if (!file) continue;
            if (ref.size !== undefined && file.size !== ref.size) continue;
            next[ref.path] = { path: file.path, file };
            return;
          }
        }),
      );
    }
    for (const ref of missing.filter((item) => item.kind === 'folder')) {
      next[ref.path] = { path: folder };
    }
    setMapping(next);
    if (Object.keys(next).length === 0) {
      toast.warning('No matching files', `None of the ${missing.length} references were found in that folder.`);
    }
  };

  const chooseLocation = async (ref: MissingRef) => {
    if (!isTauri()) return;
    const { open: pick } = await import('@tauri-apps/plugin-dialog');
    const selection = await pick({ directory: ref.kind === 'folder', multiple: false, defaultPath: ref.name });
    if (!selection || Array.isArray(selection)) return;
    if (ref.kind === 'folder') {
      setMapping((current) => ({ ...current, [ref.path]: { path: selection } }));
      return;
    }
    const file = await statExternalFile(selection).catch(() => null);
    if (!file) {
      toast.error('Could not read that file');
      return;
    }
    setMapping((current) => ({ ...current, [ref.path]: { path: file.path, file } }));
  };

  const forget = (ref: MissingRef) => {
    const settings = useSettings.getState();
    if (settings.externalFiles.includes(ref.path)) settings.removeExternalFile(ref.path);
    if (settings.captureNotes.some((note) => note.path === ref.path)) {
      settings.update({ captureNotes: settings.captureNotes.filter((note) => note.path !== ref.path) });
    }
    if (settings.inboxNotePath === ref.path) settings.update({ inboxNotePath: '' });
    if (settings.noteFolder === ref.path) settings.update({ noteFolder: '' });
    if (settings.recordingFolder === ref.path) settings.update({ recordingFolder: '' });
    if (settings.noteClip.lastNote === ref.path) settings.updateNoteClip({ lastNote: '' });
    settings.forgetRecent(ref.path);
    settings.removeFileMeta(ref.path);
    useLibrary.getState().removeExternal(ref.path);
    useLibrary.getState().remove(ref.path);
    useBooks.getState().forgetFilePaths([ref.path]);
    useCanvas.getState().closeByFilePath(ref.path);
    setMapping((current) => {
      const next = { ...current };
      delete next[ref.path];
      return next;
    });
    setMissing((current) => current.filter((item) => item.path !== ref.path));
  };

  const apply = async () => {
    const entries = Object.entries(mapping);
    if (entries.length === 0) return;
    setBusy(true);
    try {
      const settings = useSettings.getState();
      const simple: Record<string, string> = {};
      for (const [oldPath, { path, file }] of entries) {
        simple[oldPath] = path;
        if (settings.externalFiles.includes(oldPath)) settings.replaceExternalFile(oldPath, path);
        else settings.addExternalFile(path);
        settings.moveFileMeta(oldPath, path);
        if (file) {
          const library = useLibrary.getState();
          if (library.files.some((entry) => entry.path === oldPath)) library.replaceExternal(oldPath, file);
          else library.upsert(file);
          useAnnotations.getState().invalidate(path);
        }
        useCanvas.getState().replaceFilePath(oldPath, path, stripExtension(file?.name ?? baseName(path)));
      }
      const captureNotes = settings.captureNotes.map((note) =>
        simple[note.path] ? { ...note, path: simple[note.path] } : note,
      );
      const scope = useWorkspaceScopes.getState().get(currentWorkspace());
      const recentFiles: Record<string, number> = {};
      for (const [path, at] of Object.entries(scope.recentFiles)) recentFiles[simple[path] ?? path] = at;
      useWorkspaceScopes.getState().set(currentWorkspace(), { recentFiles });
      settings.update({
        captureNotes,
         inboxNotePath: simple[settings.inboxNotePath] ?? settings.inboxNotePath,
        noteFolder: simple[settings.noteFolder] ?? settings.noteFolder,
        recordingFolder: simple[settings.recordingFolder] ?? settings.recordingFolder,
        noteClip: {
          ...settings.noteClip,
          lastNote: simple[settings.noteClip.lastNote] ?? settings.noteClip.lastNote,
        },
      });
      useBooks.getState().relinkFilePaths(simple);
      toast.success('References reconnected', `${entries.length} updated.`);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Reconnect external files"
      width={680}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={() => void apply()} disabled={busy || Object.keys(mapping).length === 0}>
            {busy ? <Loader2 size={14} className="spin" /> : <Link2 size={14} />} Reconnect {Object.keys(mapping).length || ''}
          </button>
        </>
      }
    >
      <p className="muted">
        Files and folders you chose stay where they are. After a restore or a move, point these references at their new location, or forget ones you no longer use.
      </p>
      <div className="settings-card">
        <div className="page-actions">
          <button type="button" className="btn btn-secondary" onClick={() => void chooseFolder()} disabled={missing.length === 0 || loading}>
            <FolderOpen size={14} /> Find all in a folder
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => void scan()} disabled={loading}>
            <RefreshCw size={14} className={loading ? 'spin' : undefined} /> Rescan
          </button>
        </div>
      </div>
      {loading ? (
        <p className="muted">Checking files…</p>
      ) : missing.length === 0 ? (
        <p className="muted">All referenced files and folders are available.</p>
      ) : (
        <div className="book-file-body" style={{ maxHeight: 320, overflow: 'auto' }}>
          {missing.map((ref) => (
            <div key={ref.path} className="path-row" style={{ justifyContent: 'space-between' }}>
              <div>
                <strong>{ref.name}</strong>
                <div className="muted" style={{ fontSize: 11, overflowWrap: 'anywhere' }}>
                  {ref.kind === 'folder' ? 'Folder' : 'File'} · {ref.path}
                </div>
              </div>
              <div className="page-actions">
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => void chooseLocation(ref)}>
                  {mapping[ref.path] ? baseName(mapping[ref.path].path) : 'Locate…'}
                </button>
                <button type="button" className="icon-btn icon-btn-sm icon-btn-danger" title="Forget this reference" onClick={() => forget(ref)}>
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </Dialog>
  );
}
