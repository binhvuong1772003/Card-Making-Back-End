import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { prisma } from '../src/infra/prisma';
import { closeQueueing } from '../src/infra/queue';
import { closeRedis } from '../src/infra/redis';
import { createUserWithToken } from './helpers/auth';

const app = createApp();

const CREATE = `mutation($input: CreateCardInput!) {
  createCard(input: $input) { id title revision role ownerId createdAt updatedAt }
}`;
const createCard = (token: string | undefined, title: unknown) => {
  const req = request(app).post('/graphql');
  if (token) req.set('Authorization', `Bearer ${token}`);
  return req.send({ query: CREATE, variables: { input: { title } } });
};
const errorCode = (res: request.Response): string | undefined => res.body.errors?.[0]?.extensions?.code;

// Xóa theo thứ tự phụ thuộc: user.deleteMany() bị chặn (Restrict) nếu còn bản ghi nào trỏ tới nó, kể cả do file test khác để lại.
async function resetDatabase() {
  await prisma.session.deleteMany();
  await prisma.identity.deleteMany();
  await prisma.verificationToken.deleteMany();
  await prisma.publication.deleteMany();
  await prisma.cardInvite.deleteMany();
  await prisma.card.deleteMany();
  await prisma.user.deleteMany();
}

beforeEach(resetDatabase);

// Mọi file test dùng chung một database: dọn sạch để beforeEach của file khác (xóa User) không bị Card chặn.
afterAll(async () => {
  await resetDatabase();
  await closeQueueing();
  await closeRedis();
  await prisma.$disconnect();
});

describe('createCard', () => {
  it('creates a card owned by the caller with the initial values', async () => {
    const owner = await createUserWithToken('owner@example.com');
    const res = await createCard(owner.token, '  Thiệp cưới An & Bình  ');

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.createCard).toMatchObject({
      title: 'Thiệp cưới An & Bình', // đã cắt khoảng trắng
      revision: 0,
      role: 'OWNER',
      ownerId: owner.id,
    });
    const { id, createdAt, updatedAt } = res.body.data.createCard;
    expect(id).toMatch(/^[0-9a-f]{24}$/);
    expect(new Date(createdAt).toISOString()).toBe(createdAt);
    expect(new Date(updatedAt).toISOString()).toBe(updatedAt);
  });

  it('stores an explicit empty members array and a placeholder document', async () => {
    const owner = await createUserWithToken('owner@example.com');
    const { id } = (await createCard(owner.token, 'Thiệp')).body.data.createCard;

    // Đọc thẳng collection: Prisma che đi việc trường members vắng hẳn, còn các bộ lọc none/isEmpty thì phân biệt được.
    const raw = (await prisma.$runCommandRaw({ find: 'Card', filter: { _id: { $oid: id } } })) as {
      cursor: { firstBatch: Record<string, unknown>[] };
    };
    const row = raw.cursor.firstBatch[0];
    expect(row.members).toEqual([]);
    expect(row.document).toEqual({});
    expect(row.revision).toBe(0);
    expect(row).not.toHaveProperty('sourceTemplateId');

    // Và nhờ đó bộ lọc dùng để thêm thành viên có điều kiện khớp được thiệp mới.
    expect(await prisma.card.count({ where: { id, members: { none: { userId: owner.id } } } })).toBe(1);
  });

  it('accepts a title of exactly 100 characters', async () => {
    const owner = await createUserWithToken('owner@example.com');
    const res = await createCard(owner.token, 'a'.repeat(100));
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.createCard.title).toHaveLength(100);
  });

  it.each([
    ['empty', ''],
    ['only whitespace', '   \t  '],
    ['101 characters', 'a'.repeat(101)],
  ])('rejects a title that is %s and creates nothing', async (_name, title) => {
    const owner = await createUserWithToken('owner@example.com');
    const res = await createCard(owner.token, title);
    expect(errorCode(res)).toBe('VALIDATION');
    expect(res.body.errors[0].extensions.details[0].path).toBe('title');
    expect(await prisma.card.count()).toBe(0);
  });

  it('rejects a request that is not signed in', async () => {
    const res = await createCard(undefined, 'Thiệp');
    expect(errorCode(res)).toBe('UNAUTHENTICATED');
    expect(await prisma.card.count()).toBe(0);
  });

  it('rejects an unknown input field and a missing or non-string title at the GraphQL layer', async () => {
    const owner = await createUserWithToken('owner@example.com');
    const send = (query: string, variables?: unknown) =>
      request(app).post('/graphql').set('Authorization', `Bearer ${owner.token}`).send({ query, variables });

    const extra = await send('mutation { createCard(input: { title: "a", ownerId: "someone-else" }) { id } }');
    expect(extra.status).toBe(400); // client không thể tự chọn chủ sở hữu
    expect((await send('mutation($i: CreateCardInput!) { createCard(input: $i) { id } }', { i: {} })).status).toBe(400);
    expect((await createCard(owner.token, 123)).status).toBe(400);
    expect(await prisma.card.count()).toBe(0);
  });

  it('keeps every user their own cards', async () => {
    const ann = await createUserWithToken('ann@example.com');
    const bob = await createUserWithToken('bob@example.com');
    const a = (await createCard(ann.token, 'Của Ann')).body.data.createCard;
    const b = (await createCard(bob.token, 'Của Bob')).body.data.createCard;

    expect(a.ownerId).toBe(ann.id);
    expect(b.ownerId).toBe(bob.id);
    expect(a.id).not.toBe(b.id);
    expect(await prisma.card.count({ where: { ownerId: ann.id } })).toBe(1);
    expect(await prisma.card.count({ where: { ownerId: bob.id } })).toBe(1);
  });

  it('creates a separate card for every one of ten parallel calls', async () => {
    const owner = await createUserWithToken('owner@example.com');
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => createCard(owner.token, `Thiệp ${i}`)));
    const ids = results.map((res) => res.body.data.createCard.id);
    expect(new Set(ids).size).toBe(10);
    expect(await prisma.card.count({ where: { ownerId: owner.id } })).toBe(10);
  });

  it('does not let a client send the owner, the revision or a role', async () => {
    const owner = await createUserWithToken('owner@example.com');
    const res = await createCard(owner.token, 'Thiệp');
    const row = await prisma.card.findUniqueOrThrow({ where: { id: res.body.data.createCard.id } });
    expect(row.ownerId).toBe(owner.id);
    expect(row.revision).toBe(0);
    expect(row.members).toEqual([]);
  });
});
