import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { env } from '../src/config/env';
import { prisma } from '../src/infra/prisma';
import { closeQueueing } from '../src/infra/queue';
import { closeRedis } from '../src/infra/redis';
import { cookieNames } from '../src/modules/auth/cookies';

const app = createApp();
const base = '/api/v1/auth';
const names = cookieNames(false);
const creds = { email: 'ann@example.com', password: 'correct horse battery' };

const setCookies = (res: request.Response): string[] => ([] as string[]).concat(res.headers['set-cookie'] ?? []);
const cookieValue = (res: request.Response, name: string): string | undefined =>
  setCookies(res).find((c) => c.startsWith(`${name}=`))?.split(';')[0].slice(name.length + 1);
const cookieHeader = (tokens: { access?: string; refresh?: string }) =>
  [tokens.access && `${names.access}=${tokens.access}`, tokens.refresh && `${names.refresh}=${tokens.refresh}`].filter(Boolean).join('; ');
const refresh = (refreshToken?: string) => request(app).post(`${base}/refresh`).set('Cookie', cookieHeader({ refresh: refreshToken }));
const me = (access?: string) => request(app).get(`${base}/me`).set('Cookie', cookieHeader({ access }));
const tokensOf = (res: request.Response) => ({ access: cookieValue(res, names.access)!, refresh: cookieValue(res, names.refresh)! });

async function signedIn(email = creds.email) {
  await request(app).post(`${base}/register`).send({ email, password: creds.password });
  await prisma.user.updateMany({ where: { email }, data: { emailVerifiedAt: new Date() } });
  const res = await request(app).post(`${base}/login`).send({ email, password: creds.password });
  expect(res.status).toBe(200);
  return tokensOf(res);
}

const rowFor = async (refreshToken: string) => {
  const { createHash } = await import('node:crypto');
  return prisma.session.findUniqueOrThrow({ where: { tokenHash: createHash('sha256').update(refreshToken).digest('hex') } });
};

beforeEach(async () => {
  await prisma.session.deleteMany();
  await prisma.verificationToken.deleteMany();
  await prisma.identity.deleteMany();
  await prisma.user.deleteMany();
});

afterAll(async () => {
  await closeQueueing();
  await closeRedis();
  await prisma.$disconnect();
});

