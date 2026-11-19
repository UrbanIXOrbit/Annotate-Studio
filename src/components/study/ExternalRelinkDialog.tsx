'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { FolderOpen, Loader2, Link2, RefreshCw } from 'lucide-react';
import Dialog from '@/components/ui/Dialog';
import { useSettings } from '@/store/settings';
import { useLibrary } from '@/store/library';
import { useBooks } from '@/store/books';
import { useCanvas } from '@/store/canvas';
import { useAnnotations } from '@/store/annotations';
import { toast } from '@/store/toast';
import { isTauri, statExternalFile, type StudyFile } from '@/lib/tauri-commands';
import { isExternalPath, baseName, stripExtension } from '@/lib/utils';

interface MissingRef {
  path: string;
  name: string;
  size?: number;
  modifiedAt?: string;
}

interface Mapping {
  path: string;
  file: StudyFile;
}

/** Every absolute path the app keeps a reference to, including saved metadata. */
function referencedPaths(): string[] {
  const settings = useSettings.getState();
  const library = useLibrary.getState();
  const books = useBooks.getState();
  const canvas = useCanvas.getState();
  const paths = new Set<string>();
  const add = (path: string | undefined | null) => {
    if (path && isExternalPath(path)) paths.add(path);
  };
  settings.externalFiles.forEach(add);
  settings.captureNotes.forEach((note) => add(note.path));
  add(settings.inboxNotePath);
  Object.keys(settings.fileMeta).forEach(add);
  library.files.forEach((file) => add(file.path));
  Object.values(books.files).forEach((file) => add(file.filePath));
  canvas.workspaces.forEach((workspace) =>
    workspace.resources.forEach((resource) => {
      add(resource.filePath);
      add(resource.source?.filePath);
    }),
  );
  return [...paths];
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
        referencedPaths().map(async (path) => {
          const file = await statExternalFile(path).catch(() => null);
          return file ? null : { path, name: baseName(path) };
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
    await Promise.all(
      missing.map(async (ref) => {
        const candidate = `${folder.replace(/[\\/]+$/, '')}/${ref.name}`;
        const file = await statExternalFile(candidate).catch(() => null);
        if (file) next[ref.path] = { path: file.path, file };
      }),
    );
    setMapping(next);
    if (Object.keys(next).length === 0) toast.warning('No matching files', `None of the ${missing.length} files were found in that folder.`);
  };

  const chooseFile = async (ref: MissingRef) => {
    if (!isTauri()) return;
    const { open: pick } = await import('@tauri-apps/plugin-dialog');
    const selection = await pick({ multiple: false, defaultPath: ref.name });
    if (!selection || Array.isArray(selection)) return;
    const file = await statExternalFile(selection).catch(() => null);
    if (!file) {
      toast.error('Could not read that file');
      return;
    }
    setMapping((current) => ({ ...current, [ref.path]: { path: file.path, file } }));
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
        const library = useLibrary.getState();
        if (library.files.some((entry) => entry.path === oldPath)) library.replaceExternal(oldPath, file);
        else library.upsert(file);
        useCanvas.getState().replaceFilePath(oldPath, path, stripExtension(file.name));
        useAnnotations.getState().invalidate(path);
      }
      const captureNotes = settings.captureNotes.map((note) =>
        simple[note.path] ? { ...note, path: simple[note.path] } : note,
      );
      settings.update({
        captureNotes,
        inboxNotePath: simple[settings.inboxNotePath] ?? settings.inboxNotePath,
      });
      useBooks.getState().relinkFilePaths(simple);
      toast.success('Files reconnected', `${entries.length} reference${entries.length === 1 ? '' : 's'} updated.`);
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
      width={620}
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
        These files are referenced where they live, not copied into the app. After a restore they may be in a different folder or on another computer.
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
        <p className="muted">All referenced files are available.</p>
      ) : (
        <div className="book-file-body" style={{ maxHeight: 320, overflow: 'auto' }}>
          {missing.map((ref) => (
            <div key={ref.path} className="path-row" style={{ justifyContent: 'space-between' }}>
              <div>
                <strong>{ref.name}</strong>
                <div className="muted" style={{ fontSize: 11, overflowWrap: 'anywhere' }}>{ref.path}</div>
              </div>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => void chooseFile(ref)}>
                {mapping[ref.path] ? baseName(mapping[ref.path].path) : 'Locate…'}
              </button>
            </div>
          ))}
        </div>
      )}
    </Dialog>
  );
}
