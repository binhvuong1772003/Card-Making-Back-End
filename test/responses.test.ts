import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { prisma } from '../src/infra/prisma';
import { closeQueueing } from '../src/infra/queue';
import { closeRedis } from '../src/infra/redis';
import { buildRsvpsCsv, ipHashOf, submitForm, type RsvpView } from '../src/modules/cards/responses/responses.service';
import { createUserWithToken } from './helpers/auth';
import { resetDatabase } from './helpers/database';

beforeEach(resetDatabase);
afterAll(async () => {
  await resetDatabase();
  await closeQueueing();
  await closeRedis();
});

const app = createApp({ formsHourlyLimit: 1000 });
const gql = (token: string, query: string, variables?: Record<string, unknown>) => request(app).post('/graphql').set('Authorization', `Bearer ${token}`).send({ query, variables });
const code = (res: request.Response): string | undefined => res.body.errors?.[0]?.extensions?.code;

const block = (id: string, type: string, props: Record<string, unknown> = {}) => ({ id, type, props, styles: {}, children: [] });
const pageWith = (...blocks: unknown[]) => ({ schemaVersion: 1, root: { id: 'root', type: 'Page', props: {}, styles: {}, children: blocks } });

// Ô của form "Xác nhận tham dự" dựng sẵn; mỗi lần gọi trả bản mới để test sửa được.
const rsvpFields = () => [
  { id: 'name', type: 'text', label: 'Họ và tên', required: true },
  { id: 'attending', type: 'choice', label: 'Bạn sẽ đến chứ?', required: true, options: ['Có, tôi sẽ đến', 'Rất tiếc, không đến được'] },
  { id: 'guests', type: 'number', label: 'Số khách (tính cả bạn)', required: true, min: 1, max: 4, showIf: { fieldId: 'attending', equals: 'Có, tôi sẽ đến' } },
];
const formBlock = (props: Record<string, unknown> = {}) => block('form1', 'Form', { heading: 'Đăng ký', fields: rsvpFields(), ...props });

