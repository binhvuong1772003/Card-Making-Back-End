import request from 'supertest';
import { Prisma } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { prisma } from '../src/infra/prisma';
import { closeQueueing } from '../src/infra/queue';
import { closeRedis } from '../src/infra/redis';
import { ipHashOf, submitForm } from '../src/modules/cards/responses/responses.service';
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

const CARD_FORMS = 'query($cardId: ID!) { cardForms(cardId: $cardId) { blockId heading fields { id label type options } publicList moderation removed total pending } }';
const FORM_RESPONSES =
  'query($cardId: ID!, $blockId: String, $status: EntryStatus, $search: String, $first: Int, $after: String) { formResponses(cardId: $cardId, blockId: $blockId, status: $status, search: $search, first: $first, after: $after) { nodes { id blockId status answers { id label type value } } pageInfo { hasNextPage endCursor } summary { fieldId label type answered counts { option count } total } counts { visible hidden pending } } }';

const answerOf = (name: string, attending: string, guests?: number) => [
  { id: 'name', label: 'Họ và tên', type: 'text', value: name },
  { id: 'attending', label: 'Bạn sẽ đến chứ?', type: 'choice', value: attending },
  ...(guests === undefined ? [] : [{ id: 'guests', label: 'Số khách (tính cả bạn)', type: 'number', value: guests }]),
];

async function fillForms(cardId: string, blockId = 'form1') {
  const base = Date.now();
  const rows: [string, string, number | undefined, 'VISIBLE' | 'HIDDEN' | 'PENDING'][] = [
    ['An', 'Có, tôi sẽ đến', 2, 'VISIBLE'],
    ['Bình', 'Có, tôi sẽ đến', 3, 'VISIBLE'],
    ['Chi', 'Rất tiếc, không đến được', undefined, 'HIDDEN'],
    ['Dũng', 'Có, tôi sẽ đến', 1, 'PENDING'],
  ];
  for (const [i, [name, attending, guests, status]] of rows.entries()) {
    await prisma.formResponse.create({
      data: { cardId, blockId, answers: answerOf(name, attending, guests) as unknown as Prisma.InputJsonValue, status, ipHash: 'x', createdAt: new Date(base + i * 1000) },
    });
  }
}

