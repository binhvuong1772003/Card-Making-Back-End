import type { PageData, TreeNode } from '@miditor/core';
import { AppError } from '../../shared/errors';
import { MAX_DOCUMENT_BYTES, parsePageDocument } from './page-document';
import { formKeyOf, FORM_TYPE } from './responses/form-id';

export type PageTransition = 'none' | 'fade' | 'slide-left' | 'slide-right' | 'slide-up' | 'zoom';
export interface PageNavigation {
  type: 'go-to-page';
  targetPageId: string;
  transition: PageTransition;
  durationMs: number;
}
export interface CardPage {
  id: string;
  name: string;
  data: PageData;
  interactions: Record<string, PageNavigation>;
}
export interface CardDocument {
  kind: 'card';
  version: 1;
  startPageId: string;
  pages: CardPage[];
}
export type ParsedCardDocument = CardDocument | PageData;

const PAGE_ID = /^[A-Za-z0-9_-]{1,40}$/;
const TRANSITIONS = new Set<PageTransition>(['none', 'fade', 'slide-left', 'slide-right', 'slide-up', 'zoom']);
const NAVIGABLE_TYPES = new Set([
  'Text', 'Image', 'Shape', 'Button', 'PhotoFrame', 'PhotoFrameRectangle', 'PhotoFrameRounded', 'PhotoFrameCircle', 'PhotoFramePill',
  'PhotoFrameArch', 'PhotoFrameSemicircle', 'PhotoFrameTriangle', 'PhotoFrameDiamond', 'PhotoFramePentagon', 'PhotoFrameHexagon',
  'PhotoFrameScallop', 'PhotoFrameSeal', 'PhotoFrameHeart',
]);
const invalid = (reason: string): never => { throw new AppError('VALIDATION', `The card document is not valid (${reason})`, { reason: 'DOCUMENT' }); };
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function parsePageForCard(input: unknown, normalizeDuplicateForms: boolean): PageData {
  try {
    return parsePageDocument(input, { normalizeDuplicateForms });
  } catch (error) {
    if (error instanceof AppError && error.code === 'VALIDATION') {
      const details = isRecord(error.details) ? error.details : {};
      throw new AppError('VALIDATION', error.message, { ...details, reason: 'DOCUMENT' });
    }
    throw error;
  }
}

function formKeys(root: TreeNode): string[] {
  const keys: string[] = [];
  const walk = (node: TreeNode) => {
    if (node.type === FORM_TYPE) {
      const value = node.props.formId;
      if (value !== undefined && (typeof value !== 'string' || !PAGE_ID.test(value))) invalid('invalid form ID');
      keys.push(formKeyOf(node.props, node.id));
    }
    node.children.forEach(walk);
  };
  walk(root);
  return keys;
}

function parseEnvelope(input: Record<string, unknown>): CardDocument {
  if (input.kind !== 'card' || input.version !== 1 || !Array.isArray(input.pages) || input.pages.length < 1 || input.pages.length > 50) invalid('unsupported card envelope or page count');
  const rawPages = input.pages as unknown[];
  const pageIds = new Set<string>();
  const formIds = new Set<string>();
  const pages: CardPage[] = rawPages.map((raw): CardPage => {
    if (!isRecord(raw)) invalid('invalid page');
    const pageInput = raw as Record<string, unknown>;
    if (typeof pageInput.id !== 'string' || !PAGE_ID.test(pageInput.id) || pageIds.has(pageInput.id)) invalid('invalid or duplicate page ID');
    const id = pageInput.id as string;
    pageIds.add(id);
    if (typeof pageInput.name !== 'string' || pageInput.name.trim().length < 1 || pageInput.name.trim().length > 80) invalid('invalid page name');
    const name = pageInput.name as string;
    const data = parsePageForCard(pageInput.data, false);
    for (const key of formKeys(data.root)) {
      if (formIds.has(key)) invalid('duplicate form ID');
      formIds.add(key);
    }
    if (!isRecord(pageInput.interactions)) invalid('invalid page interactions');
    const rawInteractions = pageInput.interactions as Record<string, unknown>;
    const interactions: Record<string, PageNavigation> = {};
    for (const [source, value] of Object.entries(rawInteractions)) {
      if (!source || !isRecord(value)) invalid('invalid page navigation');
      const rawNavigation = value as Record<string, unknown>;
      if (rawNavigation.type !== 'go-to-page' || typeof rawNavigation.targetPageId !== 'string' || !PAGE_ID.test(rawNavigation.targetPageId) || !TRANSITIONS.has(rawNavigation.transition as PageTransition) || !Number.isInteger(rawNavigation.durationMs)) invalid('invalid page navigation');
      const transition = rawNavigation.transition as PageTransition;
      const durationMs = rawNavigation.durationMs as number;
      const targetPageId = rawNavigation.targetPageId as string;
      if ((transition === 'none' && durationMs !== 0) || (transition !== 'none' && (durationMs < 100 || durationMs > 1200))) invalid('invalid transition duration');
      interactions[source] = { type: 'go-to-page', targetPageId, transition, durationMs };
    }
    return { id, name: name.trim(), data, interactions };
  });
  if (typeof input.startPageId !== 'string' || !pageIds.has(input.startPageId)) invalid('missing start page');
  const startPageId = input.startPageId as string;
  for (const page of pages) {
    const nodes = new Map<string, TreeNode>();
    const walk = (node: TreeNode) => { nodes.set(node.id, node); node.children.forEach(walk); };
    walk(page.data.root);
    for (const [source, nav] of Object.entries(page.interactions)) {
      const node = nodes.get(source);
      if (!node) invalid('navigation source is missing');
      const sourceNode = node as TreeNode;
      const eligible = NAVIGABLE_TYPES.has(sourceNode.type) || (['Group', 'Container'].includes(sourceNode.type) && !hasForm(sourceNode));
      if (!eligible) invalid('navigation source cannot be interactive');
      if (!pageIds.has(nav.targetPageId) && !rawPages.some((candidate) => isRecord(candidate) && candidate.id === nav.targetPageId)) invalid('navigation target is missing');
    }
  }
  // Count the canonical representation so envelope metadata and all pages share the existing document cap.
  if (Buffer.byteLength(JSON.stringify({ kind: 'card', version: 1, startPageId, pages }) ?? '', 'utf8') > MAX_DOCUMENT_BYTES) invalid('document is too large');
  return { kind: 'card', version: 1, startPageId, pages };
}

function hasForm(node: TreeNode): boolean {
  return node.type === FORM_TYPE || node.children.some(hasForm);
}

// Legacy PageData is still accepted and returned in its original API shape. New envelopes are strictly validated as a whole.
export function parseCardDocument(input: unknown): CardDocument {
  const size = Buffer.byteLength(JSON.stringify(input) ?? '', 'utf8');
  if (size > MAX_DOCUMENT_BYTES) invalid('document is too large');
  if (isRecord(input) && input.kind === 'card') return parseEnvelope(input);
  const data = parsePageForCard(input, true);
  return { kind: 'card', version: 1, startPageId: 'page-1', pages: [{ id: 'page-1', name: 'Trang 1', data, interactions: {} }] };
}

// Keep existing one-page records in their old stored shape until the editor writes an envelope.
export function parseCardDocumentForStorage(input: unknown): ParsedCardDocument {
  const parsed = parseCardDocument(input);
  return isRecord(input) && input.kind !== 'card' && Object.hasOwn(input, 'root') ? parsed.pages[0]!.data : parsed;
}

export const isCardDocument = (input: unknown): input is CardDocument => isRecord(input) && input.kind === 'card' && input.version === 1 && Array.isArray(input.pages);
