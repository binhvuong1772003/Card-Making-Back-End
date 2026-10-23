import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { prisma } from '../src/infra/prisma';
import { closeQueueing } from '../src/infra/queue';
import { closeRedis } from '../src/infra/redis';
import { createUserWithToken } from './helpers/auth';
import { resetDatabase } from './helpers/database';

const app = createApp();
const UNKNOWN_ID = '6adac1d88b38f73bb659ed5f'; // đúng dạng ObjectId nhưng không có thiệp nào

const gql = (token: string | undefined, query: string, variables?: unknown) => {
  const req = request(app).post('/graphql');
  if (token) req.set('Authorization', `Bearer ${token}`);
  return req.send({ query, variables });
};
const RENAME = 'mutation($id: ID!, $title: String!) { updateCardTitle(id: $id, title: $title) { id title revision role ownerId updatedAt } }';
const DELETE = 'mutation($id: ID!) { deleteCard(id: $id) }';
const rename = (token: string | undefined, id: unknown, title: unknown) => gql(token, RENAME, { id, title });
const remove = (token: string | undefined, id: unknown) => gql(token, DELETE, { id });
const code = (res: request.Response): string | undefined => res.body.errors?.[0]?.extensions?.code;

// Chưa có API quản lý thành viên nên dựng thiệp có thành viên thẳng trong DB.
async function seedCard(ownerId: string, members: { userId: string; role: 'EDITOR' | 'VIEWER' }[] = [], title = 'Thiệp') {
  return prisma.card.create({
    data: {
      ownerId,
      title,
      document: { marker: 'nội dung phải giữ nguyên' },
      revision: 7,
      members: members.map((m) => ({ ...m, addedAt: new Date() })),
    },
  });
}

beforeEach(resetDatabase);
afterAll(async () => {
  await resetDatabase();
  await closeQueueing();
  await closeRedis();
  await prisma.$disconnect();
});

