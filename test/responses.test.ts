import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { prisma } from '../src/infra/prisma';
import { closeQueueing } from '../src/infra/queue';
import { closeRedis } from '../src/infra/redis';
import { buildRsvpsCsv, ipHashOf, submitGuestbook, submitRsvp, type RsvpView } from '../src/modules/cards/responses/responses.service';
import { isClosed } from '../src/modules/cards/responses/responses.config';
import { createUserWithToken } from './helpers/auth';
import { resetDatabase } from './helpers/database';

beforeEach(resetDatabase);
afterAll(async () => {
  await resetDatabase();
  await closeQueueing();
  await closeRedis();
});

const app = createApp({ rsvpHourlyLimit: 1000, guestbookHourlyLimit: 1000 });
const gql = (token: string, query: string, variables?: Record<string, unknown>) => request(app).post('/graphql').set('Authorization', `Bearer ${token}`).send({ query, variables });
const code = (res: request.Response): string | undefined => res.body.errors?.[0]?.extensions?.code;

const block = (id: string, type: string, props: Record<string, unknown> = {}) => ({ id, type, props, styles: {}, children: [] });
const pageWith = (...blocks: unknown[]) => ({ schemaVersion: 1, root: { id: 'root', type: 'Page', props: {}, styles: {}, children: blocks } });

// Thiệp đã xuất bản dựng thẳng trong DB: các khối form chưa có trong danh sách khối của editor, mà service chỉ đọc bản xuất bản.
async function seed(options: { members?: { userId: string; role: 'EDITOR' | 'VIEWER' }[]; slug?: string; blocks?: unknown[]; published?: boolean } = {}) {
  const owner = await createUserWithToken('owner@example.com');
  const card = await prisma.card.create({
    data: { ownerId: owner.id, title: 'Thiệp cưới mẫu', document: {}, members: (options.members ?? []).map((m) => ({ ...m, addedAt: new Date() })) },
  });
  const slug = options.slug ?? 'thiep-cuoi-mau';
  const blocks = options.blocks ?? [block('rsvp1', 'Rsvp', { maxGuests: 4 }), block('gb1', 'Guestbook'), block('t1', 'Text')];
  await prisma.publication.create({
    data: { cardId: card.id, slug, document: pageWith(...blocks), publishedAt: new Date(), ...(options.published === false ? { unpublishedAt: new Date() } : {}) },
  });
  return { owner, card, slug };
}

const postRsvp = (slug: string, body: Record<string, unknown>) => request(app).post(`/api/v1/publications/${slug}/rsvps`).send({ blockId: 'rsvp1', name: 'Nguyễn Minh Anh', attending: 'YES', guests: 2, ...body });
const postEntry = (slug: string, body: Record<string, unknown>) => request(app).post(`/api/v1/publications/${slug}/guestbook`).send({ blockId: 'gb1', name: 'Lan Chi', message: 'Chúc mừng hai bạn!', ...body });

describe('isClosed', () => {
  it('stays open through the whole deadline day in Vietnam, then closes', () => {
    expect(isClosed(null, new Date('2030-01-01T00:00:00Z'))).toBe(false);
    expect(isClosed('2025-12-20', new Date('2025-12-20T16:59:59.999Z'))).toBe(false); // 23:59:59.999 giờ Việt Nam
    expect(isClosed('2025-12-20', new Date('2025-12-20T17:00:00.000Z'))).toBe(true); // 00:00 ngày 21
  });

  it('treats a date that does not exist as no deadline', () => {
    expect(isClosed('2025-02-30', new Date('2030-01-01T00:00:00Z'))).toBe(false);
  });
});

