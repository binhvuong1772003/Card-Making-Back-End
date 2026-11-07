import { describe, expect, it, vi } from 'vitest';
import { deleteImages, listImages, type ImageResource } from '../src/infra/cloudinary';
import { collectReferencedPublicIds, findOrphans, publicIdCandidates, publicIdFromUrl, sweepImages } from '../src/modules/assets/assets.sweep';

const CLOUD = 'demo';
const CONFIG = { apiKey: 'key123', apiSecret: 'secret456', cloudName: CLOUD };
const url = (publicId: string, ext = 'png', version = 'v1700000000') => `https://res.cloudinary.com/${CLOUD}/image/upload/${version}/${publicId}.${ext}`;
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-11-07T12:00:00Z');
const resource = (publicId: string, daysOld: number): ImageResource => ({ publicId, createdAt: new Date(NOW - daysOld * DAY).toISOString() });

describe('publicIdFromUrl', () => {
  it('takes the folder and name without the version or the extension', () => {
    expect(publicIdFromUrl(url('cardmaking/u1/pic'), CLOUD)).toBe('cardmaking/u1/pic');
    expect(publicIdFromUrl(url('cardmaking/u1/pic', 'webp', 'v9'), CLOUD)).toBe('cardmaking/u1/pic');
  });
  it('skips transformation segments and works without a version', () => {
    expect(publicIdFromUrl(`https://res.cloudinary.com/${CLOUD}/image/upload/c_limit,w_800/v1/cardmaking/u1/pic.png`, CLOUD)).toBe('cardmaking/u1/pic');
    expect(publicIdFromUrl(`https://res.cloudinary.com/${CLOUD}/image/upload/cardmaking/u1/pic.png`, CLOUD)).toBe('cardmaking/u1/pic');
  });
  it('without a version it keeps every way the path could be cut, so an image in use is never taken for an orphan', () => {
    const ids = publicIdCandidates(`https://res.cloudinary.com/${CLOUD}/image/upload/w_800/cardmaking/my_folder/pic.png`, CLOUD);
    expect(ids).toContain('cardmaking/my_folder/pic'); // transformation in front
    expect(ids).toContain('w_800/cardmaking/my_folder/pic');
  });
  it('ignores addresses outside our cloud', () => {
    expect(publicIdFromUrl('https://res.cloudinary.com/other/image/upload/v1/a.png', CLOUD)).toBeUndefined();
    expect(publicIdFromUrl('https://example.com/a.png', CLOUD)).toBeUndefined();
  });
});

describe('collectReferencedPublicIds', () => {
  it('finds every picture of ours anywhere in the documents', () => {
    const docs = [
      { root: { children: [{ props: { src: url('cardmaking/u1/a') } }] }, meta: { image: url('cardmaking/u1/b') } },
      { root: { children: [{ props: { src: url('cardmaking/templates/t1/c') } }, { props: { src: 'https://example.com/x.png' } }] } },
      { note: `see ${url('cardmaking/u1/embedded-in-text')}` }, // not a whole address: not a reference
    ];
    expect([...collectReferencedPublicIds(docs, CLOUD)].sort()).toEqual(['cardmaking/templates/t1/c', 'cardmaking/u1/a', 'cardmaking/u1/b']);
  });
});

describe('findOrphans', () => {
  const referenced = new Set(['cardmaking/u1/used']);
  const resources = [resource('cardmaking/u1/used', 40), resource('cardmaking/u1/old-unused', 40), resource('cardmaking/u1/fresh-unused', 2), resource('cardmaking/templates/t1/shared', 40)];
  it('picks pictures nobody uses and that are older than the minimum age', () => {
    expect(findOrphans({ resources, referenced, now: NOW, minAgeMs: 7 * DAY }).map((r) => r.publicId)).toEqual(['cardmaking/u1/old-unused']);
  });
  it('never touches the shared template folder, even if nothing references it', () => {
    expect(findOrphans({ resources: [resource('cardmaking/templates/t9/x', 400)], referenced: new Set(), now: NOW, minAgeMs: 7 * DAY })).toEqual([]);
  });
  it('keeps a picture whose age is unknown', () => {
    expect(findOrphans({ resources: [{ publicId: 'cardmaking/u1/a', createdAt: 'not a date' }], referenced: new Set(), now: NOW, minAgeMs: DAY })).toEqual([]);
  });
});