describe('POST /refresh', () => {
  it('rotates: returns new cookies, marks the old row, links the new one in the same family', async () => {
    const first = await signedIn();
    const res = await refresh(first.refresh);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ refreshed: true });
    expect(res.headers['cache-control']).toBe('no-store');

    const next = tokensOf(res);
    expect(next.refresh).not.toBe(first.refresh);
    expect(next.access).not.toBe(first.access);

    const oldRow = await rowFor(first.refresh);
    const newRow = await rowFor(next.refresh);
    expect(oldRow.rotatedAt).not.toBeNull();
    expect(oldRow.replacedById).toBe(newRow.id);
    expect(newRow.familyId).toBe(oldRow.familyId);
    expect(newRow.familyStartedAt.getTime()).toBe(oldRow.familyStartedAt.getTime());
    expect(newRow.rotatedAt ?? null).toBeNull();
  });

  it('issues an access token that works on /me, and the refresh token can be chained', async () => {
    const first = await signedIn();
    const second = tokensOf(await refresh(first.refresh));
    expect((await me(second.access)).body.user.email).toBe(creds.email);
    const third = await refresh(second.refresh);
    expect(third.status).toBe(200);
  });

  it('answers a reuse inside the grace window with a soft 409 and revokes nothing', async () => {
    const first = await signedIn();
    const next = tokensOf(await refresh(first.refresh));

    const again = await refresh(first.refresh);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('REFRESH_CONFLICT');
    expect(setCookies(again)).toEqual([]); // không xóa cookie mà tab kia vừa đặt

    expect((await refresh(next.refresh)).status).toBe(200); // token mới vẫn dùng được
  });

  it('treats a reuse after the grace window as theft: revokes the whole family', async () => {
    const first = await signedIn();
    const next = tokensOf(await refresh(first.refresh));
    const old = await rowFor(first.refresh);
    await prisma.session.update({ where: { id: old.id }, data: { rotatedAt: new Date(Date.now() - env.refreshGraceMs - 1000) } });

    const reuse = await refresh(first.refresh);
    expect(reuse.status).toBe(401);
    expect(setCookies(reuse).some((c) => c.startsWith(`${names.refresh}=;`))).toBe(true);

    const successor = await refresh(next.refresh); // cả họ đã bị thu hồi, kể cả token mới nhất
    expect(successor.status).toBe(401);
    const rows = await prisma.session.findMany({ where: { familyId: old.familyId } });
    expect(rows.every((row) => row.revokedAt !== null)).toBe(true);
  });

  it('lets exactly one of two concurrent refreshes with the same token win', async () => {
    const first = await signedIn();
    const [a, b] = await Promise.all([refresh(first.refresh), refresh(first.refresh)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect(setCookies(loser)).toEqual([]);
    expect(await prisma.session.count()).toBe(2);
  });

  it.each([
    ['no cookie', () => undefined],
    ['unknown token', () => 'not-a-real-token'],
  ])('rejects %s with 401 and clears the cookies', async (_name, token) => {
    const res = await refresh(token());
    expect(res.status).toBe(401);
    expect(setCookies(res).some((c) => c.startsWith(`${names.refresh}=;`))).toBe(true);
    expect(setCookies(res).some((c) => c.startsWith(`${names.access}=;`))).toBe(true);
  });

  it('rejects revoked, expired and over-age sessions', async () => {
    const revoked = await signedIn('a@example.com');
    await prisma.session.updateMany({ where: { tokenHash: (await rowFor(revoked.refresh)).tokenHash }, data: { revokedAt: new Date() } });
    expect((await refresh(revoked.refresh)).status).toBe(401);

    const expired = await signedIn('b@example.com');
    await prisma.session.update({ where: { id: (await rowFor(expired.refresh)).id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await refresh(expired.refresh)).status).toBe(401);

    const old = await signedIn('c@example.com');
    await prisma.session.update({
      where: { id: (await rowFor(old.refresh)).id },
      data: { familyStartedAt: new Date(Date.now() - env.sessionMaxAgeMs - 1000) },
    });
    expect((await refresh(old.refresh)).status).toBe(401);
  });

  it('never extends a family past the absolute session cap', async () => {
    const first = await signedIn();
    const row = await rowFor(first.refresh);
    const startedAt = new Date(Date.now() - env.sessionMaxAgeMs + 60_000); // 1 phút nữa là chạm trần
    await prisma.session.update({ where: { id: row.id }, data: { familyStartedAt: startedAt } });

    const next = await rowFor(tokensOf(await refresh(first.refresh)).refresh);
    expect(next.expiresAt.getTime()).toBe(startedAt.getTime() + env.sessionMaxAgeMs);
  });

  it('rejects a token whose user no longer exists', async () => {
    const first = await signedIn();
    // Prisma (Restrict) không cho xóa user còn phiên; xóa thẳng khỏi collection để dựng đúng tình huống "mồ côi".
    await prisma.$runCommandRaw({ delete: 'User', deletes: [{ q: { email: creds.email }, limit: 1 }] });
    expect(await prisma.user.count()).toBe(0);
    expect((await refresh(first.refresh)).status).toBe(401);
  });

  it('keeps logout working after rotation: it revokes the whole family', async () => {
    const first = await signedIn();
    const next = tokensOf(await refresh(first.refresh));
    await request(app).post(`${base}/logout`).set('Cookie', cookieHeader({ refresh: next.refresh }));
    const rows = await prisma.session.findMany();
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.revokedAt !== null)).toBe(true);
  });

  it('works for a session that was created by Google sign-in', async () => {
    const user = await prisma.user.create({ data: { email: 'g@example.com', emailVerifiedAt: new Date() } });
    const { createSession } = await import('../src/modules/auth/auth.service');
    const issued = await createSession(user.id, {});
    expect((await refresh(issued.refreshToken)).status).toBe(200);
  });
});

describe('POST /logout-all', () => {
  it('requires authentication', async () => {
    expect((await request(app).post(`${base}/logout-all`)).status).toBe(401);
  });

  it('revokes every session of the user, on every device, and no one else', async () => {
    const phone = await signedIn();
    const laptop = tokensOf(await request(app).post(`${base}/login`).send(creds));
    const other = await signedIn('other@example.com');

    const res = await request(app).post(`${base}/logout-all`).set('Cookie', cookieHeader(laptop));
    expect(res.status).toBe(204);
    expect(setCookies(res).some((c) => c.startsWith(`${names.refresh}=;`))).toBe(true);

    expect((await refresh(phone.refresh)).status).toBe(401);
    expect((await refresh(laptop.refresh)).status).toBe(401);
    expect((await refresh(other.refresh)).status).toBe(200);
  });
});
