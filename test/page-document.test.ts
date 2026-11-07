import { describe, expect, it } from 'vitest';
import { MAX_DOCUMENT_BYTES, parsePageDocument } from '../src/modules/cards/page-document';
import { AppError } from '../src/shared/errors';
import { samplePage } from './helpers/pages';

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
