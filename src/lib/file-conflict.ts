import { fileFingerprint, type FileFingerprint } from './tauri-commands.ts';

export function sameFingerprint(a: FileFingerprint | null, b: FileFingerprint | null): boolean {
  if (!a || !b) return false;
  return a.hash === b.hash && a.size === b.size && a.modifiedAt === b.modifiedAt;
}

export async function readFingerprint(path: string): Promise<FileFingerprint | null> {
  try {
    return await fileFingerprint(path);
  } catch {
    return null;
  }
}

export async function changedSince(path: string, baseline: FileFingerprint | null): Promise<boolean> {
  const current = await readFingerprint(path);
  return !sameFingerprint(current, baseline);
}