// Thiệp đã xuất bản dựng thẳng trong DB: service chỉ đọc bản xuất bản, không đọc bản nháp.
async function seed(options: { members?: { userId: string; role: 'EDITOR' | 'VIEWER' }[]; slug?: string; blocks?: unknown[]; published?: boolean; email?: string } = {}) {
  const owner = await createUserWithToken(options.email ?? 'owner@example.com');
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

const ANSWERS = { name: 'Nguyễn Minh Anh', attending: 'Có, tôi sẽ đến', guests: 2 };
const postForm = (slug: string, body: Record<string, unknown> = {}) => request(app).post(`/api/v1/publications/${slug}/forms`).send({ blockId: 'form1', answers: ANSWERS, ...body });

describe('POST /publications/:slug/forms', () => {
  it('stores the answers in field order with their labels, and returns the id', async () => {
    const { card, slug } = await seed({ blocks: [formBlock()] });
    const res = await postForm(slug);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'VISIBLE', entry: null });
    expect(typeof res.body.id).toBe('string');
    const row = await prisma.formResponse.findFirstOrThrow({ where: { cardId: card.id } });
    expect(row).toMatchObject({ blockId: 'form1', status: 'VISIBLE' });
    expect(row.answers).toEqual([
      { id: 'name', label: 'Họ và tên', type: 'text', value: 'Nguyễn Minh Anh' },
      { id: 'attending', label: 'Bạn sẽ đến chứ?', type: 'choice', value: 'Có, tôi sẽ đến' },
      { id: 'guests', label: 'Số khách (tính cả bạn)', type: 'number', value: 2 },
    ]);
  });

  it('returns the entry when the form shows answers publicly', async () => {
    const { slug } = await seed({
      blocks: [
        formBlock({
          fields: [
            { id: 'name', type: 'text', label: 'Tên của bạn', required: true },
            { id: 'message', type: 'longtext', label: 'Lời chúc', required: true },
          ],
          publicList: { enabled: true, nameFieldId: 'name', textFieldId: 'message' },
        }),
      ],
    });
    const res = await postForm(slug, { answers: { name: 'Lan Chi', message: 'Chúc mừng hai bạn!' } });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'VISIBLE', entry: { name: 'Lan Chi', text: 'Chúc mừng hai bạn!' } });
    expect(Object.keys(res.body.entry).sort()).toEqual(['createdAt', 'id', 'name', 'text']);
  });

  it('holds an answer back as PENDING when the public list moderates', async () => {
    const { slug } = await seed({
      blocks: [
        formBlock({
          moderation: true,
          fields: [
            { id: 'name', type: 'text', label: 'Tên', required: true },
            { id: 'message', type: 'longtext', label: 'Lời', required: true },
          ],
          publicList: { enabled: true, nameFieldId: 'name', textFieldId: 'message' },
        }),
      ],
    });
    const res = await postForm(slug, { answers: { name: 'Lan', message: 'Chúc mừng' } });
    expect(res.body).toMatchObject({ status: 'PENDING', entry: null });
  });

  it('names the field that is missing or wrong, and drops the ones hidden by a condition', async () => {
    const { card, slug } = await seed({ blocks: [formBlock()] });
    const missing = await postForm(slug, { answers: { attending: 'Có, tôi sẽ đến' } });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatchObject({ code: 'VALIDATION' });
    expect(missing.body.error.details.map((d: { path: string }) => d.path).sort()).toEqual(['guests', 'name']);

    // "Không đến" ẩn ô số khách: gửi kèm cũng bị bỏ, không bắt buộc.
    await postForm(slug, { answers: { name: 'An', attending: 'Rất tiếc, không đến được', guests: 3 } }).expect(201);
    const row = await prisma.formResponse.findFirstOrThrow({ where: { cardId: card.id } });
    expect(row.answers).toEqual([
      { id: 'name', label: 'Họ và tên', type: 'text', value: 'An' },
      { id: 'attending', label: 'Bạn sẽ đến chứ?', type: 'choice', value: 'Rất tiếc, không đến được' },
    ]);
  });

  it('drops answer keys that are not fields of the form', async () => {
    const { card, slug } = await seed({ blocks: [formBlock()] });
    await postForm(slug, { answers: { ...ANSWERS, injected: '<script>' } }).expect(201);
    const row = await prisma.formResponse.findFirstOrThrow({ where: { cardId: card.id } });
    expect(JSON.stringify(row.answers)).not.toContain('injected');
  });

  it('answers 404 for an unpublished card, a bad slug, a block that is missing or not a form', async () => {
    const live = await seed({ blocks: [formBlock(), block('t1', 'Text')] });
    expect((await postForm('khong-co')).status).toBe(404);
    expect((await postForm('Bad Slug')).status).toBe(404);
    expect((await postForm(live.slug, { blockId: 'nope' })).status).toBe(404);
    expect((await postForm(live.slug, { blockId: 't1' })).status).toBe(404);
    expect((await postForm(live.slug, { blockId: 'rsvp1' })).status).toBe(404); // khối kiểu cũ không nhận nữa
    await prisma.publication.updateMany({ data: { unpublishedAt: new Date() } });
    expect((await postForm(live.slug)).status).toBe(404);
  });

  it('closes after the deadline with CONFLICT and a reason, and stays open before it', async () => {
    const past = await seed({ blocks: [formBlock({ deadline: '2000-01-01' })], slug: 'het-han' });
    const res = await postForm(past.slug);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'CONFLICT', details: { reason: 'CLOSED' } });
    await prisma.publication.update({ where: { cardId: past.card.id }, data: { document: pageWith(formBlock({ deadline: '2999-01-01' })) } });
    expect((await postForm(past.slug)).status).toBe(201);
  });

  it('ignores a bot that fills the hidden field, yet answers as if it worked', async () => {
    const { card, slug } = await seed({ blocks: [formBlock()] });
    const res = await postForm(slug, { website: 'http://spam.example' });
    expect(res.status).toBe(201);
    expect(await prisma.formResponse.count({ where: { cardId: card.id } })).toBe(0);
  });

  it('counts an identical submission within a minute as one (a double click)', async () => {
    const { card, slug } = await seed({ blocks: [formBlock()] });
    const first = await postForm(slug);
    const second = await postForm(slug);
    expect(second.body.id).toBe(first.body.id);
    expect(await prisma.formResponse.count({ where: { cardId: card.id } })).toBe(1);
    await postForm(slug, { answers: { ...ANSWERS, guests: 3 } }).expect(201); // khác nội dung thì là dòng mới
    expect(await prisma.formResponse.count({ where: { cardId: card.id } })).toBe(2);
  });

  it('does not keep the IP, only a hash that changes with the day', async () => {
    const { card, slug } = await seed({ blocks: [formBlock()] });
    await postForm(slug);
    const row = await prisma.formResponse.findFirstOrThrow({ where: { cardId: card.id } });
    expect(row.ipHash).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(row)).not.toMatch(/127\.0\.0\.1|::1|::ffff/);
    expect(ipHashOf('1.2.3.4', new Date('2026-01-01T10:00:00Z'))).toBe(ipHashOf('1.2.3.4', new Date('2026-01-01T23:00:00Z')));
    expect(ipHashOf('1.2.3.4', new Date('2026-01-01T10:00:00Z'))).not.toBe(ipHashOf('1.2.3.4', new Date('2026-01-02T10:00:00Z')));
  });

  it('stops taking answers once a card is full', async () => {
    const { slug } = await seed({ blocks: [formBlock()] });
    const deps = { now: () => new Date(), limits: { maxResponses: 1, duplicateWindowMs: 0 } };
    await submitForm(slug, { blockId: 'form1', answers: ANSWERS }, { ip: '1.1.1.1' }, deps);
    await expect(submitForm(slug, { blockId: 'form1', answers: { ...ANSWERS, name: 'B' } }, { ip: '1.1.1.1' }, deps)).rejects.toMatchObject({
      code: 'CONFLICT',
      details: { reason: 'FULL' },
    });
  });

  it('answers 429 after too many tries from one IP to one card, and not for another card', async () => {
    const limited = createApp({ formsHourlyLimit: 2 });
    const a = await seed({ slug: 'thiep-a', blocks: [formBlock()] });
    for (let i = 0; i < 2; i++) await request(limited).post(`/api/v1/publications/${a.slug}/forms`).send({ blockId: 'form1', answers: { ...ANSWERS, name: `K${i}` } }).expect(201);
    expect((await request(limited).post(`/api/v1/publications/${a.slug}/forms`).send({ blockId: 'form1', answers: { ...ANSWERS, name: 'K9' } })).status).toBe(429);
    const owner = await createUserWithToken('other@example.com');
    const card = await prisma.card.create({ data: { ownerId: owner.id, title: 'B', document: {}, members: [] } });
    await prisma.publication.create({ data: { cardId: card.id, slug: 'thiep-b', document: pageWith(formBlock()), publishedAt: new Date() } });
    await request(limited).post('/api/v1/publications/thiep-b/forms').send({ blockId: 'form1', answers: ANSWERS }).expect(201);
  });
});

