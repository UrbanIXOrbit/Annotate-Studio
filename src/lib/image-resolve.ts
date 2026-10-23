import { readFileBytes } from './tauri-commands';
import { decodeDataUrl, sniffImage, SNIFF_MIME } from './image-sniff';
import type { ImageResolver, ResolvedImage } from './note-export';

const MAX_DIMENSION = 1800;

/** Draw any image the browser can decode onto a canvas and re-encode it as PNG (Word/PDF only embed PNG and JPEG). */
async function toPng(bytes: Uint8Array, mime: string): Promise<ResolvedImage | null> {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
  try {
    const image = new Image();
    image.decoding = 'async';
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('Could not decode image'));
      image.src = url;
    });
    let width = image.naturalWidth || 800;
    let height = image.naturalHeight || 600;
    const scale = Math.min(1, MAX_DIMENSION / Math.max(width, height));
    width = Math.max(1, Math.round(width * scale));
    height = Math.max(1, Math.round(height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.drawImage(image, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) return null;
    return { bytes: new Uint8Array(await blob.arrayBuffer()), type: 'png', width, height };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Load an image referenced by a note. Workspace-relative paths are read like the preview does;
 * data: URLs are decoded. Web addresses are never fetched, so exporting never needs a network.
 */
export const resolveNoteImage: ImageResolver = async (src) => {
  let bytes: Uint8Array | null;
  if (/^data:/i.test(src)) bytes = decodeDataUrl(src);
  else if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return null;
  else bytes = await readFileBytes(src);
  if (!bytes) return null;

  const sniffed = sniffImage(bytes);
  if (!sniffed) return null;
  if ((sniffed.type === 'png' || sniffed.type === 'jpg') && sniffed.width && sniffed.height) {
    return { bytes, type: sniffed.type, width: sniffed.width, height: sniffed.height };
  }
  return toPng(bytes, SNIFF_MIME[sniffed.type]);
};
