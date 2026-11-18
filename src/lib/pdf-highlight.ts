/**
 * Highlight rendering rules for the PDF reader.
 *
 * EmbedPDF draws committed highlight annotations with the annotation's own
 * opacity and blend mode. An opaque (or dark) colour multiplied over the page
 * hides the text underneath, so highlights are kept translucent and light —
 * the live preview already uses a translucent yellow, and this keeps the saved
 * result looking the same.
 */

/** Low enough that black text stays readable through any tint. */
export const HIGHLIGHT_OPACITY = 0.35;

const DEFAULT_HIGHLIGHT = '#FFCD45';

/** Lighten dark picks (and remap near-white) so a highlight never obscures text. */
export function highlightTint(color: string): string {
  const match = /^#([0-9a-fA-F]{6})$/.exec(color.trim());
  if (!match) return DEFAULT_HIGHLIGHT;
  const hex = match[1];
  const channels = [0, 2, 4].map((index) => parseInt(hex.slice(index, index + 2), 16));
  const luminance = (0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]) / 255;
  if (luminance > 0.92) return DEFAULT_HIGHLIGHT;
  if (luminance >= 0.62) return color.trim().toUpperCase();
  const lighten = (channel: number) => Math.round(channel + (255 - channel) * 0.55);
  return `#${channels.map(lighten).map((value) => value.toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}