describe('sweepImages', () => {
  const base = () => ({
    resources: [resource('cardmaking/u1/used', 40), resource('cardmaking/u1/a', 40), resource('cardmaking/u1/b', 40), resource('cardmaking/templates/t1/s', 40)],
    referenced: new Set(['cardmaking/u1/used']),
  });
  const run = (apply: boolean, extra: { force?: boolean; resources?: ImageResource[]; referenced?: Set<string> } = {}) => {
    const remove = vi.fn(async (ids: string[]) => ids.length);
    const { resources, referenced } = base();
    const deps = { list: async () => extra.resources ?? resources, referenced: async () => extra.referenced ?? referenced, remove };
    return { remove, result: sweepImages({ ...deps, apply, force: extra.force ?? false, now: NOW, minAgeDays: 7, prefix: 'cardmaking/' }) };
  };

  it('only reports in a dry run', async () => {
    const { remove, result } = run(false);
    const report = await result;
    expect(report.orphans.map((r) => r.publicId).sort()).toEqual(['cardmaking/u1/a', 'cardmaking/u1/b']);
    expect(report.deleted).toBe(0);
    expect(remove).not.toHaveBeenCalled();
  });

  it('deletes exactly the orphans when applying', async () => {
    const { remove, result } = run(true);
    const report = await result;
    expect(report.deleted).toBe(2);
    expect(remove.mock.calls.flat(1).flat().sort()).toEqual(['cardmaking/u1/a', 'cardmaking/u1/b']);
  });

  it('refuses a mass delete (a bug reading the documents would look just like this) unless forced', async () => {
    const many = Array.from({ length: 30 }, (_, i) => resource(`cardmaking/u1/p${i}`, 40));
    const none = run(true, { resources: many, referenced: new Set() });
    await expect(none.result).rejects.toThrow(/refus/i);
    expect(none.remove).not.toHaveBeenCalled();
    const forced = run(true, { resources: many, referenced: new Set(), force: true });
    expect((await forced.result).deleted).toBe(30);
  });
});

describe('Cloudinary admin calls', () => {
  it('lists pictures under a prefix across pages with basic auth and no secret in the address', async () => {
    const calls: { url: string; auth: string | null }[] = [];
    const pages = [
      { resources: [{ public_id: 'cardmaking/u1/a', created_at: '2026-01-01T00:00:00Z' }], next_cursor: 'cur2' },
      { resources: [{ public_id: 'cardmaking/u1/b', created_at: '2026-01-02T00:00:00Z' }] },
    ];
    const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), auth: new Headers(init?.headers).get('authorization') });
      return new Response(JSON.stringify(pages[calls.length - 1]), { status: 200 });
    }) as typeof fetch;
    const out = await listImages('cardmaking/', CONFIG, fake);
    expect(out).toEqual([{ publicId: 'cardmaking/u1/a', createdAt: '2026-01-01T00:00:00Z' }, { publicId: 'cardmaking/u1/b', createdAt: '2026-01-02T00:00:00Z' }]);
    expect(calls[0]!.url).toContain('/v1_1/demo/resources/image/upload');
    expect(calls[0]!.url).toContain('prefix=cardmaking%2F');
    expect(calls[1]!.url).toContain('next_cursor=cur2');
    expect(calls[0]!.auth).toBe(`Basic ${Buffer.from('key123:secret456').toString('base64')}`);
    expect(calls[0]!.url).not.toContain('secret456');
  });

  it('deletes in chunks of 100 and counts what Cloudinary says it deleted', async () => {
    const sizes: number[] = [];
    const fake = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const ids = new URLSearchParams(String(init?.body)).getAll('public_ids[]');
      sizes.push(ids.length);
      return new Response(JSON.stringify({ deleted: Object.fromEntries(ids.map((id) => [id, 'deleted'])) }), { status: 200 });
    }) as typeof fetch;
    const ids = Array.from({ length: 230 }, (_, i) => `cardmaking/u1/p${i}`);
    expect(await deleteImages(ids, CONFIG, fake)).toBe(230);
    expect(sizes).toEqual([100, 100, 30]);
  });

  it('turns a failure into PROVIDER_FAILED', async () => {
    const bad = (async () => new Response('{}', { status: 500 })) as typeof fetch;
    await expect(listImages('cardmaking/', CONFIG, bad)).rejects.toMatchObject({ code: 'PROVIDER_FAILED' });
    await expect(deleteImages(['a'], CONFIG, bad)).rejects.toMatchObject({ code: 'PROVIDER_FAILED' });
  });
});
