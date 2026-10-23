export type SniffedType = 'png' | 'jpg' | 'gif' | 'webp' | 'bmp' | 'svg' | 'avif';

export interface Sniffed {
  type: SniffedType;
  /** Pixel size, when it can be read from the header. */
  width?: number;
  height?: number;
}

const u16 = (b: Uint8Array, at: number) => (b[at] << 8) | b[at + 1];
const u32 = (b: Uint8Array, at: number) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
const ascii = (b: Uint8Array, at: number, length: number) => String.fromCharCode(...b.subarray(at, at + length));

/** Identify an image from its first bytes and read its size without decoding it. */
export function sniffImage(bytes: Uint8Array): Sniffed | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0x89 && ascii(bytes, 1, 3) === 'PNG') {
    return { type: 'png', width: u32(bytes, 16), height: u32(bytes, 20) };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2;
    while (at + 9 < bytes.length) {
      if (bytes[at] !== 0xff) {
        at += 1;
        continue;
      }
      const marker = bytes[at + 1];
      if (marker === 0xff) {
        at += 1;
        continue;
      }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { type: 'jpg', height: u16(bytes, at + 5), width: u16(bytes, at + 7) };
      }
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        at += 2;
        continue;
      }
      at += 2 + u16(bytes, at + 2);
    }
    return { type: 'jpg' };
  }
  if (ascii(bytes, 0, 4) === 'GIF8') return { type: 'gif', width: bytes[6] | (bytes[7] << 8), height: bytes[8] | (bytes[9] << 8) };
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return { type: 'webp' };
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return { type: 'bmp' };
  if (ascii(bytes, 4, 8) === 'ftypavif' || ascii(bytes, 4, 8) === 'ftypavis') return { type: 'avif' };
  const head = new TextDecoder().decode(bytes.subarray(0, 512)).trimStart();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return { type: 'svg' };
  return null;
}

export const SNIFF_MIME: Record<SniffedType, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
};

/** Decode a data: URL into bytes. Returns null for anything that is not a data URL. */
export function decodeDataUrl(url: string): Uint8Array | null {
  const match = /^data:([^,]*?),(.*)$/is.exec(url);
  if (!match) return null;
  try {
    if (/;base64/i.test(match[1])) {
      const binary = atob(match[2].replace(/\s+/g, ''));
      return Uint8Array.from(binary, (char) => char.charCodeAt(0));
    }
    return new TextEncoder().encode(decodeURIComponent(match[2]));
  } catch {
    return null;
  }
}