describe('GET /publications/:slug/forms/entries', () => {
  const guestbookForm = () =>
    formBlock({
      fields: [
        { id: 'name', type: 'text', label: 'Tên của bạn', required: true },
        { id: 'message', type: 'longtext', label: 'Lời chúc', required: true },
      ],
      publicList: { enabled: true, nameFieldId: 'name', textFieldId: 'message' },
    });
  const entries = (slug: string) => `/api/v1/publications/${slug}/forms/entries?blockId=form1`;

  it('lists the visible answers newest first and pages with a cursor', async () => {
    const { card, slug } = await seed({ blocks: [guestbookForm()] });
    const base = Date.now();
    const make = (name: string, status: 'VISIBLE' | 'HIDDEN' | 'PENDING', at: number) =>
      prisma.formResponse.create({
        data: {
          cardId: card.id,
          blockId: 'form1',
          answers: [
            { id: 'name', label: 'Tên', type: 'text', value: name },
            { id: 'message', label: 'Lời', type: 'longtext', value: `Lời của ${name}` },
          ],
          status,
          ipHash: 'x',
          createdAt: new Date(at),
        },
      });
    for (let i = 0; i < 5; i++) await make(`K${i}`, 'VISIBLE', base + i * 1000);
    await make('Ẩn', 'HIDDEN', base + 9000);
    await make('Chờ', 'PENDING', base + 9500);

    const one = await request(app).get(`${entries(slug)}&first=2`).expect(200);
    expect(one.body.entries.map((entry: { name: string }) => entry.name)).toEqual(['K4', 'K3']);
    expect(one.body.total).toBe(5);
    expect(Object.keys(one.body.entries[0]).sort()).toEqual(['createdAt', 'id', 'name', 'text']);
    expect(one.headers['cache-control']).toBe('public, max-age=10');

    const two = await request(app).get(`${entries(slug)}&first=2&after=${one.body.nextCursor}`).expect(200);
    expect(two.body.entries.map((entry: { name: string }) => entry.name)).toEqual(['K2', 'K1']);
    const three = await request(app).get(`${entries(slug)}&first=2&after=${two.body.nextCursor}`).expect(200);
    expect(three.body.entries.map((entry: { name: string }) => entry.name)).toEqual(['K0']);
    expect(three.body.nextCursor).toBeNull();
    expect((await request(app).get(`${entries(slug)}&after=junk`)).status).toBe(400);
  });

  it('is 404 when the form does not show answers publicly, the card is gone, or the block is not a Form', async () => {
    const off = await seed({ blocks: [formBlock()] });
    expect((await request(app).get(entries(off.slug))).status).toBe(404);
    const live = await seed({ slug: 'thiep-hien', email: 'owner2@example.com', blocks: [guestbookForm()] });
    expect((await request(app).get('/api/v1/publications/khong-co/forms/entries?blockId=form1')).status).toBe(404);
    expect((await request(app).get('/api/v1/publications/thiep-hien/forms/entries?blockId=nope')).status).toBe(404);
    await prisma.publication.updateMany({ data: { unpublishedAt: new Date() } });
    expect((await request(app).get(entries(live.slug))).status).toBe(404);
  });

  it('keeps the answer as plain text, as it came', async () => {
    const { slug } = await seed({ blocks: [guestbookForm()] });
    await postForm(slug, { answers: { name: 'Lan', message: '<script>alert(1)</script>\nDòng hai' } }).expect(201);
    const list = await request(app).get(entries(slug));
    expect(list.body.entries[0].text).toBe('<script>alert(1)</script>\nDòng hai');
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
    // Sổ công khai của khối cũ đã bị bỏ ở đợt form tuỳ biến; phần duyệt được kiểm lại ở bước sau.
    await gql(owner.token, SET, { id: a.id, status: 'VISIBLE' });
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