describe('POST /publications/:slug/rsvps', () => {
  it('stores an answer and says nothing about the card or the other guests', async () => {
    const { card, slug } = await seed();
    const res = await postRsvp(slug, { phone: '0900000000', note: 'Cho mình chỗ gần sân khấu' });
    expect(res.status).toBe(201);
    expect(Object.keys(res.body)).toEqual(['id']);
    const row = await prisma.rsvp.findFirstOrThrow({ where: { cardId: card.id } });
    expect(row).toMatchObject({ blockId: 'rsvp1', name: 'Nguyễn Minh Anh', attending: 'YES', guests: 2, note: 'Cho mình chỗ gần sân khấu' });
    expect(row.phone).toBeNull(); // khối không bật hỏi số điện thoại nên bỏ
  });

  it('keeps the phone only when the block asks for it, and drops the note when it does not', async () => {
    const { card, slug } = await seed({ blocks: [block('rsvp1', 'Rsvp', { askPhone: true, askNote: false })] });
    await postRsvp(slug, { phone: '0900 000 000', note: 'bỏ' }).expect(201);
    const row = await prisma.rsvp.findFirstOrThrow({ where: { cardId: card.id } });
    expect(row.phone).toBe('0900 000 000');
    expect(row.note).toBeNull();
  });

  it('gives a No no guest count, and a Yes one guest when the block does not ask', async () => {
    const { card, slug } = await seed({ blocks: [block('rsvp1', 'Rsvp', { askGuests: false })] });
    await postRsvp(slug, { attending: 'NO', guests: 3, name: 'A' }).expect(201);
    await postRsvp(slug, { attending: 'YES', guests: 3, name: 'B' }).expect(201);
    const rows = await prisma.rsvp.findMany({ where: { cardId: card.id }, orderBy: { name: 'asc' } });
    expect(rows.map((r) => [r.name, r.attending, r.guests])).toEqual([['A', 'NO', null], ['B', 'YES', 1]]);
  });

  it('refuses more guests than the block allows, and Maybe when the block does not offer it', async () => {
    const { slug } = await seed({ blocks: [block('rsvp1', 'Rsvp', { maxGuests: 2, askMaybe: false })] });
    expect((await postRsvp(slug, { guests: 3 })).status).toBe(400);
    expect((await postRsvp(slug, { attending: 'MAYBE' })).status).toBe(400);
  });

  it('refuses input that breaks the rules', async () => {
    const { slug } = await seed();
    for (const body of [{ name: '' }, { name: 'x'.repeat(101) }, { attending: 'PERHAPS' }, { guests: 0 }, { phone: 'abc' }, { note: 'x'.repeat(501) }, { name: 'a\u0000b' }]) {
      expect((await postRsvp(slug, body)).status, JSON.stringify(body).slice(0, 40)).toBe(400);
    }
  });

  it('answers 404 for an unpublished card, a bad slug, a block that is missing or not a form', async () => {
    const live = await seed();
    expect((await postRsvp('khong-co', {})).status).toBe(404);
    expect((await postRsvp('Bad Slug', {})).status).toBe(404);
    expect((await postRsvp(live.slug, { blockId: 'nope' })).status).toBe(404);
    expect((await postRsvp(live.slug, { blockId: 't1' })).status).toBe(404);
    expect((await postRsvp(live.slug, { blockId: 'gb1' })).status).toBe(404); // khối sổ lưu bút không nhận xác nhận
    await prisma.publication.updateMany({ data: { unpublishedAt: new Date() } });
    expect((await postRsvp(live.slug, {})).status).toBe(404);
  });

  it('closes after the deadline with CONFLICT and a reason, and stays open before it', async () => {
    const past = await seed({ blocks: [block('rsvp1', 'Rsvp', { deadline: '2000-01-01' })], slug: 'het-han' });
    const res = await postRsvp(past.slug, {});
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'CONFLICT', details: { reason: 'CLOSED' } });
    await prisma.publication.update({ where: { cardId: past.card.id }, data: { document: pageWith(block('rsvp1', 'Rsvp', { deadline: '2999-01-01' })) } });
    expect((await postRsvp(past.slug, {})).status).toBe(201);
  });

  it('ignores a bot that fills the hidden field, yet answers as if it worked', async () => {
    const { card, slug } = await seed();
    const res = await postRsvp(slug, { website: 'http://spam.example' });
    expect(res.status).toBe(201);
    expect(await prisma.rsvp.count({ where: { cardId: card.id } })).toBe(0);
  });

  it('counts an identical submission within a minute as one (a double click)', async () => {
    const { card, slug } = await seed();
    const first = await postRsvp(slug, {});
    const second = await postRsvp(slug, {});
    expect(second.body.id).toBe(first.body.id);
    expect(await prisma.rsvp.count({ where: { cardId: card.id } })).toBe(1);
    await postRsvp(slug, { guests: 3 }).expect(201); // khác nội dung thì là dòng mới
    expect(await prisma.rsvp.count({ where: { cardId: card.id } })).toBe(2);
  });

  it('does not keep the IP, only a hash that changes with the day', async () => {
    const { card, slug } = await seed();
    await postRsvp(slug, {});
    const row = await prisma.rsvp.findFirstOrThrow({ where: { cardId: card.id } });
    expect(row.ipHash).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(row)).not.toMatch(/127\.0\.0\.1|::1|::ffff/);
    expect(ipHashOf('1.2.3.4', new Date('2026-01-01T10:00:00Z'))).toBe(ipHashOf('1.2.3.4', new Date('2026-01-01T23:00:00Z')));
    expect(ipHashOf('1.2.3.4', new Date('2026-01-01T10:00:00Z'))).not.toBe(ipHashOf('1.2.3.4', new Date('2026-01-02T10:00:00Z')));
  });

  it('stops taking answers once a card is full', async () => {
    const { slug } = await seed();
    const deps = { now: () => new Date(), limits: { maxRsvps: 1, maxEntries: 1, duplicateWindowMs: 0 } };
    await submitRsvp(slug, { blockId: 'rsvp1', name: 'A', attending: 'YES' }, { ip: '1.1.1.1' }, deps);
    await expect(submitRsvp(slug, { blockId: 'rsvp1', name: 'B', attending: 'YES' }, { ip: '1.1.1.1' }, deps)).rejects.toMatchObject({ code: 'CONFLICT', details: { reason: 'FULL' } });
  });

  it('answers 429 after too many tries from one IP to one card, and not for another card', async () => {
    const limited = createApp({ rsvpHourlyLimit: 2 });
    const a = await seed({ slug: 'thiep-a' });
    for (let i = 0; i < 2; i++) await request(limited).post(`/api/v1/publications/${a.slug}/rsvps`).send({ blockId: 'rsvp1', name: `K${i}`, attending: 'NO' }).expect(201);
    expect((await request(limited).post(`/api/v1/publications/${a.slug}/rsvps`).send({ blockId: 'rsvp1', name: 'K9', attending: 'NO' })).status).toBe(429);
    const owner = await createUserWithToken('other@example.com');
    const card = await prisma.card.create({ data: { ownerId: owner.id, title: 'B', document: {}, members: [] } });
    await prisma.publication.create({ data: { cardId: card.id, slug: 'thiep-b', document: pageWith(block('rsvp1', 'Rsvp')), publishedAt: new Date() } });
    await request(limited).post('/api/v1/publications/thiep-b/rsvps').send({ blockId: 'rsvp1', name: 'K', attending: 'NO' }).expect(201);
  });
});