describe('updateCardTitle', () => {
  it('lets the owner rename: trims the title, keeps content and revision, bumps updatedAt', async () => {
    const owner = await createUserWithToken('owner@example.com');
    const card = await seedCard(owner.id);
    await new Promise((resolve) => setTimeout(resolve, 15)); // để updatedAt chắc chắn khác

    const res = await rename(owner.token, card.id, '  Tên mới  ');
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.updateCardTitle).toMatchObject({ id: card.id, title: 'Tên mới', revision: 7, role: 'OWNER', ownerId: owner.id });

    const after = await prisma.card.findUniqueOrThrow({ where: { id: card.id } });
    expect(after.document).toEqual({ marker: 'nội dung phải giữ nguyên' });
    expect(after.revision).toBe(7);
    expect(after.members).toEqual([]);
    expect(after.updatedAt.getTime()).toBeGreaterThan(card.updatedAt.getTime());
  });

  it('lets an editor rename and reports the editor role', async () => {
    const owner = await createUserWithToken('owner@example.com');
    const editor = await createUserWithToken('editor@example.com');
    const card = await seedCard(owner.id, [{ userId: editor.id, role: 'EDITOR' }]);

    const res = await rename(editor.token, card.id, 'Do editor đổi');
    expect(res.body.data.updateCardTitle).toMatchObject({ title: 'Do editor đổi', role: 'EDITOR', ownerId: owner.id });
  });

  it('refuses a viewer with FORBIDDEN and changes nothing', async () => {
    const owner = await createUserWithToken('owner@example.com');
    const viewer = await createUserWithToken('viewer@example.com');
    const card = await seedCard(owner.id, [{ userId: viewer.id, role: 'VIEWER' }], 'Gốc');

    expect(code(await rename(viewer.token, card.id, 'Sửa lén'))).toBe('FORBIDDEN');
    expect((await prisma.card.findUniqueOrThrow({ where: { id: card.id } })).title).toBe('Gốc');
  });

  it('answers NOT_FOUND to a stranger, an unknown id and a malformed id, so existence is not revealed', async () => {
    const owner = await createUserWithToken('owner@example.com');
    const stranger = await createUserWithToken('stranger@example.com');
    const card = await seedCard(owner.id, [], 'Gốc');

    const asStranger = await rename(stranger.token, card.id, 'Cướp');
    const unknown = await rename(stranger.token, UNKNOWN_ID, 'Cướp');
    expect(code(asStranger)).toBe('NOT_FOUND');
    expect(code(unknown)).toBe('NOT_FOUND');
    expect(asStranger.body.errors[0].message).toBe(unknown.body.errors[0].message); // hai trường hợp không phân biệt được
    expect(code(await rename(stranger.token, 'not-an-object-id', 'Cướp'))).toBe('NOT_FOUND');
    expect(code(await rename(stranger.token, '12345', 'Cướp'))).toBe('NOT_FOUND');
    expect((await prisma.card.findUniqueOrThrow({ where: { id: card.id } })).title).toBe('Gốc');
  });

  it.each([
    ['empty', ''],
    ['only whitespace', '   '],
    ['101 characters', 'a'.repeat(101)],
  ])('rejects a title that is %s', async (_name, title) => {
    const owner = await createUserWithToken('owner@example.com');
    const card = await seedCard(owner.id, [], 'Gốc');
    const res = await rename(owner.token, card.id, title);
    expect(code(res)).toBe('VALIDATION');
    expect((await prisma.card.findUniqueOrThrow({ where: { id: card.id } })).title).toBe('Gốc');
  });

  it('requires a signed-in caller', async () => {
    const owner = await createUserWithToken('owner@example.com');
    const card = await seedCard(owner.id, [], 'Gốc');
    expect(code(await rename(undefined, card.id, 'Mới'))).toBe('UNAUTHENTICATED');
    expect((await prisma.card.findUniqueOrThrow({ where: { id: card.id } })).title).toBe('Gốc');
  });

  it('only touches the requested card', async () => {
    const owner = await createUserWithToken('owner@example.com');
    const a = await seedCard(owner.id, [], 'A');
    const b = await seedCard(owner.id, [], 'B');
    await rename(owner.token, a.id, 'A mới');
    expect((await prisma.card.findUniqueOrThrow({ where: { id: b.id } })).title).toBe('B');
  });

  it('keeps the card consistent when two renames race', async () => {
    const owner = await createUserWithToken('owner@example.com');
    const card = await seedCard(owner.id);
    const results = await Promise.all(['Một', 'Hai', 'Ba', 'Bốn'].map((title) => rename(owner.token, card.id, title)));
    expect(results.every((res) => res.body.errors === undefined)).toBe(true);
    const after = await prisma.card.findUniqueOrThrow({ where: { id: card.id } });
    expect(['Một', 'Hai', 'Ba', 'Bốn']).toContain(after.title);
    expect(after.revision).toBe(7);
  });
});

describe('rename racing delete', () => {
  // Một vòng đua từng thất bại khoảng một nửa số lần khi chỉ thử lại một lần, nên lặp nhiều vòng để test có sức bắt lỗi.
  it('always lets the delete win and never turns the clash into an internal error', async () => {
    const owner = await createUserWithToken('owner@example.com');
    for (let round = 0; round < 10; round++) {
      const card = await seedCard(owner.id);
      const [del, ...renames] = await Promise.all([
        remove(owner.token, card.id),
        ...['Một', 'Hai', 'Ba', 'Bốn'].map((title) => rename(owner.token, card.id, title)),
      ]);
      expect(del.body.errors).toBeUndefined();
      expect(del.body.data.deleteCard).toBe(true);
      for (const res of renames) {
        const outcome = res.body.errors ? code(res) : 'OK';
        expect(['OK', 'NOT_FOUND']).toContain(outcome); // thành công trước khi xóa, hoặc thiệp đã mất; không bao giờ INTERNAL
      }
      expect(await prisma.card.findUnique({ where: { id: card.id } })).toBeNull();
    }
  });
});

