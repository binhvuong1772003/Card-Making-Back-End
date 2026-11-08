import { Prisma } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/infra/prisma';
import { closeQueueing } from '../src/infra/queue';
import { closeRedis } from '../src/infra/redis';

// Kiểm tra schema thiệp trên MongoDB thật (trong bộ nhớ): thành viên nhúng, ràng buộc duy nhất, chỉ mục.
const makeUser = (email: string) => prisma.user.create({ data: { email } });

beforeEach(async () => {
  await prisma.publication.deleteMany();
  await prisma.cardInvite.deleteMany();
  await prisma.card.deleteMany();
  await prisma.template.deleteMany();
  await prisma.user.deleteMany();
});

// Mọi file test dùng chung một database: dọn sạch để beforeEach của file khác (xóa User) không bị Card/Template chặn.
afterAll(async () => {
  await prisma.publication.deleteMany();
  await prisma.cardInvite.deleteMany();
  await prisma.card.deleteMany();
  await prisma.template.deleteMany();
  await prisma.user.deleteMany();
  await closeQueueing();
  await closeRedis();
  await prisma.$disconnect();
});

describe('card schema', () => {
  it('finds cards by owner or by embedded member', async () => {
    const owner = await makeUser('owner@example.com');
    const guest = await makeUser('guest@example.com');
    const stranger = await makeUser('stranger@example.com');
    const card = await prisma.card.create({
      data: {
        ownerId: owner.id,
        title: 'Thiệp',
        document: { elements: {} },
        members: [{ userId: guest.id, role: 'EDITOR', addedAt: new Date() }],
      },
    });
    expect(card.revision).toBe(0);
    expect(card.sourceTemplateId ?? null).toBeNull();

    const shared = await prisma.card.findMany({ where: { members: { some: { userId: guest.id } } } });
    expect(shared.map((c) => c.id)).toEqual([card.id]);
    expect(await prisma.card.count({ where: { members: { some: { userId: stranger.id } } } })).toBe(0);
    expect(await prisma.card.count({ where: { ownerId: owner.id } })).toBe(1);
  });

  it('adds a member with a conditional write that refuses a duplicate', async () => {
    const owner = await makeUser('owner@example.com');
    const guest = await makeUser('guest@example.com');
    // Luôn tạo thiệp với members: [] — nếu bỏ trống, Prisma không ghi trường này và các bộ lọc none/isEmpty/NOT some
    // không khớp thiệp đó (khác hẳn một mảng rỗng).
    const card = await prisma.card.create({ data: { ownerId: owner.id, title: 'T', document: {}, members: [] } });

    const add = () =>
      prisma.card.updateMany({
        where: { id: card.id, members: { none: { userId: guest.id } } },
        data: { members: { push: { userId: guest.id, role: 'VIEWER', addedAt: new Date() } } },
      });
    expect((await add()).count).toBe(1);
    expect((await add()).count).toBe(0);
    expect((await prisma.card.findUniqueOrThrow({ where: { id: card.id } })).members).toHaveLength(1);
  });

  it('allows many publications per card but a unique slug', async () => {
    const owner = await makeUser('owner@example.com');
    const [a, b] = await Promise.all(
      ['A', 'B'].map((title) => prisma.card.create({ data: { ownerId: owner.id, title, document: {} } })),
    );
    const publish = (cardId: string, slug: string) =>
      prisma.publication.create({ data: { cardId, slug, document: {}, publishedAt: new Date() } });

    await publish(a.id, 'abcxyz');
    await publish(a.id, 'other'); // nhiều bản mỗi thiệp
    await expect(publish(b.id, 'abcxyz')).rejects.toMatchObject({ code: 'P2002' }); // slug trùng
    await publish(b.id, 'second');
    expect(await prisma.publication.count()).toBe(3);
    expect(Prisma.PrismaClientKnownRequestError).toBeDefined();
  });

  it('stores a template snapshot and keeps cards independent of it', async () => {
    const author = await makeUser('author@example.com');
    const template = await prisma.template.create({
      data: { authorId: author.id, title: 'Mẫu cưới', category: 'wedding', tags: ['cuoi', 'vang'], snapshot: { a: 1 } },
    });
    expect(template).toMatchObject({ status: 'PUBLISHED', version: 1, useCount: 0 });

    const card = await prisma.card.create({
      data: { ownerId: author.id, title: 'Từ mẫu', document: { a: 1 }, sourceTemplateId: template.id },
    });
    await prisma.template.update({ where: { id: template.id }, data: { status: 'REMOVED', useCount: { increment: 1 } } });
    expect((await prisma.card.findUniqueOrThrow({ where: { id: card.id } })).sourceTemplateId).toBe(template.id);
    await prisma.template.delete({ where: { id: template.id } }); // không bị chặn vì không phải relation
  });
});