describe('guestbook, public side', () => {
  it('shows a new message at once by default and returns it to the sender', async () => {
    const { slug } = await seed();
    const res = await postEntry(slug, {});
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'VISIBLE', entry: { name: 'Lan Chi', message: 'Chúc mừng hai bạn!' } });
    const list = await request(app).get(`/api/v1/publications/${slug}/guestbook?blockId=gb1`).expect(200);
    expect(list.body).toMatchObject({ total: 1, nextCursor: null });
    expect(Object.keys(list.body.entries[0]).sort()).toEqual(['createdAt', 'id', 'message', 'name']);
    expect(list.headers['cache-control']).toBe('public, max-age=10');
  });

  it('holds a message back as PENDING when the block moderates, and does not list it', async () => {
    const { slug } = await seed({ blocks: [block('gb1', 'Guestbook', { moderation: true })] });
    const res = await postEntry(slug, {});
    expect(res.body).toMatchObject({ status: 'PENDING', entry: null });
    const list = await request(app).get(`/api/v1/publications/${slug}/guestbook?blockId=gb1`).expect(200);
    expect(list.body).toMatchObject({ entries: [], total: 0 });
  });

  it('lists the newest first, ten at a time by default, and pages with a cursor', async () => {
    const { card, slug } = await seed();
    const base = Date.now();
    for (let i = 0; i < 5; i++) await prisma.guestbookEntry.create({ data: { cardId: card.id, blockId: 'gb1', name: `K${i}`, message: `m${i}`, status: 'VISIBLE', ipHash: 'x', createdAt: new Date(base + i * 1000) } });
    await prisma.guestbookEntry.create({ data: { cardId: card.id, blockId: 'gb1', name: 'Ẩn', message: 'ẩn', status: 'HIDDEN', ipHash: 'x', createdAt: new Date(base + 9000) } });
    const one = await request(app).get(`/api/v1/publications/${slug}/guestbook?blockId=gb1&first=2`).expect(200);
    expect(one.body.entries.map((e: { name: string }) => e.name)).toEqual(['K4', 'K3']);
    expect(one.body.total).toBe(5);
    const two = await request(app).get(`/api/v1/publications/${slug}/guestbook?blockId=gb1&first=2&after=${one.body.nextCursor}`).expect(200);
    expect(two.body.entries.map((e: { name: string }) => e.name)).toEqual(['K2', 'K1']);
    const three = await request(app).get(`/api/v1/publications/${slug}/guestbook?blockId=gb1&first=2&after=${two.body.nextCursor}`).expect(200);
    expect(three.body.entries.map((e: { name: string }) => e.name)).toEqual(['K0']);
    expect(three.body.nextCursor).toBeNull();
    expect((await request(app).get(`/api/v1/publications/${slug}/guestbook?blockId=gb1&after=junk`)).status).toBe(400);
  });

  it('refuses a name over 60 or a message over 500, and an empty one', async () => {
    const { slug } = await seed();
    for (const body of [{ name: 'x'.repeat(61) }, { message: 'x'.repeat(501) }, { message: '   ' }, { name: '' }]) expect((await postEntry(slug, body)).status).toBe(400);
  });

  it('stores the message as plain text, as it came', async () => {
    const { slug } = await seed();
    await postEntry(slug, { message: '<script>alert(1)</script>\nDòng hai' }).expect(201);
    const list = await request(app).get(`/api/v1/publications/${slug}/guestbook?blockId=gb1`);
    expect(list.body.entries[0].message).toBe('<script>alert(1)</script>\nDòng hai');
  });

  it('is gone once the card is unpublished, for sending and for reading', async () => {
    const { slug } = await seed({ published: false });
    expect((await postEntry(slug, {})).status).toBe(404);
    expect((await request(app).get(`/api/v1/publications/${slug}/guestbook?blockId=gb1`)).status).toBe(404);
  });

  it('ignores the hidden field and counts duplicates as one', async () => {
    const { card, slug } = await seed();
    expect((await postEntry(slug, { website: 'x' })).status).toBe(201);
    expect(await prisma.guestbookEntry.count({ where: { cardId: card.id } })).toBe(0);
    const first = await postEntry(slug, {});
    const second = await postEntry(slug, {});
    expect(second.body.id).toBe(first.body.id);
    expect(await prisma.guestbookEntry.count({ where: { cardId: card.id } })).toBe(1);
  });

  it('answers 429 after the hourly limit for one IP and one card', async () => {
    const limited = createApp({ guestbookHourlyLimit: 1 });
    const { slug } = await seed();
    await request(limited).post(`/api/v1/publications/${slug}/guestbook`).send({ blockId: 'gb1', name: 'A', message: 'một' }).expect(201);
    expect((await request(limited).post(`/api/v1/publications/${slug}/guestbook`).send({ blockId: 'gb1', name: 'A', message: 'hai' })).status).toBe(429);
  });

  it('stops taking messages once a card is full', async () => {
    const { slug } = await seed();
    const deps = { now: () => new Date(), limits: { maxRsvps: 1, maxEntries: 1, duplicateWindowMs: 0 } };
    await submitGuestbook(slug, { blockId: 'gb1', name: 'A', message: 'một' }, { ip: '1.1.1.1' }, deps);
    await expect(submitGuestbook(slug, { blockId: 'gb1', name: 'B', message: 'hai' }, { ip: '1.1.1.1' }, deps)).rejects.toMatchObject({ code: 'CONFLICT', details: { reason: 'FULL' } });
  });
});