describe('what the owner sees', () => {
  it('needs a login, and shows nobody else’s card', async () => {
    const { card } = await seed({ blocks: [formBlock()] });
    const anon = await request(app).post('/graphql').send({ query: CARD_FORMS, variables: { cardId: card.id } });
    expect(code(anon)).toBe('UNAUTHENTICATED');
    const stranger = await createUserWithToken('stranger@example.com');
    expect(code(await gql(stranger.token, CARD_FORMS, { cardId: card.id }))).toBe('NOT_FOUND');
    expect(code(await gql(stranger.token, CARD_FORMS, { cardId: 'not-an-id' }))).toBe('NOT_FOUND');
    expect(code(await gql(stranger.token, FORM_RESPONSES, { cardId: card.id }))).toBe('NOT_FOUND');
  });

  it('lets the owner and an editor in, and keeps a viewer out', async () => {
    const editor = await createUserWithToken('editor@example.com');
    const viewer = await createUserWithToken('viewer@example.com');
    const { owner, card } = await seed({ members: [{ userId: editor.id, role: 'EDITOR' }, { userId: viewer.id, role: 'VIEWER' }], blocks: [formBlock()] });
    expect((await gql(owner.token, CARD_FORMS, { cardId: card.id })).body.errors).toBeUndefined();
    expect((await gql(editor.token, CARD_FORMS, { cardId: card.id })).body.errors).toBeUndefined();
    expect(code(await gql(viewer.token, CARD_FORMS, { cardId: card.id }))).toBe('FORBIDDEN');
    expect(code(await gql(viewer.token, FORM_RESPONSES, { cardId: card.id }))).toBe('FORBIDDEN');
  });

  it('lists the forms of the published card with their questions, counts and removed blocks', async () => {
    const { owner, card } = await seed({
      blocks: [formBlock({ heading: 'Đăng ký', publicList: { enabled: true, nameFieldId: 'name', textFieldId: 'guests' } }), block('t1', 'Text')],
    });
    await fillForms(card.id);
    // Một khối form không còn trong bản xuất bản nhưng đã có câu trả lời.
    await prisma.formResponse.create({ data: { cardId: card.id, blockId: 'old1', answers: [], status: 'VISIBLE', ipHash: 'x' } });

    const forms = (await gql(owner.token, CARD_FORMS, { cardId: card.id })).body.data.cardForms;
    expect(forms).toHaveLength(2);
    expect(forms[0]).toMatchObject({ blockId: 'form1', heading: 'Đăng ký', publicList: true, moderation: false, removed: false, total: 4, pending: 1 });
    expect(forms[0].fields).toEqual([
      { id: 'name', label: 'Họ và tên', type: 'text', options: [] },
      { id: 'attending', label: 'Bạn sẽ đến chứ?', type: 'choice', options: ['Có, tôi sẽ đến', 'Rất tiếc, không đến được'] },
      { id: 'guests', label: 'Số khách (tính cả bạn)', type: 'number', options: [] },
    ]);
    expect(forms[1]).toMatchObject({ blockId: 'old1', removed: true, total: 1 });
    // Bản nháp chưa xuất bản không có khối form nào: chỉ còn khối có câu trả lời.
    await prisma.publication.deleteMany({ where: { cardId: card.id } });
    const unpublished = (await gql(owner.token, CARD_FORMS, { cardId: card.id })).body.data.cardForms;
    expect(unpublished.map((form: { blockId: string }) => form.blockId)).toEqual(['form1', 'old1']);
    expect(unpublished[0]).toMatchObject({ removed: true, total: 4 });
  });

  it('lists answers newest first with their stored labels and the status counts', async () => {
    const { owner, card } = await seed({ blocks: [formBlock()] });
    await fillForms(card.id);
    const data = (await gql(owner.token, FORM_RESPONSES, { cardId: card.id, blockId: 'form1' })).body.data.formResponses;
    expect(data.nodes.map((node: { answers: { value: string }[] }) => node.answers[0].value)).toEqual(['Dũng', 'Chi', 'Bình', 'An']);
    expect(data.nodes[1]).toMatchObject({ blockId: 'form1', status: 'HIDDEN' });
    expect(data.counts).toEqual({ visible: 2, hidden: 1, pending: 1 });
    expect(data.summary).toEqual([
      { fieldId: 'name', label: 'Họ và tên', type: 'text', answered: 4, counts: [], total: null },
      {
        fieldId: 'attending',
        label: 'Bạn sẽ đến chứ?',
        type: 'choice',
        answered: 4,
        counts: [
          { option: 'Có, tôi sẽ đến', count: 3 },
          { option: 'Rất tiếc, không đến được', count: 1 },
        ],
        total: null,
      },
      { fieldId: 'guests', label: 'Số khách (tính cả bạn)', type: 'number', answered: 3, counts: [], total: 6 },
    ]);
  });

  it('filters by status and by the text of an answer without changing the counts', async () => {
    const { owner, card } = await seed({ blocks: [formBlock()] });
    await fillForms(card.id);
    const hidden = (await gql(owner.token, FORM_RESPONSES, { cardId: card.id, blockId: 'form1', status: 'HIDDEN' })).body.data.formResponses;
    expect(hidden.nodes).toHaveLength(1);
    expect(hidden.counts.pending).toBe(1);
    const found = (await gql(owner.token, FORM_RESPONSES, { cardId: card.id, blockId: 'form1', search: 'bình' })).body.data.formResponses;
    expect(found.nodes.map((node: { answers: { value: string }[] }) => node.answers[0].value)).toEqual(['Bình']);
    const special = await gql(owner.token, FORM_RESPONSES, { cardId: card.id, blockId: 'form1', search: '[(.*' });
    expect(special.body.errors).toBeUndefined(); // ký tự đặc biệt trong ô tìm không làm hỏng truy vấn
    expect(special.body.data.formResponses.nodes).toEqual([]);
    const first = (await gql(owner.token, FORM_RESPONSES, { cardId: card.id, blockId: 'form1', first: 3 })).body.data.formResponses;
    expect(first.pageInfo.hasNextPage).toBe(true);
    const next = (await gql(owner.token, FORM_RESPONSES, { cardId: card.id, blockId: 'form1', first: 3, after: first.pageInfo.endCursor })).body.data.formResponses;
    expect(next.nodes).toHaveLength(1);
    expect(next.pageInfo.hasNextPage).toBe(false);
    expect(code(await gql(owner.token, FORM_RESPONSES, { cardId: card.id, blockId: 'form1', first: 101 }))).toBe('VALIDATION');
  });

  it('deletes an answer, but not one of somebody else’s card', async () => {
    const mine = await seed({ blocks: [formBlock()] });
    await fillForms(mine.card.id);
    const target = await prisma.formResponse.findFirstOrThrow({ where: { cardId: mine.card.id } });
    const stranger = await createUserWithToken('stranger@example.com');
    expect(code(await gql(stranger.token, 'mutation($id: ID!) { deleteFormResponse(id: $id) }', { id: target.id }))).toBe('NOT_FOUND');
    expect(code(await gql(mine.owner.token, 'mutation($id: ID!) { deleteFormResponse(id: $id) }', { id: 'xyz' }))).toBe('NOT_FOUND');
    const ok = await gql(mine.owner.token, 'mutation($id: ID!) { deleteFormResponse(id: $id) }', { id: target.id });
    expect(ok.body.data.deleteFormResponse).toBe(true);
    expect(await prisma.formResponse.count({ where: { cardId: mine.card.id } })).toBe(3);
  });

  it('hides, shows and approves an answer', async () => {
    const { owner, card } = await seed({ blocks: [formBlock()] });
    await fillForms(card.id);
    const row = await prisma.formResponse.findFirstOrThrow({ where: { cardId: card.id, status: 'PENDING' } });
    const SET = 'mutation($id: ID!, $status: EntryStatus!) { setFormResponseStatus(id: $id, status: $status) { id status } }';
    expect((await gql(owner.token, SET, { id: row.id, status: 'VISIBLE' })).body.data.setFormResponseStatus.status).toBe('VISIBLE');
    expect(code(await gql(owner.token, SET, { id: row.id, status: 'NOPE' }))).toBeDefined();
    const stranger = await createUserWithToken('stranger@example.com');
    expect(code(await gql(stranger.token, SET, { id: row.id, status: 'HIDDEN' }))).toBe('NOT_FOUND');
  });
});

