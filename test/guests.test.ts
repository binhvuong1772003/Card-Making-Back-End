import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { prisma } from '../src/infra/prisma';
import { closeQueueing } from '../src/infra/queue';
import { closeRedis } from '../src/infra/redis';
import { CODE_ALPHABET } from '../src/modules/cards/guests/guests.schema';
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
const errorCode = (res: request.Response): string | undefined => res.body.errors?.[0]?.extensions?.code;

const block = (id: string, type: string, props: Record<string, unknown> = {}) => ({ id, type, props, styles: {}, children: [] });
const pageWith = (...blocks: unknown[]) => ({ schemaVersion: 1, root: { id: 'root', type: 'Page', props: {}, styles: {}, children: blocks } });

async function seedCard(options: { email?: string; slug?: string; members?: { userId: string; role: 'EDITOR' | 'VIEWER' }[] } = {}) {
  const owner = await createUserWithToken(options.email ?? 'owner@example.com');
  const card = await prisma.card.create({ data: { ownerId: owner.id, title: 'Thiệp', document: {}, members: (options.members ?? []).map((m) => ({ ...m, addedAt: new Date() })) } });
  const slug = options.slug ?? 'thiep-khach';
  await prisma.publication.create({
    data: { cardId: card.id, slug, document: pageWith(block('form1', 'Form', { heading: 'Lời chúc', fields: [{ id: 'name', type: 'text', label: 'Tên', required: true }] })), publishedAt: new Date() },
  });
  return { owner, card, slug };
}

const ADD = `mutation($cardId: ID!, $entries: [GuestInput!]!) { addGuests(cardId: $cardId, entries: $entries) { id name code greeting inviteMessage openCount responded } }`;
const LIST = `query($cardId: ID!, $search: String) { cardGuests(cardId: $cardId, search: $search) { id name code responded openCount } }`;

describe('guest management (GraphQL)', () => {
  it('adds guests with distinct codes made of the safe alphabet and lists them oldest first', async () => {
    const { owner, card } = await seedCard();
    const added = await gql(owner.token, ADD, { cardId: card.id, entries: [{ name: ' Anh Nam ', greeting: 'Rất mong anh chị đến' }, { name: 'Chị Lan' }] });
    expect(added.body.errors).toBeUndefined();
    const guests = added.body.data.addGuests as { name: string; code: string; greeting: string | null }[];
    expect(guests.map((g) => g.name)).toEqual(['Anh Nam', 'Chị Lan']);
    expect(guests[0]!.greeting).toBe('Rất mong anh chị đến');
    expect(guests[1]!.greeting).toBeNull();
    for (const guest of guests) expect(guest.code).toMatch(new RegExp(`^[${CODE_ALPHABET}]{8}$`));
    expect(new Set(guests.map((g) => g.code)).size).toBe(2);
    const listed = await gql(owner.token, LIST, { cardId: card.id });
    expect(listed.body.data.cardGuests.map((g: { name: string }) => g.name)).toEqual(['Anh Nam', 'Chị Lan']);
    const filtered = await gql(owner.token, LIST, { cardId: card.id, search: 'lan' });
    expect(filtered.body.data.cardGuests.map((g: { name: string }) => g.name)).toEqual(['Chị Lan']);
  });

  it('rejects empty names, too many per request and too many per card', async () => {
    const { owner, card } = await seedCard();
    expect(errorCode(await gql(owner.token, ADD, { cardId: card.id, entries: [{ name: '   ' }] }))).toBeDefined();
    const many = Array.from({ length: 201 }, (_, i) => ({ name: `Khách ${i}` }));
    expect(errorCode(await gql(owner.token, ADD, { cardId: card.id, entries: many }))).toBeDefined();
    await prisma.guest.createMany({ data: Array.from({ length: 499 }, (_, i) => ({ cardId: card.id, code: `TEST${String(i).padStart(4, '0')}`, name: `K${i}` })) });
    expect((await gql(owner.token, ADD, { cardId: card.id, entries: [{ name: 'Vừa đủ' }] })).body.errors).toBeUndefined();
    const full = await gql(owner.token, ADD, { cardId: card.id, entries: [{ name: 'Quá' }] });
    expect(errorCode(full)).toBe('CONFLICT');
  });

  it('lets editors manage guests but not viewers or strangers', async () => {
    const editor = await createUserWithToken('editor@example.com');
    const viewer = await createUserWithToken('viewer@example.com');
    const stranger = await createUserWithToken('stranger@example.com');
    const { owner, card } = await seedCard({ members: [{ userId: editor.id, role: 'EDITOR' }, { userId: viewer.id, role: 'VIEWER' }] });
    expect((await gql(editor.token, ADD, { cardId: card.id, entries: [{ name: 'Do biên tập viên' }] })).body.errors).toBeUndefined();
    expect(errorCode(await gql(viewer.token, LIST, { cardId: card.id }))).toBe('FORBIDDEN');
    expect(errorCode(await gql(stranger.token, LIST, { cardId: card.id }))).toBe('NOT_FOUND');
    expect(owner.id).toBeDefined();
  });

  it('updates and deletes a guest; an empty greeting clears it', async () => {
    const { owner, card } = await seedCard();
    const [guest] = (await gql(owner.token, ADD, { cardId: card.id, entries: [{ name: 'Anh Nam', greeting: 'Chào anh' }] })).body.data.addGuests;
    const updated = await gql(owner.token, `mutation($id: ID!) { updateGuest(id: $id, name: "Anh Nam Bắc", greeting: "") { name greeting } }`, { id: guest.id });
    expect(updated.body.data.updateGuest).toEqual({ name: 'Anh Nam Bắc', greeting: null });
    expect((await gql(owner.token, `mutation($id: ID!) { deleteGuest(id: $id) }`, { id: guest.id })).body.data.deleteGuest).toBe(true);
    expect((await gql(owner.token, LIST, { cardId: card.id })).body.data.cardGuests).toEqual([]);
  });
});

