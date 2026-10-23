import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { prisma } from '../src/infra/prisma';
import { closeQueueing } from '../src/infra/queue';
import { closeRedis } from '../src/infra/redis';
import { createUserWithToken } from './helpers/auth';
import { resetDatabase } from './helpers/database';

const app = createApp();
const UNKNOWN_ID = '6adac1d88b38f73bb659ed5f';

const gql = (token: string | undefined, query: string, variables?: unknown) => {
  const req = request(app).post('/graphql');
  if (token) req.set('Authorization', `Bearer ${token}`);
  return req.send({ query, variables });
};
const LIST = `query($first: Int, $after: String) {
  cards(first: $first, after: $after) {
    nodes { id title revision role ownerId createdAt updatedAt }
    pageInfo { hasNextPage endCursor }
  }
}`;
const DETAIL = 'query($id: ID!) { card(id: $id) { id title revision role ownerId document createdAt updatedAt } }';
const list = (token: string | undefined, variables: { first?: number | null; after?: string | null } = {}) => gql(token, LIST, variables);
const detail = (token: string | undefined, id: unknown) => gql(token, DETAIL, { id });
const code = (res: request.Response): string | undefined => res.body.errors?.[0]?.extensions?.code;

const T0 = Date.UTC(2026, 0, 1);
// Dựng thiệp thẳng trong DB với updatedAt tùy ý để kiểm soát thứ tự (chưa có API thành viên).
async function seedCard(
  ownerId: string,
  options: { title?: string; members?: { userId: string; role: 'EDITOR' | 'VIEWER' }[]; minutes?: number; document?: object } = {},
) {
  return prisma.card.create({
    data: {
      ownerId,
      title: options.title ?? 'Thiệp',
      document: options.document ?? {},
      revision: 3,
      members: (options.members ?? []).map((m) => ({ ...m, addedAt: new Date() })),
      updatedAt: new Date(T0 + (options.minutes ?? 0) * 60_000),
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

describe('cards (list)', () => {
  it('returns the caller\'s own and shared cards with the right role, newest first, and nothing else', async () => {
    const ann = await createUserWithToken('ann@example.com');
    const bob = await createUserWithToken('bob@example.com');
    const mine = await seedCard(ann.id, { title: 'Của Ann', minutes: 1 });
    const asEditor = await seedCard(bob.id, { title: 'Bob mời Ann sửa', members: [{ userId: ann.id, role: 'EDITOR' }], minutes: 3 });
    const asViewer = await seedCard(bob.id, { title: 'Bob mời Ann xem', members: [{ userId: ann.id, role: 'VIEWER' }], minutes: 2 });
    await seedCard(bob.id, { title: 'Riêng của Bob', minutes: 4 });

    const res = await list(ann.token);
    expect(res.body.errors).toBeUndefined();
    const { nodes, pageInfo } = res.body.data.cards;
    expect(nodes.map((n: { id: string }) => n.id)).toEqual([asEditor.id, asViewer.id, mine.id]);
    expect(nodes.map((n: { role: string }) => n.role)).toEqual(['EDITOR', 'VIEWER', 'OWNER']);
    expect(nodes[0]).toMatchObject({ title: 'Bob mời Ann sửa', revision: 3, ownerId: bob.id });
    expect(pageInfo).toEqual({ hasNextPage: false, endCursor: expect.any(String) });
  });

  it('answers an empty list for a user without cards', async () => {
    const ann = await createUserWithToken('ann@example.com');
    const bob = await createUserWithToken('bob@example.com');
    await seedCard(bob.id);
    const res = await list(ann.token);
    expect(res.body.data.cards).toEqual({ nodes: [], pageInfo: { hasNextPage: false, endCursor: null } });
  });

  it('does not expose the document in the list', async () => {
    const ann = await createUserWithToken('ann@example.com');
    const res = await gql(ann.token, '{ cards { nodes { id document } } }');
    expect(res.status).toBe(400);
    expect(code(res)).toBe('GRAPHQL_VALIDATION_FAILED');
  });

  it('pages through every card exactly once, with a stable cursor', async () => {
    const ann = await createUserWithToken('ann@example.com');
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) ids.push((await seedCard(ann.id, { title: `Thiệp ${i}`, minutes: i })).id);
    const newestFirst = [...ids].reverse();

    const seen: string[] = [];
    const sizes: number[] = [];
    let after: string | null = null;
    for (let page = 0; page < 5; page++) {
      const res: request.Response = await list(ann.token, { first: 3, after });
      const { nodes, pageInfo } = res.body.data.cards;
      sizes.push(nodes.length);
      seen.push(...nodes.map((n: { id: string }) => n.id));
      if (!pageInfo.hasNextPage) break;
      after = pageInfo.endCursor;
    }
    expect(sizes).toEqual([3, 3, 1]);
    expect(seen).toEqual(newestFirst);
  });

  it('keeps order and loses nothing when several cards share the same updatedAt', async () => {
    const ann = await createUserWithToken('ann@example.com');
    const created = await Promise.all(Array.from({ length: 6 }, (_, i) => seedCard(ann.id, { title: `Cùng giờ ${i}`, minutes: 5 })));

    const seen: string[] = [];
    let after: string | null = null;
    do {
      const res: request.Response = await list(ann.token, { first: 2, after });
      seen.push(...res.body.data.cards.nodes.map((n: { id: string }) => n.id));
      after = res.body.data.cards.pageInfo.hasNextPage ? res.body.data.cards.pageInfo.endCursor : null;
    } while (after);
    expect(new Set(seen).size).toBe(6);
    expect([...seen].sort()).toEqual(created.map((c) => c.id).sort());
  });

  it('moves a renamed card to the top and a card created after page one does not disturb page two', async () => {
    const ann = await createUserWithToken('ann@example.com');
    const [oldest, middle, newest] = [
      await seedCard(ann.id, { title: 'Cũ nhất', minutes: 1 }),
      await seedCard(ann.id, { title: 'Giữa', minutes: 2 }),
      await seedCard(ann.id, { title: 'Mới nhất', minutes: 3 }),
    ];
    const first = await list(ann.token, { first: 1 });
    expect(first.body.data.cards.nodes[0].id).toBe(newest.id);

    // Có thiệp mới xuất hiện giữa hai lần lấy trang: trang kế vẫn tiếp tục đúng chỗ, không lặp lại thiệp đã thấy.
    await prisma.card.create({ data: { ownerId: ann.id, title: 'Mới tinh', document: {}, members: [] } });
    const second = await list(ann.token, { first: 5, after: first.body.data.cards.pageInfo.endCursor });
    expect(second.body.data.cards.nodes.map((n: { id: string }) => n.id)).toEqual([middle.id, oldest.id]);

    // Đổi tên đẩy thiệp lên đầu danh sách.
    await gql(ann.token, 'mutation($id: ID!) { updateCardTitle(id: $id, title: "Vừa sửa") { id } }', { id: oldest.id });
    const afterRename = await list(ann.token, { first: 1 });
    expect(afterRename.body.data.cards.nodes[0].id).toBe(oldest.id);
  });

  it('applies the default page size of 20 and accepts 50', async () => {
    const ann = await createUserWithToken('ann@example.com');
    await prisma.card.createMany({
      data: Array.from({ length: 25 }, (_, i) => ({ ownerId: ann.id, title: `T${i}`, document: {}, members: [], updatedAt: new Date(T0 + i * 1000) })),
    });
    const res = await list(ann.token);
    expect(res.body.data.cards.nodes).toHaveLength(20);
    expect(res.body.data.cards.pageInfo.hasNextPage).toBe(true);
    expect((await list(ann.token, { first: 50 })).body.data.cards.nodes).toHaveLength(25);
  });

  it.each([0, 51, -1])('rejects first = %s', async (first) => {
    const ann = await createUserWithToken('ann@example.com');
    expect(code(await list(ann.token, { first }))).toBe('VALIDATION');
  });

  it.each(['garbage', Buffer.from('nope').toString('base64url'), Buffer.from('123:xyz').toString('base64url'), 'a'.repeat(300)])(
    'rejects the malformed cursor %#',
    async (after) => {
      const ann = await createUserWithToken('ann@example.com');
      expect(code(await list(ann.token, { after }))).toBe('VALIDATION');
    },
  );

  it('treats an explicit null for first and after as not given', async () => {
    const ann = await createUserWithToken('ann@example.com');
    await seedCard(ann.id);
    const res = await list(ann.token, { first: null, after: null });
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.cards.nodes).toHaveLength(1);
  });

  it('never leaks another user\'s cards, even with a cursor taken from that user\'s list', async () => {
    const ann = await createUserWithToken('ann@example.com');
    const bob = await createUserWithToken('bob@example.com');
    for (let i = 0; i < 3; i++) await seedCard(bob.id, { title: `Bob ${i}`, minutes: i });
    await seedCard(ann.id, { title: 'Của Ann', minutes: -10 });

    const bobsPage = await list(bob.token, { first: 1 });
    const res = await list(ann.token, { after: bobsPage.body.data.cards.pageInfo.endCursor });
    expect(res.body.data.cards.nodes.map((n: { title: string }) => n.title)).toEqual(['Của Ann']);
  });

  it('requires a signed-in caller', async () => {
    expect(code(await list(undefined))).toBe('UNAUTHENTICATED');
  });
});

describe('card (detail)', () => {
  it('opens a card for the owner, an editor and a viewer, with the draft and the caller\'s role', async () => {
    const owner = await createUserWithToken('owner@example.com');
    const editor = await createUserWithToken('editor@example.com');
    const viewer = await createUserWithToken('viewer@example.com');
    const document = { marker: 'bản nháp', nested: { list: [1, 2, 3] } };
    const card = await seedCard(owner.id, {
      title: 'Thiệp chi tiết',
      document,
      members: [
        { userId: editor.id, role: 'EDITOR' },
        { userId: viewer.id, role: 'VIEWER' },
      ],
    });

    for (const [user, role] of [[owner, 'OWNER'], [editor, 'EDITOR'], [viewer, 'VIEWER']] as const) {
      const res = await detail(user.token, card.id);
      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.card).toMatchObject({ id: card.id, title: 'Thiệp chi tiết', revision: 3, role, ownerId: owner.id, document });
    }
  });

  it('answers NOT_FOUND, with the same message, to a stranger, an unknown id and a malformed id', async () => {
    const owner = await createUserWithToken('owner@example.com');
    const stranger = await createUserWithToken('stranger@example.com');
    const card = await seedCard(owner.id);

    const results = [
      await detail(stranger.token, card.id),
      await detail(stranger.token, UNKNOWN_ID),
      await detail(stranger.token, 'not-an-id'),
    ];
    for (const res of results) {
      expect(code(res)).toBe('NOT_FOUND');
      expect(res.body.data.card).toBeNull();
    }
    expect(new Set(results.map((res) => res.body.errors[0].message)).size).toBe(1);
  });

  it('is NOT_FOUND once the card is deleted, and requires a signed-in caller', async () => {
    const owner = await createUserWithToken('owner@example.com');
    const card = await seedCard(owner.id);
    expect(code(await detail(undefined, card.id))).toBe('UNAUTHENTICATED');
    await gql(owner.token, 'mutation($id: ID!) { deleteCard(id: $id) }', { id: card.id });
    expect(code(await detail(owner.token, card.id))).toBe('NOT_FOUND');
  });

  it('shows the placeholder document of a freshly created card', async () => {
    const owner = await createUserWithToken('owner@example.com');
    const created = await gql(owner.token, 'mutation { createCard(input: { title: "Mới" }) { id } }');
    const res = await detail(owner.token, created.body.data.createCard.id);
    expect(res.body.data.card).toMatchObject({ title: 'Mới', revision: 0, role: 'OWNER', document: {} });
  });
});