describe('deleteCard', () => {
  it('lets the owner delete the card with its publication and invites, and nothing else', async () => {
    const owner = await createUserWithToken('owner@example.com');
    const card = await seedCard(owner.id);
    const other = await seedCard(owner.id, [], 'Thiệp khác');
    const publish = (cardId: string, slug: string) =>
      prisma.publication.create({ data: { cardId, slug, document: {}, publishedAt: new Date() } });
    const invite = (cardId: string, tokenHash: string) =>
      prisma.cardInvite.create({ data: { cardId, role: 'VIEWER', tokenHash, createdById: owner.id, expiresAt: new Date(Date.now() + 1e6) } });
    await publish(card.id, 'bo-di');
    await publish(other.id, 'giu-lai');
    await invite(card.id, 'hash-1');
    await invite(card.id, 'hash-2');
    await invite(other.id, 'hash-3');
    const template = await prisma.template.create({
      data: { authorId: owner.id, sourceCardId: card.id, title: 'Mẫu', category: 'wedding', tags: [], snapshot: {} },
    });

    const res = await remove(owner.token, card.id);
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.deleteCard).toBe(true);

    expect(await prisma.card.findUnique({ where: { id: card.id } })).toBeNull();
    expect(await prisma.publication.count({ where: { cardId: card.id } })).toBe(0);
    expect(await prisma.cardInvite.count({ where: { cardId: card.id } })).toBe(0);
    // Không đụng thiệp khác và mẫu đã đăng từ thiệp này
    expect(await prisma.card.findUnique({ where: { id: other.id } })).not.toBeNull();
    expect(await prisma.publication.count({ where: { cardId: other.id } })).toBe(1);
    expect(await prisma.cardInvite.count({ where: { cardId: other.id } })).toBe(1);
    expect(await prisma.template.findUnique({ where: { id: template.id } })).not.toBeNull();
  });

  it.each(['EDITOR', 'VIEWER'] as const)('refuses a %s with FORBIDDEN and deletes nothing', async (role) => {
    const owner = await createUserWithToken('owner@example.com');
    const member = await createUserWithToken('member@example.com');
    const card = await seedCard(owner.id, [{ userId: member.id, role }]);
    await prisma.publication.create({ data: { cardId: card.id, slug: 'con-lai', document: {}, publishedAt: new Date() } });

    expect(code(await remove(member.token, card.id))).toBe('FORBIDDEN');
    expect(await prisma.card.findUnique({ where: { id: card.id } })).not.toBeNull();
    expect(await prisma.publication.count({ where: { cardId: card.id } })).toBe(1);
  });

  it('answers NOT_FOUND to a stranger, an unknown id and a malformed id', async () => {
    const owner = await createUserWithToken('owner@example.com');
    const stranger = await createUserWithToken('stranger@example.com');
    const card = await seedCard(owner.id);

    expect(code(await remove(stranger.token, card.id))).toBe('NOT_FOUND');
    expect(code(await remove(stranger.token, UNKNOWN_ID))).toBe('NOT_FOUND');
    expect(code(await remove(stranger.token, 'garbage'))).toBe('NOT_FOUND');
    expect(await prisma.card.findUnique({ where: { id: card.id } })).not.toBeNull();
  });

  it('requires a signed-in caller', async () => {
    const owner = await createUserWithToken('owner@example.com');
    const card = await seedCard(owner.id);
    expect(code(await remove(undefined, card.id))).toBe('UNAUTHENTICATED');
    expect(await prisma.card.findUnique({ where: { id: card.id } })).not.toBeNull();
  });

  it('answers NOT_FOUND the second time, and renaming a deleted card is NOT_FOUND too', async () => {
    const owner = await createUserWithToken('owner@example.com');
    const card = await seedCard(owner.id);
    expect((await remove(owner.token, card.id)).body.data.deleteCard).toBe(true);
    expect(code(await remove(owner.token, card.id))).toBe('NOT_FOUND');
    expect(code(await rename(owner.token, card.id, 'Muộn'))).toBe('NOT_FOUND');
  });

  it('lets exactly one of several parallel deletes succeed', async () => {
    const owner = await createUserWithToken('owner@example.com');
    const card = await seedCard(owner.id);
    await prisma.publication.create({ data: { cardId: card.id, slug: 'song-song', document: {}, publishedAt: new Date() } });

    const results = await Promise.all(Array.from({ length: 4 }, () => remove(owner.token, card.id)));
    const succeeded = results.filter((res) => res.body.data?.deleteCard === true);
    expect(succeeded).toHaveLength(1);
    expect(results.filter((res) => res !== succeeded[0]).every((res) => code(res) === 'NOT_FOUND')).toBe(true);
    expect(await prisma.card.count()).toBe(0);
    expect(await prisma.publication.count()).toBe(0);
  });
});
