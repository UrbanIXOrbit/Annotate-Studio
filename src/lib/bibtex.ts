/**
 * BibTeX reader — the input side of Zotero interop. `citation-formats.ts`
 * writes BibTeX; this parses it. Deliberately tolerant of real-world
 * exports: nested braces, quoted/numeric values, `#` concatenation,
 * @string macros, @comment/@preamble, CRLF, BOM.
 * Pure — no store imports.
 */

export interface BibtexEntry {
  /** Citation key, e.g. "kandel2012principles". */
  key: string;
  /** Entry type, lowercased, e.g. "article", "incollection", "book". */
  type: string;
  /** Field names lowercased; values unbraced and concatenation-resolved. */
  fields: Record<string, string>;
}

export interface ParseResult {
  entries: BibtexEntry[];
  /** Duplicate citation keys were collapsed (first spelling wins). */
  duplicates: number;
  /** Fragments that could not be parsed (a broken card never blocks the stack). */
  malformed: number;
}

/** Month macros standard in BibTeX (index = month number - 1). */
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const COMBINING_ACCENTS: Record<string, string> = {
  '"': '\u0308', "'": '\u0301', '`': '\u0300', '^': '\u0302',
  '~': '\u0303', 'v': '\u030C', 'c': '\u0327', '=': '\u0304', '.': '\u0307',
};

const SPECIAL_LETTERS: Record<string, string> = {
  ss: 'ß', ae: 'æ', AE: 'Æ', oe: 'œ', OE: 'Œ', O: 'Ø', o: 'ø',
  l: 'ł', L: 'Ł', d: 'đ', D: 'Đ',
};

/** Decode the LaTeX escapes that Zotero/Better-BibTeX put in author names. */
function decodeLatexAccents(value: string): string {
  return value
    .replace(/\{?\\(ss|ae|AE|oe|OE|O|o|l|L|d|D)\b\}?/g, (_match, letter: string) => SPECIAL_LETTERS[letter] ?? _match)
    .replace(/\{?\\(["'`^~=vc.])\{?([A-Za-z])\}?/g, (_match, accent: string, letter: string) => {
      const combining = COMBINING_ACCENTS[accent];
      return combining ? `${letter}${combining}`.normalize('NFC') : _match;
    });
}

/** Strip one level of braces and decode BibTeX's LaTeX accent escapes. */
function cleanValue(raw: string): string {
  let value = raw.trim();
  // Drop one uniform outer brace pair that wraps the whole value.
  while (value.startsWith('{') && value.endsWith('}') && wrapsWhole(value)) {
    value = value.slice(1, -1).trim();
  }
  return decodeLatexAccents(value.replace(/\s+/g, ' '));
}

/** True when the first and last braces of `value` form a matched pair. */
function wrapsWhole(value: string): boolean {
  let depth = 0;
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] === '{') depth += 1;
    else if (value[i] === '}') {
      depth -= 1;
      if (depth === 0) return i === value.length - 1;
    }
  }
  return false;
}

/**
 * Parse a whole .bib file. Splitting on top-level `@` starts, counting
 * braces so `@` inside values never splits an entry.
 */
export function parseBibtex(text: string): ParseResult {
  const source = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const entries: BibtexEntry[] = [];
  const macros = new Map<string, string>(MONTHS.map((month, index) => [month, String(index + 1)]));
  let duplicates = 0;
  let malformed = 0;
  const seenKeys = new Set<string>();

  let index = 0;
  while (index < source.length) {
    const at = source.indexOf('@', index);
    if (at === -1) break;
    const head = /^@([A-Za-z]+)\s*\{\s*/.exec(source.slice(at));
    if (!head) {
      index = at + 1;
      continue;
    }
    const kind = head[1].toLowerCase();
    // Find the matching closing brace.
    let depth = 1;
    let cursor = at + head[0].length;
    while (cursor < source.length && depth > 0) {
      const char = source[cursor];
      if (char === '{') depth += 1;
      else if (char === '}') depth -= 1;
      else if (char === '"' && depth === 1) {
        // Quoted values may contain braces; skip to the closing quote.
        cursor = source.indexOf('\n', cursor) === -1 ? source.length : skipQuoted(source, cursor);
        continue;
      }
      cursor += 1;
    }
    if (depth !== 0) {
      malformed += 1;
      break; // Unterminated entry — nothing after it can be trusted.
    }
    const body = source.slice(at + head[0].length, cursor - 1);
    index = cursor;

    if (kind === 'comment' || kind === 'preamble') continue;
    if (kind === 'string') {
      const macro = parseFields(body);
      for (const [name, value] of Object.entries(macro)) macros.set(name.toLowerCase(), value);
      continue;
    }

    // Body: "key," followed by fields.
    const comma = body.indexOf(',');
    const key = (comma === -1 ? body : body.slice(0, comma)).trim().replace(/^["{]|["}]$/g, '').trim();
    if (!key) {
      malformed += 1;
      continue;
    }
    const fields = parseFields(comma === -1 ? '' : body.slice(comma + 1));
    for (const [name, value] of Object.entries(fields)) {
      fields[name] = resolveValue(value, macros);
    }
    const dedupeKey = key.toLowerCase();
    if (seenKeys.has(dedupeKey)) {
      duplicates += 1;
      continue;
    }
    seenKeys.add(dedupeKey);
    entries.push({ key, type: kind, fields });
  }

  return { entries, duplicates, malformed };
}

