import { describe, expect, it } from 'vitest';
import { filterPublishedSeedTargets, findMissingCatalogAssets, parseReferenceSeedArgs, selectContentHandoff } from '../scripts/seed-reference-templates-mode';

describe('reference template handoff seed mode', () => {
  it('requires an explicit queued slug and UNLISTED status for a dry run', () => {
    expect(parseReferenceSeedArgs(['--slug=song-hy-v2-do', '--status=UNLISTED', '--dry-run'])).toEqual({
      mode: 'content-handoff',
      slug: 'song-hy-v2-do',
      dryRun: true,
    });
  });

  it('rejects UNLISTED without one slug', () => {
    expect(() => parseReferenceSeedArgs(['--status=UNLISTED'])).toThrow(/requires exactly one --slug/);
  });

  it('rejects a slug outside the remaining five templates', () => {
    expect(() => parseReferenceSeedArgs(['--slug=minimalism-do-dam', '--status=UNLISTED'])).toThrow(/not in the content handoff queue/);
  });

  it('does not select a published template as the update target', () => {
    expect(selectContentHandoff([
      { id: 'published', status: 'PUBLISHED', tags: ['songhy-v2', 'song-hy-v2-do'] },
    ], 'song-hy-v2-do')).toBeNull();
  });

  it('keeps content handoffs out of the legacy published seed target list', () => {
    expect(filterPublishedSeedTargets([
      { id: 'published', tags: ['song-hy-v2-do'] },
      { id: 'handoff', tags: ['song-hy-v2-do', 'clone-content-draft'] },
    ]).map(({ id }) => id)).toEqual(['published']);
  });

  it('reports unique decorative sources missing from the published catalog', () => {
    expect(findMissingCatalogAssets(['/flower.webp', '/flower.webp', '/paper.webp'], ['/flower.webp'])).toEqual(['/paper.webp']);
  });

  it('selects only the explicitly tagged unlisted handoff', () => {
    expect(selectContentHandoff([
      { id: 'published', status: 'PUBLISHED', tags: ['song-hy-v2-do'] },
      { id: 'handoff', status: 'UNLISTED', tags: ['song-hy-v2-do', 'clone-content-draft'] },
    ], 'song-hy-v2-do')).toBe('handoff');
  });

  it('refuses ambiguous duplicate handoffs instead of deleting data', () => {
    expect(() => selectContentHandoff([
      { id: 'one', status: 'UNLISTED', tags: ['song-hy-v2-do', 'clone-content-draft'] },
      { id: 'two', status: 'UNLISTED', tags: ['song-hy-v2-do', 'clone-content-draft'] },
    ], 'song-hy-v2-do')).toThrow(/Multiple content handoffs/);
  });
});