const RSVPS = 'query($cardId: ID!, $answer: RsvpAnswer, $search: String, $first: Int, $after: String) { rsvps(cardId: $cardId, answer: $answer, search: $search, first: $first, after: $after) { nodes { id name attending guests phone note } pageInfo { hasNextPage endCursor } summary { yes no maybe guests } } }';
const ENTRIES = 'query($cardId: ID!, $status: EntryStatus, $first: Int) { guestbookEntries(cardId: $cardId, status: $status, first: $first) { nodes { id name message status } pageInfo { hasNextPage } counts { visible hidden pending } } }';

async function fill(cardId: string) {
  const base = Date.now();
  const rows: [string, 'YES' | 'NO' | 'MAYBE', number | undefined][] = [['An', 'YES', 2], ['Bình', 'YES', 3], ['Chi', 'NO', undefined], ['Dũng', 'MAYBE', 1]];
  for (const [i, [name, attending, guests]] of rows.entries()) {
    await prisma.rsvp.create({ data: { cardId, blockId: 'rsvp1', name, attending, ...(guests ? { guests } : {}), ipHash: 'x', createdAt: new Date(base + i * 1000) } });
  }
}

describe('what the owner sees', () => {
  it('needs a login, and shows nobody else’s card', async () => {
    const { card } = await seed();
    const anon = await request(app).post('/graphql').send({ query: RSVPS, variables: { cardId: card.id } });
    expect(code(anon)).toBe('UNAUTHENTICATED');
    const stranger = await createUserWithToken('stranger@example.com');
    expect(code(await gql(stranger.token, RSVPS, { cardId: card.id }))).toBe('NOT_FOUND');
    expect(code(await gql(stranger.token, RSVPS, { cardId: 'not-an-id' }))).toBe('NOT_FOUND');
  });

  it('lets the owner and an editor in, and keeps a viewer out', async () => {
    const editor = await createUserWithToken('editor@example.com');
    const viewer = await createUserWithToken('viewer@example.com');
    const { owner, card } = await seed({ members: [{ userId: editor.id, role: 'EDITOR' }, { userId: viewer.id, role: 'VIEWER' }] });
    expect((await gql(owner.token, RSVPS, { cardId: card.id })).body.errors).toBeUndefined();
    expect((await gql(editor.token, RSVPS, { cardId: card.id })).body.errors).toBeUndefined();
    expect(code(await gql(viewer.token, RSVPS, { cardId: card.id }))).toBe('FORBIDDEN');
    expect(code(await gql(viewer.token, ENTRIES, { cardId: card.id }))).toBe('FORBIDDEN');
  });

  it('lists answers newest first with the totals of the whole card', async () => {
    const { owner, card } = await seed();
    await fill(card.id);
    const res = await gql(owner.token, RSVPS, { cardId: card.id });
    const data = res.body.data.rsvps;
    expect(data.nodes.map((n: { name: string }) => n.name)).toEqual(['Dũng', 'Chi', 'Bình', 'An']);
    expect(data.summary).toEqual({ yes: 2, no: 1, maybe: 1, guests: 5 });
    expect(data.nodes[1]).toMatchObject({ attending: 'NO', guests: null });
  });

  it('filters by answer and by name without changing the totals, and pages', async () => {
    const { owner, card } = await seed();
    await fill(card.id);
    const yes = (await gql(owner.token, RSVPS, { cardId: card.id, answer: 'YES' })).body.data.rsvps;
    expect(yes.nodes.map((n: { name: string }) => n.name)).toEqual(['Bình', 'An']);
    expect(yes.summary.no).toBe(1);
    const found = (await gql(owner.token, RSVPS, { cardId: card.id, search: 'dũ' })).body.data.rsvps;
    expect(found.nodes.map((n: { name: string }) => n.name)).toEqual(['Dũng']);
    const special = await gql(owner.token, RSVPS, { cardId: card.id, search: '[(.*' });
    expect(special.body.errors).toBeUndefined(); // ký tự đặc biệt trong ô tìm không làm hỏng truy vấn
    expect(special.body.data.rsvps.nodes).toEqual([]);
    const first = (await gql(owner.token, RSVPS, { cardId: card.id, first: 3 })).body.data.rsvps;
    expect(first.pageInfo.hasNextPage).toBe(true);
    const next = (await gql(owner.token, RSVPS, { cardId: card.id, first: 3, after: first.pageInfo.endCursor })).body.data.rsvps;
    expect(next.nodes.map((n: { name: string }) => n.name)).toEqual(['An']);
    expect(code(await gql(owner.token, RSVPS, { cardId: card.id, first: 101 }))).toBe('VALIDATION');
  });

  it('deletes an answer, but not one of somebody else’s card', async () => {
    const mine = await seed();
    await fill(mine.card.id);
    const target = await prisma.rsvp.findFirstOrThrow({ where: { cardId: mine.card.id, name: 'An' } });
    const stranger = await createUserWithToken('stranger@example.com');
    expect(code(await gql(stranger.token, 'mutation($id: ID!) { deleteRsvp(id: $id) }', { id: target.id }))).toBe('NOT_FOUND');
    expect(code(await gql(mine.owner.token, 'mutation($id: ID!) { deleteRsvp(id: $id) }', { id: 'xyz' }))).toBe('NOT_FOUND');
    const ok = await gql(mine.owner.token, 'mutation($id: ID!) { deleteRsvp(id: $id) }', { id: target.id });
    expect(ok.body.data.deleteRsvp).toBe(true);
    expect(await prisma.rsvp.count({ where: { cardId: mine.card.id } })).toBe(3);
  });

  it('moderates the guestbook: counts, hide, show, approve and delete', async () => {
    const { owner, card } = await seed();
    const make = (name: string, status: 'VISIBLE' | 'HIDDEN' | 'PENDING', at: number) => prisma.guestbookEntry.create({ data: { cardId: card.id, blockId: 'gb1', name, message: `Lời của ${name}`, status, ipHash: 'x', createdAt: new Date(at) } });
    const a = await make('A', 'VISIBLE', 1000);
    await make('B', 'PENDING', 2000);
    await make('C', 'HIDDEN', 3000);
    const all = (await gql(owner.token, ENTRIES, { cardId: card.id })).body.data.guestbookEntries;
    expect(all.nodes.map((n: { name: string }) => n.name)).toEqual(['C', 'B', 'A']);
    expect(all.counts).toEqual({ visible: 1, hidden: 1, pending: 1 });
    const pending = (await gql(owner.token, ENTRIES, { cardId: card.id, status: 'PENDING' })).body.data.guestbookEntries;
    expect(pending.nodes.map((n: { name: string }) => n.name)).toEqual(['B']);
    const SET = 'mutation($id: ID!, $status: EntryStatus!) { setGuestbookEntryStatus(id: $id, status: $status) { id status } }';
    expect((await gql(owner.token, SET, { id: a.id, status: 'HIDDEN' })).body.data.setGuestbookEntryStatus.status).toBe('HIDDEN');
    expect(code(await gql(owner.token, SET, { id: a.id, status: 'NOPE' }))).toBeDefined();
    const publicList = await request(app).get('/api/v1/publications/thiep-cuoi-mau/guestbook?blockId=gb1');
    expect(publicList.body.entries).toEqual([]); // đã ẩn thì khách không thấy
    await gql(owner.token, SET, { id: a.id, status: 'VISIBLE' });
    expect((await request(app).get('/api/v1/publications/thiep-cuoi-mau/guestbook?blockId=gb1')).body.entries).toHaveLength(1);
    await gql(owner.token, 'mutation($id: ID!) { deleteGuestbookEntry(id: $id) }', { id: a.id });
    expect(await prisma.guestbookEntry.count({ where: { cardId: card.id } })).toBe(2);
    const stranger = await createUserWithToken('stranger@example.com');
    const b = await prisma.guestbookEntry.findFirstOrThrow({ where: { cardId: card.id, name: 'B' } });
    expect(code(await gql(stranger.token, SET, { id: b.id, status: 'VISIBLE' }))).toBe('NOT_FOUND');
  });
});

