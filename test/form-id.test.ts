import type { TreeNode } from '@miditor/core';
import { describe, expect, it } from 'vitest';
import { formKeyOf, normalizeFormIds } from '../src/modules/cards/responses/form-id';

const node = (id: string, type: string, props: Record<string, unknown> = {}, children: TreeNode[] = []): TreeNode => ({ id, type, props, styles: {}, children }) as TreeNode;
const page = (...children: TreeNode[]) => node('root', 'Page', {}, children);

describe('formKeyOf', () => {
  it('uses the formId when it is valid', () => {
    expect(formKeyOf({ formId: 'f_abc123' }, 'n1')).toBe('f_abc123');
  });

  it('falls back on the node id for pages from before formId, and for a bad value', () => {
    expect(formKeyOf({}, 'n1')).toBe('n1');
    expect(formKeyOf({ formId: '' }, 'n1')).toBe('n1');
    expect(formKeyOf({ formId: 'a b' }, 'n1')).toBe('n1');
    expect(formKeyOf({ formId: 'x'.repeat(41) }, 'n1')).toBe('n1');
    expect(formKeyOf({ formId: 7 }, 'n1')).toBe('n1');
    expect(formKeyOf(undefined, 'n1')).toBe('n1');
  });
});

describe('normalizeFormIds', () => {
  it('returns the very same tree when every form already has its own key', () => {
    const root = page(node('n1', 'Form', { formId: 'a' }), node('n2', 'Form', { formId: 'b' }), node('n3', 'Form'), node('n4', 'Text'));
    expect(normalizeFormIds(root)).toBe(root);
  });

  it('gives a duplicated form (same formId) a key of its own and keeps the first', () => {
    const out = normalizeFormIds(page(node('n1', 'Form', { formId: 'abc' }), node('n2', 'Form', { formId: 'abc' })));
    expect(out.children[0]!.props.formId).toBe('abc');
    expect(out.children[1]!.props.formId).toBe('abc_n2');
  });

  it('keeps a form without formId on its node id, and moves a copy that carries that id as formId', () => {
    const out = normalizeFormIds(page(node('n1', 'Form'), node('n2', 'Form', { formId: 'n1' })));
    expect(out.children[0]!.props.formId).toBeUndefined();
    expect(out.children[1]!.props.formId).toBe('n1_n2');
  });

  it('finds forms inside other blocks and gives the same answer on every save', () => {
    const root = page(node('n1', 'Form', { formId: 'abc' }), node('n2', 'Box', {}, [node('n3', 'Form', { formId: 'abc' })]));
    const once = normalizeFormIds(root);
    expect(once.children[1]!.children[0]!.props.formId).toBe('abc_n3');
    expect(normalizeFormIds(root)).toEqual(once);
    expect(normalizeFormIds(once)).toBe(once);
  });

  it('keeps every key unique and within 40 characters', () => {
    const long = 'a'.repeat(40);
    const out = normalizeFormIds(page(node('n1', 'Form', { formId: long }), node('n2', 'Form', { formId: long }), node('n3', 'Form', { formId: `${'a'.repeat(36)}_n3` })));
    const keys = out.children.map((child) => formKeyOf(child.props, child.id));
    expect(new Set(keys).size).toBe(3);
    for (const key of keys) expect(key.length).toBeLessThanOrEqual(40);
  });
});
