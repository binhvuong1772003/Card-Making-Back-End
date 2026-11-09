import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { prisma } from '../src/infra/prisma';
import { closeQueueing } from '../src/infra/queue';
import { closeRedis } from '../src/infra/redis';
import { createUserWithToken } from './helpers/auth';
import { resetDatabase } from './helpers/database';
import { samplePage } from './helpers/pages';

const app = createApp();
const gql = (token: string, query: string, variables?: Record<string, unknown>) =>
  request(app).post('/graphql').set('Authorization', `Bearer ${token}`).send({ query, variables });
const code = (res: request.Response): string | undefined => res.body.errors?.[0]?.extensions?.code;

const PUBLISH = 'mutation($id: ID!, $slug: String, $publicationId: ID, $label: String) { publishCard(id: $id, slug: $slug, publicationId: $publicationId, label: $label) { id slug label isMain publishedAt } }';
const UNPUBLISH = 'mutation($id: ID!) { unpublishCard(id: $id) }';
const PUBLICATION = 'query($cardId: ID!) { publication(cardId: $cardId) { slug publishedAt } }';
const LIST = 'query { cards { nodes { id published } } }';
const SAVE = 'mutation($id: ID!, $revision: Int!, $document: JSON!) { saveCardDocument(id: $id, revision: $revision, document: $document) { revision } }';

const page = (text: string) => samplePage(text);

beforeEach(resetDatabase);
afterAll(async () => {
  await resetDatabase();
  await closeQueueing();
  await closeRedis();
  await prisma.$disconnect();
});

const seed = (ownerId: string, title: string, document: object = page('Xin chào'), members: object[] = []) =>
  prisma.card.create({ data: { ownerId, title, document, revision: 0, members: members as never } });

describe('publishCard', () => {
  it('publishes a snapshot under a slug made from the title', async () => {
    const owner = await createUserWithToken('o@example.com');
    const card = await seed(owner.id, 'Lễ cưới Minh & Đạt');
    const res = await gql(owner.token, PUBLISH, { id: card.id });
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.publishCard.slug).toMatch(/^le-cuoi-minh-dat-[a-z0-9]{4}$/);
    const stored = await prisma.publication.findFirstOrThrow({ where: { cardId: card.id } });
    expect(stored.document).toEqual(page('Xin chào'));
  });

  it('keeps showing the published snapshot while the draft changes, until republished', async () => {
    const owner = await createUserWithToken('o@example.com');
    const card = await seed(owner.id, 'Thiệp');
    const { id: publicationId, slug } = (await gql(owner.token, PUBLISH, { id: card.id })).body.data.publishCard;
    await gql(owner.token, SAVE, { id: card.id, revision: 0, document: page('Bản nháp mới') });

    const before = await request(app).get(`/api/v1/publications/${slug}`);
    expect(before.body.document).toEqual(page('Xin chào'));

    const again = await gql(owner.token, PUBLISH, { id: card.id, publicationId });
    expect(again.body.data.publishCard.slug).toBe(slug); // republishing keeps the link
    const after = await request(app).get(`/api/v1/publications/${slug}`);
    expect(after.body.document).toEqual(page('Bản nháp mới'));
  });

  it('moves a published card to a new slug on republish: the old link stops, a taken slug is refused, and the answers stay', async () => {
    const owner = await createUserWithToken('o@example.com');
    const other = await createUserWithToken('p@example.com');
    const card = await seed(owner.id, 'Thiệp');
    const rival = await seed(other.id, 'Của người khác');
    await gql(other.token, PUBLISH, { id: rival.id, slug: 'da-co-nguoi-dung' });
    const { id: publicationId, slug: first } = (await gql(owner.token, PUBLISH, { id: card.id, slug: 'duong-dan-cu' })).body.data.publishCard;
    await prisma.formResponse.create({ data: { cardId: card.id, blockId: 'f1', answers: [], ipHash: 'h' } });

    expect(code(await gql(owner.token, PUBLISH, { id: card.id, publicationId, slug: 'da-co-nguoi-dung' }))).toBe('CONFLICT');
    expect((await request(app).get(`/api/v1/publications/${first}`)).status).toBe(200); // lần thất bại không đổi gì

    const moved = await gql(owner.token, PUBLISH, { id: card.id, publicationId, slug: 'duong-dan-moi' });
    expect(moved.body.data.publishCard.slug).toBe('duong-dan-moi');
    expect((await request(app).get('/api/v1/publications/duong-dan-moi')).status).toBe(200);
    expect((await request(app).get(`/api/v1/publications/${first}`)).status).toBe(404);
    expect(await prisma.formResponse.count({ where: { cardId: card.id } })).toBe(1);
  });

  it('refuses a card with no content', async () => {
    const owner = await createUserWithToken('o@example.com');
    const card = await seed(owner.id, 'Trống', {});
    expect(code(await gql(owner.token, PUBLISH, { id: card.id }))).toBe('VALIDATION');
  });

  it('accepts a valid custom slug, rejects bad ones and refuses a taken one', async () => {
    const owner = await createUserWithToken('o@example.com');
    const other = await createUserWithToken('p@example.com');
    const a = await seed(owner.id, 'A');
    const b = await seed(other.id, 'B');
    const ok = await gql(owner.token, PUBLISH, { id: a.id, slug: 'minh-lan' });
    expect(ok.body.data.publishCard.slug).toBe('minh-lan');
    for (const bad of ['a', 'Minh-Lan', 'minh lan', '-minh', 'minh--lan', 'x'.repeat(61)]) {
      expect(code(await gql(other.token, PUBLISH, { id: b.id, slug: bad })), bad).toBe('VALIDATION');
    }
    expect(code(await gql(other.token, PUBLISH, { id: b.id, slug: 'minh-lan' }))).toBe('CONFLICT');
  });

  it('lets only the owner publish', async () => {
    const owner = await createUserWithToken('o@example.com');
    const editor = await createUserWithToken('e@example.com');
    const viewer = await createUserWithToken('v@example.com');
    const stranger = await createUserWithToken('s@example.com');
    const card = await seed(owner.id, 'T', page('x'), [
      { userId: editor.id, role: 'EDITOR', addedAt: new Date() },
      { userId: viewer.id, role: 'VIEWER', addedAt: new Date() },
    ]);
    expect(code(await gql(editor.token, PUBLISH, { id: card.id }))).toBe('FORBIDDEN');
    expect(code(await gql(viewer.token, PUBLISH, { id: card.id }))).toBe('FORBIDDEN');
    expect(code(await gql(stranger.token, PUBLISH, { id: card.id }))).toBe('NOT_FOUND');
    expect(await prisma.publication.count()).toBe(0);
  });
});