describe('guest link (public REST)', () => {
  it('returns only that guest and counts opens', async () => {
    const { owner, card, slug } = await seedCard();
    const [guest] = (await gql(owner.token, ADD, { cardId: card.id, entries: [{ name: 'Anh Nam', greeting: 'Chào anh', inviteMessage: 'Mời anh dự tiệc' }] })).body.data.addGuests;
    const res = await request(app).get(`/api/v1/publications/${slug}/guest/${guest.code}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ name: 'Anh Nam', greeting: 'Chào anh', inviteMessage: 'Mời anh dự tiệc' });
    expect(res.headers['cache-control']).toBe('no-store');
    expect((await request(app).get(`/api/v1/publications/${slug}/guest/${guest.code.toLowerCase()}`)).status).toBe(200);
    expect((await request(app).post(`/api/v1/publications/${slug}/guest/${guest.code}/open`)).status).toBe(204);
    expect((await request(app).post(`/api/v1/publications/${slug}/guest/${guest.code}/open`)).status).toBe(204);
    const row = await prisma.guest.findUniqueOrThrow({ where: { id: guest.id } });
    expect(row.openCount).toBe(2);
    expect(row.firstOpenedAt).not.toBeNull();
    expect(row.lastOpenedAt).not.toBeNull();
  });

  it('answers wrong codes, other cards codes and unpublished pages the same way', async () => {
    const { owner, card, slug } = await seedCard();
    const other = await seedCard({ email: 'other@example.com', slug: 'thiep-khac' });
    const [guest] = (await gql(owner.token, ADD, { cardId: card.id, entries: [{ name: 'Anh Nam' }] })).body.data.addGuests;
    expect((await request(app).get(`/api/v1/publications/${slug}/guest/ZZZZZZZZ`)).status).toBe(404);
    expect((await request(app).get(`/api/v1/publications/${slug}/guest/bad`)).status).toBe(404);
    expect((await request(app).get(`/api/v1/publications/${other.slug}/guest/${guest.code}`)).status).toBe(404);
    expect((await request(app).post(`/api/v1/publications/${other.slug}/guest/${guest.code}/open`)).status).toBe(404);
    await prisma.publication.updateMany({ where: { slug }, data: { unpublishedAt: new Date() } });
    expect((await request(app).get(`/api/v1/publications/${slug}/guest/${guest.code}`)).status).toBe(404);
  });
});

describe('form answers from a guest link', () => {
  it('ties the answer to the guest and marks them as responded; a wrong code only skips the tie', async () => {
    const { owner, card, slug } = await seedCard();
    const [guest] = (await gql(owner.token, ADD, { cardId: card.id, entries: [{ name: 'Anh Nam' }] })).body.data.addGuests;
    const post = (body: Record<string, unknown>) => request(app).post(`/api/v1/publications/${slug}/forms`).send({ blockId: 'form1', ...body });
    expect((await post({ answers: { name: 'Khách vãng lai' }, guestCode: 'ZZZZZZZZ' })).status).toBe(201);
    expect((await gql(owner.token, LIST, { cardId: card.id })).body.data.cardGuests[0].responded).toBe(false);
    expect((await post({ answers: { name: 'Anh Nam' }, guestCode: guest.code })).status).toBe(201);
    expect((await gql(owner.token, LIST, { cardId: card.id })).body.data.cardGuests[0].responded).toBe(true);
    const rows = await prisma.formResponse.findMany({ where: { cardId: card.id }, orderBy: { createdAt: 'asc' } });
    expect(rows.map((r) => r.guestId)).toEqual([null, guest.id]);
  });

  it('keeps the answers when the guest is deleted', async () => {
    const { owner, card, slug } = await seedCard();
    const [guest] = (await gql(owner.token, ADD, { cardId: card.id, entries: [{ name: 'Anh Nam' }] })).body.data.addGuests;
    await request(app).post(`/api/v1/publications/${slug}/forms`).send({ blockId: 'form1', answers: { name: 'Anh Nam' }, guestCode: guest.code });
    await gql(owner.token, `mutation($id: ID!) { deleteGuest(id: $id) }`, { id: guest.id });
    expect(await prisma.formResponse.count({ where: { cardId: card.id } })).toBe(1);
  });
});