describe('CSV', () => {
  it('is only for a signed-in person who can see the answers', async () => {
    const { card } = await seed();
    expect((await request(app).get(`/api/v1/cards/${card.id}/rsvps.csv`)).status).toBe(401);
    const stranger = await createUserWithToken('stranger@example.com');
    expect((await request(app).get(`/api/v1/cards/${card.id}/rsvps.csv`).set('Authorization', `Bearer ${stranger.token}`)).status).toBe(404);
    expect((await request(app).get('/api/v1/cards/not-an-id/rsvps.csv').set('Authorization', `Bearer ${stranger.token}`)).status).toBe(404);
  });

  it('downloads a UTF-8 file with a BOM, Vietnamese headers, oldest first, and no caching', async () => {
    const { owner, card } = await seed();
    await fill(card.id);
    const res = await request(app).get(`/api/v1/cards/${card.id}/rsvps.csv`).set('Authorization', `Bearer ${owner.token}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['cache-control']).toBe('no-store');
    const text = res.text;
    expect(text.charCodeAt(0)).toBe(0xfeff);
    const lines = text.slice(1).trimEnd().split('\r\n');
    expect(lines[0]).toBe('Họ và tên,Đáp án,Số khách,Số điện thoại,Lời nhắn,Gửi lúc');
    expect(lines.slice(1).map((l) => l.split(',').slice(0, 3).join(','))).toEqual(['An,Có,2', 'Bình,Có,3', 'Chi,Không đến,', 'Dũng,Chưa chắc,1']);
  });

  it('escapes quotes and commas, and defuses cells a spreadsheet would run as a formula', () => {
    const row = (name: string, note: string | null): RsvpView => ({ id: '1', blockId: 'b', name, attending: 'YES', guests: 1, phone: null, note, createdAt: new Date('2026-01-01T00:00:00Z') });
    const csv = buildRsvpsCsv([row('=HYPERLINK("http://x")', 'a, "b"\nc'), row('+84 Lan', null), row('-1', null), row('@sum', null), row('Bình', null)]);
    expect(csv).toContain('"\'=HYPERLINK(""http://x"")",Có,1,,"a, ""b""\nc",');
    expect(csv).toContain("'+84 Lan,");
    expect(csv).toContain("'-1,");
    expect(csv).toContain("'@sum,");
    expect(csv).toContain('\r\nBình,Có,1,,,');
  });

  it('writes the time in Vietnam time', () => {
    const csv = buildRsvpsCsv([{ id: '1', blockId: 'b', name: 'A', attending: 'NO', guests: null, phone: null, note: null, createdAt: new Date('2026-11-08T13:14:00Z') }]);
    expect(csv).toMatch(/20:14/); // 13:14 UTC là 20:14 giờ Việt Nam
  });
});

describe('deleting a card', () => {
  it('removes its answers and messages too', async () => {
    const { owner, card } = await seed();
    await fill(card.id);
    await prisma.guestbookEntry.create({ data: { cardId: card.id, blockId: 'gb1', name: 'A', message: 'm', status: 'VISIBLE', ipHash: 'x' } });
    await prisma.formResponse.create({ data: { cardId: card.id, blockId: 'f1', answers: [], ipHash: 'x' } });
    const res = await gql(owner.token, 'mutation($id: ID!) { deleteCard(id: $id) }', { id: card.id });
    expect(res.body.errors).toBeUndefined();
    expect(await prisma.rsvp.count()).toBe(0);
    expect(await prisma.guestbookEntry.count()).toBe(0);
    expect(await prisma.formResponse.count()).toBe(0);
  });
});