describe('unpublishCard and reading', () => {
  it('takes the page down and brings it back on republish', async () => {
    const owner = await createUserWithToken('o@example.com');
    const card = await seed(owner.id, 'T');
    const { id: publicationId, slug } = (await gql(owner.token, PUBLISH, { id: card.id })).body.data.publishCard;
    expect((await gql(owner.token, LIST)).body.data.cards.nodes[0].published).toBe(true);

    expect((await gql(owner.token, UNPUBLISH, { id: card.id })).body.data.unpublishCard).toBe(true);
    expect((await request(app).get(`/api/v1/publications/${slug}`)).status).toBe(404);
    expect((await gql(owner.token, PUBLICATION, { cardId: card.id })).body.data.publication).toBeNull();
    expect((await gql(owner.token, LIST)).body.data.cards.nodes[0].published).toBe(false);

    await gql(owner.token, PUBLISH, { id: card.id, publicationId }); // mở lại đúng bản đã gỡ, giữ slug cũ
    expect((await request(app).get(`/api/v1/publications/${slug}`)).status).toBe(200);
  });

  it('publication(cardId) shows the live link to anyone who can see the card', async () => {
    const owner = await createUserWithToken('o@example.com');
    const viewer = await createUserWithToken('v@example.com');
    const stranger = await createUserWithToken('s@example.com');
    const card = await seed(owner.id, 'T', page('x'), [{ userId: viewer.id, role: 'VIEWER', addedAt: new Date() }]);
    const { slug } = (await gql(owner.token, PUBLISH, { id: card.id })).body.data.publishCard;
    expect((await gql(viewer.token, PUBLICATION, { cardId: card.id })).body.data.publication.slug).toBe(slug);
    expect(code(await gql(stranger.token, PUBLICATION, { cardId: card.id }))).toBe('NOT_FOUND');
  });

  it('serves the public page without a login, with the title and no owner details', async () => {
    const owner = await createUserWithToken('o@example.com');
    const card = await seed(owner.id, 'Thiệp công khai');
    const { slug } = (await gql(owner.token, PUBLISH, { id: card.id })).body.data.publishCard;
    const res = await request(app).get(`/api/v1/publications/${slug}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ slug, title: 'Thiệp công khai', document: page('Xin chào'), publishedAt: expect.any(String) });
    expect(res.headers['cache-control']).toMatch(/public/);
    expect(JSON.stringify(res.body)).not.toContain(owner.id);
  });

  it('answers 404 for an unknown or malformed slug and once the card is deleted', async () => {
    const owner = await createUserWithToken('o@example.com');
    const card = await seed(owner.id, 'T');
    const { slug } = (await gql(owner.token, PUBLISH, { id: card.id })).body.data.publishCard;
    expect((await request(app).get('/api/v1/publications/khong-co')).status).toBe(404);
    expect((await request(app).get('/api/v1/publications/BAD%20SLUG')).status).toBe(404);
    await gql(owner.token, 'mutation($id: ID!) { deleteCard(id: $id) }', { id: card.id });
    expect((await request(app).get(`/api/v1/publications/${slug}`)).status).toBe(404);
  });
});

const PUBLICATIONS = 'query($cardId: ID!) { publications(cardId: $cardId) { id slug label isMain listInGallery galleryStatus } }';
const UNPUBLISH_ONE = 'mutation($cardId: ID!, $publicationId: ID!) { unpublishPublication(cardId: $cardId, publicationId: $publicationId) }';
const RESTORE = 'mutation($cardId: ID!, $publicationId: ID!) { restoreDraftFromPublication(cardId: $cardId, publicationId: $publicationId) }';
const DRAFT = 'query($id: ID!) { card(id: $id) { revision document } }';
const COUNT = 'query { cards { nodes { id published publicationCount } } }';

describe('several publications of one card', () => {
  it('publishes each version under its own link, with its own snapshot and a name; the first is the main one', async () => {
    const owner = await createUserWithToken('o@example.com');
    const card = await seed(owner.id, 'Thiệp cưới');
    const a = (await gql(owner.token, PUBLISH, { id: card.id, slug: 'nha-trai', label: '  Nhà trai ' })).body.data.publishCard;
    await gql(owner.token, SAVE, { id: card.id, revision: 0, document: page('Bản cho nhà gái') });
    const b = (await gql(owner.token, PUBLISH, { id: card.id, slug: 'nha-gai', label: 'Nhà gái' })).body.data.publishCard;
    expect(a).toMatchObject({ slug: 'nha-trai', label: 'Nhà trai', isMain: true });
    expect(b).toMatchObject({ slug: 'nha-gai', label: 'Nhà gái', isMain: false });
    expect((await request(app).get('/api/v1/publications/nha-trai')).body.document).toEqual(page('Xin chào'));
    expect((await request(app).get('/api/v1/publications/nha-gai')).body.document).toEqual(page('Bản cho nhà gái'));

    const list = (await gql(owner.token, PUBLICATIONS, { cardId: card.id })).body.data.publications;
    expect(list.map((p: { slug: string; isMain: boolean }) => [p.slug, p.isMain])).toEqual([['nha-trai', true], ['nha-gai', false]]);
    expect((await gql(owner.token, PUBLICATION, { cardId: card.id })).body.data.publication.slug).toBe('nha-trai'); // `publication` là bản chính
    expect((await gql(owner.token, COUNT)).body.data.cards.nodes[0]).toMatchObject({ published: true, publicationCount: 2 });
  });

  it('refuses a sixth open version, counts only the open ones, and lets a freed place be used', async () => {
    const owner = await createUserWithToken('o@example.com');
    const card = await seed(owner.id, 'Thiệp');
    const ids: string[] = [];
    for (let n = 1; n <= 5; n++) ids.push((await gql(owner.token, PUBLISH, { id: card.id, slug: `ban-so-${n}` })).body.data.publishCard.id);
    const sixth = await gql(owner.token, PUBLISH, { id: card.id, slug: 'ban-so-6' });
    expect(code(sixth)).toBe('CONFLICT');
    expect(sixth.body.errors[0].extensions.details ?? sixth.body.errors[0].extensions.reason).toBeDefined();
    // Cập nhật một bản đã có thì không bị chặn bởi giới hạn.
    expect(code(await gql(owner.token, PUBLISH, { id: card.id, publicationId: ids[2] }))).toBeUndefined();
    await gql(owner.token, UNPUBLISH_ONE, { cardId: card.id, publicationId: ids[4] });
    expect(code(await gql(owner.token, PUBLISH, { id: card.id, slug: 'ban-so-6' }))).toBeUndefined();
  });

  it('takes down one version only: its link stops, the others and the main flag stay right', async () => {
    const owner = await createUserWithToken('o@example.com');
    const card = await seed(owner.id, 'Thiệp');
    const a = (await gql(owner.token, PUBLISH, { id: card.id, slug: 'ban-chinh' })).body.data.publishCard;
    await gql(owner.token, PUBLISH, { id: card.id, slug: 'ban-phu' });
    expect((await gql(owner.token, UNPUBLISH_ONE, { cardId: card.id, publicationId: a.id })).body.data.unpublishPublication).toBe(true);
    expect((await gql(owner.token, UNPUBLISH_ONE, { cardId: card.id, publicationId: a.id })).body.data.unpublishPublication).toBe(true); // gọi lại không sao
    expect((await request(app).get('/api/v1/publications/ban-chinh')).status).toBe(404);
    expect((await request(app).get('/api/v1/publications/ban-phu')).status).toBe(200);
    const list = (await gql(owner.token, PUBLICATIONS, { cardId: card.id })).body.data.publications;
    expect(list.map((p: { slug: string; isMain: boolean }) => [p.slug, p.isMain])).toEqual([['ban-phu', true]]); // bản còn lại thành bản chính
    expect((await gql(owner.token, UNPUBLISH, { id: card.id })).body.data.unpublishCard).toBe(true); // gỡ tất cả
    expect((await gql(owner.token, COUNT)).body.data.cards.nodes[0]).toMatchObject({ published: false, publicationCount: 0 });
  });

  it('only lets the owner touch versions, and a version of another card is not found', async () => {
    const owner = await createUserWithToken('o@example.com');
    const editor = await createUserWithToken('e@example.com');
    const card = await seed(owner.id, 'Thiệp', page('Xin chào'), [{ userId: editor.id, role: 'EDITOR', addedAt: new Date() }]);
    const other = await seed(owner.id, 'Thiệp khác');
    const a = (await gql(owner.token, PUBLISH, { id: card.id })).body.data.publishCard;
    expect(code(await gql(editor.token, UNPUBLISH_ONE, { cardId: card.id, publicationId: a.id }))).toBe('FORBIDDEN');
    expect(code(await gql(editor.token, RESTORE, { cardId: card.id, publicationId: a.id }))).toBe('FORBIDDEN');
    expect(code(await gql(owner.token, PUBLISH, { id: other.id, publicationId: a.id }))).toBe('NOT_FOUND');
    expect(code(await gql(owner.token, UNPUBLISH_ONE, { cardId: other.id, publicationId: a.id }))).toBe('NOT_FOUND');
    expect(code(await gql(owner.token, UNPUBLISH_ONE, { cardId: card.id, publicationId: 'not-an-id' }))).toBe('NOT_FOUND');
    expect(code(await gql(editor.token, PUBLICATIONS, { cardId: card.id }))).toBeUndefined(); // người sửa xem được danh sách
  });

  it('loads a published version back into the draft and bumps the revision, leaving the versions alone', async () => {
    const owner = await createUserWithToken('o@example.com');
    const card = await seed(owner.id, 'Thiệp');
    const a = (await gql(owner.token, PUBLISH, { id: card.id, slug: 'ban-cu' })).body.data.publishCard;
    await gql(owner.token, SAVE, { id: card.id, revision: 0, document: page('Bản nháp đã sửa') });
    const revision = (await gql(owner.token, RESTORE, { cardId: card.id, publicationId: a.id })).body.data.restoreDraftFromPublication;
    expect(revision).toBe(2);
    const draft = (await gql(owner.token, DRAFT, { id: card.id })).body.data.card;
    expect(draft).toMatchObject({ revision: 2, document: page('Xin chào') });
    expect((await request(app).get('/api/v1/publications/ban-cu')).body.document).toEqual(page('Xin chào'));
  });

  it('restores the selected start page and navigation links from a multipage publication', async () => {
    const owner = await createUserWithToken('restore-multipage@example.com');
    const original = { kind: 'card', version: 1, startPageId: 'p2', pages: [
      { id: 'p1', name: 'Cover', data: page('cover'), interactions: { n1: { type: 'go-to-page', targetPageId: 'p2', transition: 'slide-left', durationMs: 600 } } },
      { id: 'p2', name: 'Message', data: page('message'), interactions: {} },
    ] };
    const card = await seed(owner.id, 'Thiệp', original);
    const publication = (await gql(owner.token, PUBLISH, { id: card.id })).body.data.publishCard;
    const changed = { ...original, startPageId: 'p1' };
    await gql(owner.token, SAVE, { id: card.id, revision: 0, document: changed });
    const revision = (await gql(owner.token, RESTORE, { cardId: card.id, publicationId: publication.id })).body.data.restoreDraftFromPublication;
    expect(revision).toBe(2);
    expect((await gql(owner.token, DRAFT, { id: card.id })).body.data.card.document).toEqual(original);
  });

  it('keeps the name when a version is republished without one, and clears it with an empty one', async () => {
    const owner = await createUserWithToken('o@example.com');
    const card = await seed(owner.id, 'Thiệp');
    const a = (await gql(owner.token, PUBLISH, { id: card.id, label: 'Nhà trai' })).body.data.publishCard;
    expect((await gql(owner.token, PUBLISH, { id: card.id, publicationId: a.id })).body.data.publishCard.label).toBe('Nhà trai');
    expect((await gql(owner.token, PUBLISH, { id: card.id, publicationId: a.id, label: '' })).body.data.publishCard.label).toBeNull();
    expect(code(await gql(owner.token, PUBLISH, { id: card.id, publicationId: a.id, label: 'x'.repeat(41) }))).toBe('VALIDATION');
  });
});