/** Skip a double-quoted string starting at `start` (the opening quote). */
function skipQuoted(source: string, start: number): number {
  for (let i = start + 1; i < source.length; i += 1) {
    if (source[i] === '\\') {
      i += 1;
      continue;
    }
    if (source[i] === '"') return i + 1;
  }
  return source.length;
}

/** Parse "name = value," pairs; values may be {braced}, "quoted", bare, or joined with #. */
function parseFields(body: string): Record<string, string> {
  const fields: Record<string, string> = {};
  let cursor = 0;
  while (cursor < body.length) {
    const nameMatch = /^[ \t\n]*([A-Za-z][A-Za-z0-9_-]*)[ \t\n]*=[ \t\n]*/.exec(body.slice(cursor));
    if (!nameMatch) break;
    const name = nameMatch[1].toLowerCase();
    cursor += nameMatch[0].length;

    // One or more # -joined chunks.
    const chunks: string[] = [];
    for (;;) {
      const char = body[cursor];
      if (char === '{' || char === '"') {
        const quoted = char === '"';
        const close = findClose(body, cursor, quoted);
        chunks.push(body.slice(cursor + 1, close));
        cursor = close + 1;
      } else {
        const bare = /^[^,#}]*/.exec(body.slice(cursor));
        chunks.push(bare ? bare[0] : '');
        cursor += bare ? bare[0].length : 0;
      }
      const join = /^[ \t\n]*#[ \t\n]*/.exec(body.slice(cursor));
      if (!join) break;
      cursor += join[0].length;
    }
    // Braces protect every chunk; resolveValue unbraces and resolves macros.
    fields[name] = chunks.map((chunk) => `{${chunk}}`).join('');
    // Advance past the value separator.
    const next = body.indexOf(',', cursor);
    cursor = next === -1 ? body.length : next + 1;
  }
  return fields;
}

/** Find the closing brace or quote, counting nested braces. */
function findClose(body: string, start: number, isQuote: boolean): number {
  // The opening brace/quote sits at `start`; scanning begins inside it.
  let depth = isQuote ? 0 : 1;
  for (let i = start + 1; i < body.length; i += 1) {
    const char = body[i];
    if (isQuote) {
      // Inside a quoted value a brace pair protects a quote; a bare quote closes.
      if (char === '{') depth += 1;
      else if (char === '}') depth = Math.max(0, depth - 1);
      else if (char === '"' && depth === 0) return i;
    } else {
      if (char === '{') depth += 1;
      else if (char === '}') {
        depth -= 1;
        if (depth === 0) return i;
      }
    }
  }
  return body.length - 1;
}

/** Resolve macros and # concatenation on a raw field value. */
function resolveValue(raw: string, macros: Map<string, string>): string {
  // A brace pair may wrap the entire concatenation — unwrap it first.
  const value = unbrace(raw.trim());
  const parts = value.split('#').map((part) => part.trim()).filter((part) => part !== '');
  const resolved = parts
    .map((part) => {
      if (part.startsWith('"') && part.endsWith('"') && part.length >= 2) return part.slice(1, -1);
      const unbraced = unbrace(part);
      const bare = unbraced.trim();
      if (bare && /^[A-Za-z]+$/.test(bare) && macros.has(bare.toLowerCase())) return macros.get(bare.toLowerCase())!;
      return unbraced;
    })
    .join('');
  return cleanValue(resolved);
}

/** Strip one wrapping brace level, keeping inner braces. */
function unbrace(value: string): string {
  let out = value.trim();
  if (out.startsWith('{') && out.endsWith('}') && wrapsWhole(out)) out = out.slice(1, -1);
  return out;
}
