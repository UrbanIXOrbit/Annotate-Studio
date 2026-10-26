import { readBookAnnotationSet as readBookAnnotationSetCommand, writeBookAnnotationSet as writeBookAnnotationSetCommand } from './tauri-commands';

export interface EpubAnnotation {
  id: string;
  type: 'Annotation';
  motivation: 'highlighting';
  created: string;
  modified: string;
  target: {
    source: string;
    selector: Array<{ type: 'annotateStudio:CFISelector'; value: string }>;
  };
  body: {
    type: 'TextualBody';
    value: string;
    color: 'yellow';
    highlight: 'solid' | 'underline';
  };
}

export interface EpubAnnotationSet {
  '@context': [string, { annotateStudio: string }];
  id: string;
  type: 'AnnotationSet';
  generated: string;
  about: { 'dc:title': string };
  items: EpubAnnotation[];
}

const CONTEXT = 'https://www.w3.org/ns/epub-anno.jsonld';
const EXTENSION_CONTEXT = 'https://annotate.studio/ns#';

export function createEpubAnnotationSet(title: string): EpubAnnotationSet {
  return {
    '@context': [CONTEXT, { annotateStudio: EXTENSION_CONTEXT }],
    id: `urn:uuid:${crypto.randomUUID()}`,
    type: 'AnnotationSet',
    generated: new Date().toISOString(),
    about: { 'dc:title': title },
    items: [],
  };
}

export function parseEpubAnnotationSet(raw: unknown, title: string): EpubAnnotationSet {
  if (!raw || typeof raw !== 'object') return createEpubAnnotationSet(title);
  const value = raw as Partial<EpubAnnotationSet>;
  if (value.type !== 'AnnotationSet' || !Array.isArray(value.items)) return createEpubAnnotationSet(title);
  return {
    '@context': [CONTEXT, { annotateStudio: EXTENSION_CONTEXT }],
    id: typeof value.id === 'string' ? value.id : `urn:uuid:${crypto.randomUUID()}`,
    type: 'AnnotationSet',
    generated: typeof value.generated === 'string' ? value.generated : new Date().toISOString(),
    about: value.about && typeof value.about['dc:title'] === 'string' ? value.about : { 'dc:title': title },
    items: value.items.filter(isEpubAnnotation),
  };
}

export function isEpubAnnotation(value: unknown): value is EpubAnnotation {
  if (!value || typeof value !== 'object') return false;
  const annotation = value as Partial<EpubAnnotation>;
  const selectors = annotation.target?.selector;
  if (!Array.isArray(selectors)) return false;
  const cfiSelector = selectors.find((selector) => selector?.type === 'annotateStudio:CFISelector');
  return annotation.type === 'Annotation'
    && typeof annotation.id === 'string'
    && typeof annotation.target?.source === 'string'
    && typeof cfiSelector?.value === 'string'
    && typeof annotation.body?.value === 'string'
    && (annotation.body?.highlight === 'solid' || annotation.body?.highlight === 'underline');
}

export function createEpubAnnotation(args: {
  source: string;
  cfi: string;
  text: string;
  style: 'highlight' | 'underline';
}): EpubAnnotation {
  const now = new Date().toISOString();
  return {
    id: `urn:uuid:${crypto.randomUUID()}`,
    type: 'Annotation',
    motivation: 'highlighting',
    created: now,
    modified: now,
    target: {
      source: args.source,
      selector: [{ type: 'annotateStudio:CFISelector', value: args.cfi }],
    },
    body: {
      type: 'TextualBody',
      value: args.text,
      color: 'yellow',
      highlight: args.style === 'underline' ? 'underline' : 'solid',
    },
  };
}

export function annotationCfi(annotation: EpubAnnotation): string {
  return annotation.target.selector.find((selector) => selector.type === 'annotateStudio:CFISelector')?.value ?? '';
}

export async function readBookAnnotationSet(path: string, isExternal: boolean, title: string): Promise<EpubAnnotationSet> {
  const raw = await readBookAnnotationSetCommand(path, isExternal);
  return parseEpubAnnotationSet(raw, title);
}

export function writeBookAnnotationSet(path: string, isExternal: boolean, annotationSet: EpubAnnotationSet): Promise<void> {
  return writeBookAnnotationSetCommand(path, isExternal, annotationSet);
}
