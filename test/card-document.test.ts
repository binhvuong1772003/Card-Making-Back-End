import { describe, expect, it } from 'vitest';
import { parseCardDocument, parseCardDocumentForStorage } from '../src/modules/cards/card-document';
import { samplePage } from './helpers/pages';

const page = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id, data: samplePage(id), interactions: {}, ...extra });
const document = (pages = [page('page-1'), page('page-2')], startPageId = 'page-1') => ({ kind: 'card', version: 1, startPageId, pages });
const rejects = (value: unknown) => expect(() => parseCardDocument(value)).toThrow();

describe('parseCardDocument', () => {
  it('never flattens an envelope when an extra legacy root field is present', () => {
    expect(parseCardDocumentForStorage({ ...document(), root: samplePage().root })).toMatchObject({ kind: 'card', pages: [{ id: 'page-1' }, { id: 'page-2' }] });
  });
  it('wraps legacy pages without changing their nodes or form keys', () => {
    const legacy = samplePage('old');
    const parsed = parseCardDocument(legacy);
    expect(parsed).toMatchObject({ kind: 'card', version: 1, startPageId: 'page-1', pages: [{ id: 'page-1', data: legacy, interactions: {} }] });
  });

  it('turns an empty stored document into one valid page', () => {
    const emptyPage = { schemaVersion: 1, root: { id: 'root', type: 'Page', props: {}, styles: {}, position: { mode: 'flow' }, children: [] } };
    expect(parseCardDocument(emptyPage)).toMatchObject({ kind: 'card', pages: [{ id: 'page-1', name: 'Trang 1', data: emptyPage }] });
  });

  it('accepts cycles and self-targeting links', () => {
    const a = page('a', { interactions: { n1: { type: 'go-to-page', targetPageId: 'b', transition: 'fade', durationMs: 450 } } });
    const b = page('b', { interactions: { n1: { type: 'go-to-page', targetPageId: 'a', transition: 'none', durationMs: 0 } } });
    expect(parseCardDocument(document([a, b], 'b')).pages).toHaveLength(2);
    expect(parseCardDocument(document([page('a', { interactions: { n1: { type: 'go-to-page', targetPageId: 'a', transition: 'zoom', durationMs: 1200 } } })], 'a')).pages).toHaveLength(1);
  });

  it('rejects page-count, ID, start, target, source, and version errors', () => {
    rejects(document([], 'page-1'));
    rejects(document(Array.from({ length: 51 }, (_, i) => page(`p${i}`)), 'p0'));
    rejects(document([page('same'), page('same')]));
    rejects(document([page('p')], 'missing'));
    rejects(document([page('p', { interactions: { n1: { type: 'go-to-page', targetPageId: 'missing', transition: 'fade', durationMs: 450 } } })]));
    rejects(document([page('p', { interactions: { absent: { type: 'go-to-page', targetPageId: 'p', transition: 'fade', durationMs: 450 } } })]));
    rejects(document([page('p', { interactions: { root: { type: 'go-to-page', targetPageId: 'p', transition: 'fade', durationMs: 450 } } })]));
    rejects({ ...document(), version: 2 });
  });

  it('rejects names, duplicate global form IDs, malformed navigation, and oversized envelopes', () => {
    rejects(document([page('p', { name: '   ' })]));
    rejects(document([page('p', { name: 'x'.repeat(81) })]));
    const form = { id: 'form1', type: 'Form', props: { formId: 'same-form' }, styles: {}, position: { mode: 'free', x: { anchor: 'scale', start: 1, size: 10 }, y: { anchor: 'start', offset: 1 } }, size: { w: { kind: 'px', v: 20 }, h: { kind: 'px', v: 20 } }, rotation: 0, children: [] };
    const withForm = () => ({ ...samplePage(), root: { ...samplePage().root, children: [...samplePage().root.children, form] } });
    rejects(document([page('a', { data: withForm() }), page('b', { data: withForm() })]));
    rejects(document([page('p', { interactions: { n1: { type: 'go-to-page', targetPageId: 'p', transition: 'spin', durationMs: 300 } } })]));
    rejects(document([page('p', { data: samplePage('x'.repeat(810 * 1024)) })]));
  });
});
