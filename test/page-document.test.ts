import { describe, expect, it } from 'vitest';
import { MAX_DOCUMENT_BYTES, parsePageDocument } from '../src/modules/cards/page-document';
import { AppError } from '../src/shared/errors';
import { cardComponents } from '../src/modules/cards/components';
import { albumPage, blockPage, calendarPage, mapPage, samplePage } from './helpers/pages';

const refusal = (input: unknown) => {
  try {
    parsePageDocument(input);
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    return err as AppError;
  }
  throw new Error('expected the page to be refused');
};

describe('parsePageDocument', () => {
  it('accepts a page as the editor saves it and gives it back', () => {
    const page = samplePage('Xin chào');
    expect(parsePageDocument(page)).toEqual(page);
  });

  it('accepts a page with a picture and a share picture', () => {
    const url = 'https://res.cloudinary.com/demo/image/upload/v1/a.png';
    expect(() => parsePageDocument(samplePage('x', { image: url, metaImage: url }))).not.toThrow();
  });

  it('drops the props a block no longer has instead of refusing a page saved before', () => {
    const old = mapPage({ borderStyle: 'Đôi', borderWidth: 3, borderColor: '#511419', radius: 4, filled: true, fill: '#ffffff', shadow: 'Nhẹ', tilt: 2, tape: true });
    const parsed = parsePageDocument(old);
    const map = parsed.root.children.find((child) => child.type === 'Map')!;
    for (const key of ['borderStyle', 'borderWidth', 'borderColor', 'radius', 'filled', 'fill', 'shadow', 'tilt', 'tape']) expect(map.props).not.toHaveProperty(key);
    expect(map.props).toMatchObject({ name: 'White Palace', innerFrame: true, padding: 14 });
    expect(parsePageDocument(calendarPage({ filled: true, fill: '#511419', borderWidth: 2, borderColor: '#511419', radius: 8 }))).toBeTruthy();
    expect(JSON.stringify(old)).toContain('borderStyle'); // trang gốc không bị đổi
  });

  it('accepts a page with an Album block, a kind of CardMaking', () => {
    const url = 'https://res.cloudinary.com/demo/image/upload/v1/a.png';
    const page = albumPage([url, url]);
    expect(parsePageDocument(page)).toEqual(page);
  });

  it('refuses an Album whose interval is out of range', () => {
    const bad = albumPage([]);
    (bad.root.children[1] as { props: Record<string, unknown> }).props.interval = 99;
    expect(refusal(bad).code).toBe('VALIDATION');
  });

  it('accepts a page with a Map block and refuses an option it does not offer or a number out of range', () => {
    const page = mapPage();
    expect(parsePageDocument(page)).toEqual(page);
    expect(refusal(mapPage({ zoom: 99 })).code).toBe('VALIDATION');
    expect(refusal(mapPage({ padding: 99 })).code).toBe('VALIDATION');
  });

  it('accepts a page with a Calendar block and refuses a shape it does not offer or a size out of range', () => {
    const page = calendarPage({ font: "'Great Vibes', cursive" });
    expect(parsePageDocument(page)).toEqual(page);
    expect(refusal(calendarPage({ markShape: 'Rồng' })).code).toBe('VALIDATION');
    expect(refusal(calendarPage({ size: 99 })).code).toBe('VALIDATION');
  });

  it('accepts every block of CardMaking added with its default properties', () => {
    const types = Object.keys(cardComponents);
    expect(types.length).toBeGreaterThanOrEqual(10);
    for (const type of types) {
      const page = blockPage(type, cardComponents[type]!.defaultProps);
      expect(parsePageDocument(page)).toEqual(page);
    }
  });

  it('refuses what is not a page, with VALIDATION and no echo of the data', () => {
    for (const input of [null, 'text', 42, [], {}, { a: 1 }, { schemaVersion: 1 }, { schemaVersion: 1, root: { id: 'root', type: 'Page', children: [] } }]) {
      expect(refusal(input).code).toBe('VALIDATION');
    }
  });

  it('refuses a page made by a newer version', () => {
    expect(refusal({ ...samplePage(), schemaVersion: 99 }).code).toBe('VALIDATION');
  });

  it('refuses a block kind the registry does not know', () => {
    const page = samplePage();
    (page.root.children[0] as { type: string }).type = 'NotABlock';
    expect(refusal(page).code).toBe('VALIDATION');
  });

  it('refuses a picture address that is not safe to draw', () => {
    expect(refusal(samplePage('x', { metaImage: 'javascript:alert(1)' })).code).toBe('VALIDATION');
  });

  it('refuses a page bigger than the limit', () => {
    const big = samplePage('x'.repeat(MAX_DOCUMENT_BYTES));
    expect(refusal(big).message).toMatch(/large/i);
  });
});
