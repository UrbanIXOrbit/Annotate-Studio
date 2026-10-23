import { isTauri } from './tauri-commands';
import { FORMAT_META, buildDocx, buildMarkdown, buildPdf, exportFileName, type ExportFormat } from './annotation-export';
import type { Report } from './annotations';

export interface ExportResult {
  status: 'saved' | 'downloaded' | 'cancelled';
  path?: string;
  /** Characters the PDF fonts could not draw (they are replaced by "?"). */
  replacedChars: number;
}

export async function loadFont(fileName: string): Promise<Uint8Array> {
  const response = await fetch(new URL(`/fonts/${fileName}`, window.location.href).href);
  if (!response.ok) throw new Error(`Could not load font ${fileName}`);
  return new Uint8Array(await response.arrayBuffer());
}

function download(bytes: Uint8Array, fileName: string, mime: string) {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Let the user save a finished file: a native Save dialog in the desktop app, a download in a browser. */
export async function saveExportedFile(
  bytes: Uint8Array,
  defaultName: string,
  meta: { label: string; extension: string; mime: string },
  replacedChars = 0,
): Promise<ExportResult> {
  if (!isTauri()) {
    download(bytes, defaultName, meta.mime);
    return { status: 'downloaded', replacedChars };
  }
  const { save } = await import('@tauri-apps/plugin-dialog');
  const target = await save({ defaultPath: defaultName, filters: [{ name: meta.label, extensions: [meta.extension] }] });
  if (!target) return { status: 'cancelled', replacedChars };
  const { writeFile } = await import('@tauri-apps/plugin-fs');
  await writeFile(target, bytes);
  return { status: 'saved', path: target, replacedChars };
}

/** Build the annotations document in the chosen format and let the user save it. */
export async function exportReport(report: Report, format: ExportFormat): Promise<ExportResult> {
  let bytes: Uint8Array;
  let replacedChars = 0;
  if (format === 'md') {
    bytes = buildMarkdown(report);
  } else if (format === 'docx') {
    bytes = await buildDocx(report);
  } else {
    const built = await buildPdf(report, loadFont);
    bytes = built.bytes;
    replacedChars = built.replacedChars;
  }
  return saveExportedFile(bytes, exportFileName(report, format), FORMAT_META[format], replacedChars);
}