describe('CSV', () => {
  it('is only for a signed-in person who can see the answers', async () => {
    const { card } = await seed({ blocks: [formBlock()] });
    expect((await request(app).get(`/api/v1/cards/${card.id}/forms/form1/responses.csv`)).status).toBe(401);
    const stranger = await createUserWithToken('stranger@example.com');
    expect((await request(app).get(`/api/v1/cards/${card.id}/forms/form1/responses.csv`).set('Authorization', `Bearer ${stranger.token}`)).status).toBe(404);
    expect((await request(app).get('/api/v1/cards/not-an-id/forms/form1/responses.csv').set('Authorization', `Bearer ${stranger.token}`)).status).toBe(404);
  });

  it('downloads a UTF-8 file with a BOM, one column per question plus the removed ones, oldest first, and no caching', async () => {
    const { owner, card } = await seed({
      blocks: [
        formBlock({
          heading: 'Đăng ký / Khách mời',
          fields: [
            { id: 'name', type: 'text', label: 'Họ và tên', required: true },
            { id: 'pick', type: 'multichoice', label: 'Buổi tham dự', options: ['Tiệc cưới', 'Lễ gia tiên'] },
            { id: 'adult', type: 'yesno', label: 'Người lớn' },
          ],
        }),
      ],
    });
    const base = Date.parse('2026-01-01T09:00:00Z');
    const make = (name: string, at: number, extra: Record<string, unknown> = {}) =>
      prisma.formResponse.create({
        data: {
          cardId: card.id,
          blockId: 'form1',
          answers: [
            { id: 'name', label: 'Họ và tên', type: 'text', value: name },
            { id: 'pick', label: 'Buổi tham dự', type: 'multichoice', value: ['Tiệc cưới', 'Lễ gia tiên'] },
            { id: 'adult', label: 'Người lớn', type: 'yesno', value: true },
            ...Object.entries(extra).map(([id, value]) => ({ id, label: 'Ô đã gỡ', type: 'text', value })),
          ] as unknown as Prisma.InputJsonValue,
          status: 'VISIBLE',
          ipHash: 'x',
          createdAt: new Date(at),
        },
      });
    await make('An', base);
    await make('=HYPERLINK("http://x")', base + 1000, { old: 'giữ lại' });

    const res = await request(app).get(`/api/v1/cards/${card.id}/forms/form1/responses.csv`).set('Authorization', `Bearer ${owner.token}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['cache-control']).toBe('no-store');
    const text = res.text;
    expect(text.charCodeAt(0)).toBe(0xfeff);
    const lines = text.slice(1).trimEnd().split('\r\n');
    expect(lines[0]).toBe('Gửi lúc,Họ và tên,Buổi tham dự,Người lớn,Ô đã gỡ');
    expect(lines[1]).toMatch(/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2},An,Tiệc cưới; Lễ gia tiên,Có,$/);
    expect(lines[2]).toContain('"\'=HYPERLINK(""http://x"")"');
    expect(lines[2]).toContain(',giữ lại');
  });

  it('builds a file even when the block is gone from the published card', async () => {
    const { owner, card } = await seed({ blocks: [block('t1', 'Text')] });
    await prisma.formResponse.create({
      data: { cardId: card.id, blockId: 'gone1', answers: [{ id: 'q', label: 'Câu hỏi cũ', type: 'text', value: 'A' }] as unknown as Prisma.InputJsonValue, status: 'VISIBLE', ipHash: 'x' },
    });
    const res = await request(app).get(`/api/v1/cards/${card.id}/forms/gone1/responses.csv`).set('Authorization', `Bearer ${owner.token}`);
    expect(res.status).toBe(200);
    expect(res.text.slice(1).split('\r\n')[0]).toBe('Gửi lúc,Câu hỏi cũ');
  });
});

describe('deleting a card', () => {
  it('removes its answers too', async () => {
    const { owner, card } = await seed({ blocks: [formBlock()] });
    await fillForms(card.id);
    const res = await gql(owner.token, 'mutation($id: ID!) { deleteCard(id: $id) }', { id: card.id });
    expect(res.body.errors).toBeUndefined();
    expect(await prisma.formResponse.count()).toBe(0);
  });
});
