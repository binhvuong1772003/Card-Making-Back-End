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
const SAVE =
  'mutation($id: ID!, $revision: Int!, $document: JSON!) { saveCardDocument(id: $id, revision: $revision, document: $document) { revision } }';
const save = (token: string, id: string, revision: number, document: unknown) =>
  request(app).post('/graphql').set('Authorization', `Bearer ${token}`).send({ query: SAVE, variables: { id, revision, document } });
const code = (res: request.Response): string | undefined => res.body.errors?.[0]?.extensions?.code;

beforeEach(resetDatabase);
afterAll(async () => {
  await resetDatabase();
  await closeQueueing();
  await closeRedis();
  await prisma.$disconnect();
});

describe('saveCardDocument', () => {
  it('writes the whole document and bumps the revision', async () => {
    const owner = await createUserWithToken('owner@example.com');
    const card = await prisma.card.create({ data: { ownerId: owner.id, title: 'T', document: {}, revision: 0, members: [] } });
    const page = samplePage('Xin chào');

    const res = await save(owner.token, card.id, 0, page);
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.saveCardDocument.revision).toBe(1);

    const after = await prisma.card.findUniqueOrThrow({ where: { id: card.id } });
    expect(after.document).toEqual(page);
    expect(after.revision).toBe(1);
  });

  it('refuses a stale revision and keeps the stored document', async () => {
    const owner = await createUserWithToken('owner@example.com');
    const card = await prisma.card.create({ data: { ownerId: owner.id, title: 'T', document: { a: 1 }, revision: 3, members: [] } });

    const res = await save(owner.token, card.id, 2, samplePage('mới'));
    expect(code(res)).toBe('CONFLICT');
    const after = await prisma.card.findUniqueOrThrow({ where: { id: card.id } });
    expect(after.document).toEqual({ a: 1 });
    expect(after.revision).toBe(3);
  });

  it('does not let a viewer or a stranger write', async () => {
    const owner = await createUserWithToken('owner@example.com');
    const viewer = await createUserWithToken('viewer@example.com');
    const stranger = await createUserWithToken('stranger@example.com');
    const card = await prisma.card.create({
      data: { ownerId: owner.id, title: 'T', document: {}, revision: 0, members: [{ userId: viewer.id, role: 'VIEWER', addedAt: new Date() }] },
    });

    expect(code(await save(viewer.token, card.id, 0, samplePage('a')))).toBe('FORBIDDEN');
    expect(code(await save(stranger.token, card.id, 0, samplePage('a')))).toBe('NOT_FOUND');
    expect((await prisma.card.findUniqueOrThrow({ where: { id: card.id } })).revision).toBe(0);
  });

  it('refuses a document that is not a valid page and keeps the stored one', async () => {
    const owner = await createUserWithToken('owner@example.com');
    const stored = samplePage('giữ nguyên');
    const card = await prisma.card.create({ data: { ownerId: owner.id, title: 'T', document: stored, revision: 2, members: [] } });

    for (const bad of [{ a: 1 }, {}, 'text', { schemaVersion: 1, root: { id: 'root', type: 'Page', children: [] } }, { ...samplePage('x'), schemaVersion: 99 }]) {
      expect(code(await save(owner.token, card.id, 2, bad))).toBe('VALIDATION');
    }
    const after = await prisma.card.findUniqueOrThrow({ where: { id: card.id } });
    expect(after.document).toEqual(stored);
    expect(after.revision).toBe(2);
  });

  it('refuses a page over the size limit', async () => {
    const owner = await createUserWithToken('owner@example.com');
    const card = await prisma.card.create({ data: { ownerId: owner.id, title: 'T', document: {}, revision: 0, members: [] } });
    expect(code(await save(owner.token, card.id, 0, samplePage('x'.repeat(850 * 1024))))).toBe('VALIDATION');
    expect((await prisma.card.findUniqueOrThrow({ where: { id: card.id } })).revision).toBe(0);
  });
});
