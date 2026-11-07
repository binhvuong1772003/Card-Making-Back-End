import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { copyImage, signParams } from '../src/infra/cloudinary';
import { AppError } from '../src/shared/errors';
import { collectImageUrls, replaceImageUrls } from '../src/modules/cards/gallery/template-images';

const CONFIG = { apiKey: 'key123', apiSecret: 'secret456', cloudName: 'democloud' };
const sha1 = (text: string) => createHash('sha1').update(text).digest('hex');

describe('signParams', () => {
  it('signs the sorted parameters joined by & plus the secret', () => {
    expect(signParams({ timestamp: 10, folder: 'a/b', public_id: 'x' }, 'S')).toBe(sha1('folder=a/b&public_id=x&timestamp=10S'));
  });
});

describe('copyImage', () => {
  it('asks Cloudinary to fetch the picture into the folder with a signed request and returns the new address', async () => {
    let call: { url: string; body: URLSearchParams } | undefined;
    const fake = (async (url: RequestInfo | URL, init?: RequestInit) => {
      call = { url: String(url), body: new URLSearchParams(String(init?.body)) };
      return new Response(JSON.stringify({ secure_url: 'https://res.cloudinary.com/democloud/image/upload/v1/cardmaking/templates/t1/abc.png' }), { status: 200 });
    }) as typeof fetch;
    const out = await copyImage('https://res.cloudinary.com/democloud/image/upload/v9/cardmaking/u1/pic.png', 'cardmaking/templates/t1', CONFIG, fake, 1_700_000_000_000);
    expect(out).toBe('https://res.cloudinary.com/democloud/image/upload/v1/cardmaking/templates/t1/abc.png');
    expect(call!.url).toBe('https://api.cloudinary.com/v1_1/democloud/image/upload');
    const b = call!.body;
    expect(b.get('file')).toBe('https://res.cloudinary.com/democloud/image/upload/v9/cardmaking/u1/pic.png');
    expect(b.get('folder')).toBe('cardmaking/templates/t1');
    expect(b.get('api_key')).toBe('key123');
    expect(b.get('api_secret')).toBeNull(); // the secret is never sent
    const signed = { folder: b.get('folder')!, overwrite: 'false', public_id: b.get('public_id')!, timestamp: b.get('timestamp')! };
    expect(b.get('signature')).toBe(sha1(`folder=${signed.folder}&overwrite=false&public_id=${signed.public_id}&timestamp=${signed.timestamp}secret456`));
  });

  it('gives the same public id for the same picture so a retry does not duplicate it', async () => {
    const ids: string[] = [];
    const fake = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      ids.push(new URLSearchParams(String(init?.body)).get('public_id')!);
      return new Response(JSON.stringify({ secure_url: 'https://x/y.png' }), { status: 200 });
    }) as typeof fetch;
    const url = 'https://res.cloudinary.com/democloud/image/upload/v9/cardmaking/u1/pic.png';
    await copyImage(url, 'f', CONFIG, fake);
    await copyImage(url, 'f', CONFIG, fake);
    expect(ids[0]).toBe(ids[1]);
  });

  it('turns a Cloudinary or network failure into PROVIDER_FAILED', async () => {
    const bad = (async () => new Response('{"error":{"message":"nope"}}', { status: 400 })) as typeof fetch;
    await expect(copyImage('https://res.cloudinary.com/democloud/image/upload/a.png', 'f', CONFIG, bad)).rejects.toMatchObject({ code: 'PROVIDER_FAILED' });
    const down = (async () => {
      throw new Error('offline');
    }) as typeof fetch;
    await expect(copyImage('https://res.cloudinary.com/democloud/image/upload/a.png', 'f', CONFIG, down)).rejects.toBeInstanceOf(AppError);
  });
});

describe('template images in a page', () => {
  const own = 'https://res.cloudinary.com/democloud/image/upload/v1/cardmaking/u1/a.png';
  const other = 'https://res.cloudinary.com/othercloud/image/upload/v1/x/b.png';
  const page = { root: { children: [{ props: { src: own } }, { props: { src: own } }, { props: { src: other } }, { props: { text: 'hello', note: 'https://example.com/pic.png' } }] }, meta: { image: own } };

  it('collects each picture of our own cloud once, ignoring other hosts and plain text', () => {
    expect(collectImageUrls(page, 'democloud')).toEqual([own]);
  });

  it('replaces every use of a picture and leaves the rest alone, without changing the original', () => {
    const copy = replaceImageUrls(page, new Map([[own, 'https://new/a.png']])) as typeof page;
    expect(JSON.stringify(copy)).not.toContain(own);
    expect(copy.root.children[0]!.props).toEqual({ src: 'https://new/a.png' });
    expect(copy.root.children[2]!.props).toEqual({ src: other });
    expect(copy.meta.image).toBe('https://new/a.png');
    expect(page.meta.image).toBe(own);
  });
});
