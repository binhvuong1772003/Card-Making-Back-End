import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { prisma } from '../src/infra/prisma';
import { closeQueueing } from '../src/infra/queue';
import { closeRedis } from '../src/infra/redis';
import { createUserWithToken } from './helpers/auth';
import { resetDatabase } from './helpers/database';

const app = createApp();
const gql = (token: string, query: string, variables?: Record<string, unknown>) =>
  request(app).post('/graphql').set('Authorization', `Bearer ${token}`).send({ query, variables });
const code = (res: request.Response): string | undefined => res.body.errors?.[0]?.extensions?.code;

const CREATE = 'mutation($input: CreateCardInput!) { createCard(input: $input) { id title occasion published } }';
const LIST = 'query($occasion: CardOccasion, $search: String) { cards(occasion: $occasion, search: $search) { nodes { id title occasion published } } }';
const DUPLICATE = 'mutation($id: ID!) { duplicateCard(id: $id) { id title occasion revision role ownerId } }';
const GET = 'query($id: ID!) { card(id: $id) { document } }';

beforeEach(resetDatabase);
afterAll(async () => {
  await resetDatabase();
  await closeQueueing();
  await closeRedis();
  await prisma.$disconnect();
});

const seed = (ownerId: string, title: string, occasion?: 'WEDDING' | 'BIRTHDAY' | 'EVENT' | 'OTHER') =>
  prisma.card.create({ data: { ownerId, title, document: {}, revision: 0, members: [], ...(occasion ? { occasion } : {}) } });

describe('card occasion', () => {
  it('defaults to OTHER and stores the occasion given at creation', async () => {
    const user = await createUserWithToken('a@example.com');
    const plain = await gql(user.token, CREATE, { input: { title: 'Plain' } });
    expect(plain.body.data.createCard.occasion).toBe('OTHER');
    const wedding = await gql(user.token, CREATE, { input: { title: 'Wedding', occasion: 'WEDDING' } });
    expect(wedding.body.data.createCard.occasion).toBe('WEDDING');
    expect(wedding.body.data.createCard.published).toBe(false);
  });

  it('reads a card stored before the field existed as OTHER', async () => {
    const user = await createUserWithToken('a@example.com');
    await seed(user.id, 'Old'); // no occasion written
    const res = await gql(user.token, LIST);
    expect(res.body.data.cards.nodes[0].occasion).toBe('OTHER');
  });
});

describe('cards list filters', () => {
  it('filters by occasion', async () => {
    const user = await createUserWithToken('a@example.com');
    await seed(user.id, 'A', 'WEDDING');
    await seed(user.id, 'B', 'BIRTHDAY');
    await seed(user.id, 'C'); // unset counts as OTHER
    const wedding = await gql(user.token, LIST, { occasion: 'WEDDING' });
    expect(wedding.body.data.cards.nodes.map((c: { title: string }) => c.title)).toEqual(['A']);
    const other = await gql(user.token, LIST, { occasion: 'OTHER' });
    expect(other.body.data.cards.nodes.map((c: { title: string }) => c.title)).toEqual(['C']);
  });

  it('searches titles without caring about case and only among the caller cards', async () => {
    const user = await createUserWithToken('a@example.com');
    const other = await createUserWithToken('b@example.com');
    await seed(user.id, 'Lễ cưới Minh');
    await seed(user.id, 'Sinh nhật Su');
    await seed(other.id, 'Lễ cưới của người khác');
    const res = await gql(user.token, LIST, { search: 'CƯỚI' });
    expect(res.body.data.cards.nodes.map((c: { title: string }) => c.title)).toEqual(['Lễ cưới Minh']);
  });

  it('marks a card published only while its publication is live', async () => {
    const user = await createUserWithToken('a@example.com');
    const live = await seed(user.id, 'Live');
    const gone = await seed(user.id, 'Gone');
    await seed(user.id, 'Draft');
    await prisma.publication.create({ data: { cardId: live.id, slug: 'live', document: {}, publishedAt: new Date() } });
    await prisma.publication.create({ data: { cardId: gone.id, slug: 'gone', document: {}, publishedAt: new Date(), unpublishedAt: new Date() } });
    const res = await gql(user.token, LIST);
    const byTitle = Object.fromEntries(res.body.data.cards.nodes.map((c: { title: string; published: boolean }) => [c.title, c.published]));
    expect(byTitle).toEqual({ Live: true, Gone: false, Draft: false });
  });
});

describe('duplicateCard', () => {
  it('copies the document and occasion into a new card owned by the caller', async () => {
    const user = await createUserWithToken('a@example.com');
    const page = { schemaVersion: 1, root: { id: 'root', type: 'Page', children: [] } };
    const card = await prisma.card.create({ data: { ownerId: user.id, title: 'Gốc', document: page, revision: 7, members: [], occasion: 'WEDDING' } });

    const res = await gql(user.token, DUPLICATE, { id: card.id });
    expect(res.body.errors).toBeUndefined();
    const copy = res.body.data.duplicateCard;
    expect(copy.id).not.toBe(card.id);
    expect(copy.title).toBe('Gốc (bản sao)');
    expect(copy.occasion).toBe('WEDDING');
    expect(copy.revision).toBe(0);
    expect(copy.role).toBe('OWNER');
    expect(copy.ownerId).toBe(user.id);
    const doc = await gql(user.token, GET, { id: copy.id });
    expect(doc.body.data.card.document).toEqual(page);
  });

  it('keeps the copy title within 100 characters', async () => {
    const user = await createUserWithToken('a@example.com');
    const card = await seed(user.id, 'x'.repeat(100));
    const res = await gql(user.token, DUPLICATE, { id: card.id });
    expect(res.body.data.duplicateCard.title.length).toBeLessThanOrEqual(100);
    expect(res.body.data.duplicateCard.title.endsWith('(bản sao)')).toBe(true);
  });

  it('lets a viewer copy into their own library but not a stranger', async () => {
    const owner = await createUserWithToken('o@example.com');
    const viewer = await createUserWithToken('v@example.com');
    const stranger = await createUserWithToken('s@example.com');
    const card = await prisma.card.create({
      data: { ownerId: owner.id, title: 'T', document: { a: 1 }, revision: 0, members: [{ userId: viewer.id, role: 'VIEWER', addedAt: new Date() }] },
    });
    const ok = await gql(viewer.token, DUPLICATE, { id: card.id });
    expect(ok.body.data.duplicateCard.ownerId).toBe(viewer.id);
    expect(code(await gql(stranger.token, DUPLICATE, { id: card.id }))).toBe('NOT_FOUND');
  });
});
