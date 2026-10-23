import { createHash } from 'node:crypto';
import { SignJWT } from 'jose';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { prisma } from '../src/infra/prisma';
import { closeQueueing } from '../src/infra/queue';
import { closeRedis } from '../src/infra/redis';
import { accessCookieOptions, cookieNames, refreshCookieOptions } from '../src/modules/auth/cookies';

const app = createApp();
const base = '/api/v1/auth';
const names = cookieNames(false);
const creds = { email: 'ann@example.com', password: 'correct horse battery' };

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const register = (body: unknown) => request(app).post(`${base}/register`).send(body as object);
const login = (body: unknown) => request(app).post(`${base}/login`).send(body as object);
const setCookies = (res: request.Response): string[] => ([] as string[]).concat(res.headers['set-cookie'] ?? []);
const cookieValue = (res: request.Response, name: string): string | undefined =>
  setCookies(res).find((c) => c.startsWith(`${name}=`))?.split(';')[0].slice(name.length + 1);
// Đăng nhập chỉ cho tài khoản đã xác minh email; các test không bàn về xác minh dùng hàm này.
const verify = (email: string) => prisma.user.updateMany({ where: { email }, data: { emailVerifiedAt: new Date() } });
const noSecrets = (res: request.Response) => {
  const text = JSON.stringify(res.body) + setCookies(res).join(';');
  expect(text).not.toMatch(/passwordHash|tokenHash|\$argon2/);
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

describe('register', () => {
  it('accepts a new account, normalizes the email and stores an unverified user', async () => {
    const res = await register({ email: '  ANN@Example.COM ', password: creds.password, name: 'Ann' });
    expect(res.status).toBe(202);
    noSecrets(res);
    const user = await prisma.user.findUnique({ where: { email: 'ann@example.com' }, omit: { passwordHash: false } });
    expect(user?.name).toBe('Ann');
    expect(user?.emailVerifiedAt).toBeNull();
    expect(user?.passwordHash).toMatch(/^\$argon2id\$/);
  });

  it('does not log the user in', async () => {
    const res = await register(creds);
    expect(setCookies(res)).toEqual([]);
  });

  it('gives the same response for an email that already exists and changes nothing', async () => {
    const first = await register(creds);
    await verify(creds.email);
    const before = await prisma.user.findUnique({ where: { email: creds.email }, omit: { passwordHash: false } });
    const second = await register({ ...creds, password: 'another password 123' });
    expect(second.status).toBe(first.status);
    expect(second.body).toEqual(first.body);
    expect(await prisma.user.count()).toBe(1);
    const after = await prisma.user.findUnique({ where: { email: creds.email }, omit: { passwordHash: false } });
    expect(after?.passwordHash).toBe(before?.passwordHash);
    expect((await login(creds)).status).toBe(200);
    expect((await login({ ...creds, password: 'another password 123' })).status).toBe(401);
  });

  it('never touches an existing Google-only account', async () => {
    await prisma.user.create({
      data: { email: creds.email, emailVerifiedAt: new Date(), identities: { create: { provider: 'GOOGLE', providerAccountId: 'sub-1' } } },
    });
    const res = await register(creds);
    expect(res.status).toBe(202);
    const user = await prisma.user.findUnique({ where: { email: creds.email }, omit: { passwordHash: false } });
    expect(user?.passwordHash).toBeNull();
    expect(user?.emailVerifiedAt).not.toBeNull();
    expect((await login(creds)).status).toBe(401);
  });

  it.each([
    ['a short password', { ...creds, password: 'short' }],
    ['a password over 128 characters', { ...creds, password: 'x'.repeat(129) }],
    ['an invalid email', { ...creds, email: 'not-an-email' }],
    ['a missing email', { password: creds.password }],
  ])('rejects %s with VALIDATION', async (_label, body) => {
    const res = await register(body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
  });

  it('rejects a non-JSON body', async () => {
    const res = await request(app).post(`${base}/register`).set('content-type', 'text/plain').send('email=a@b.co');
    expect(res.status).toBe(400);
  });
});

describe('login', () => {
  beforeEach(async () => {
    await register(creds);
    await verify(creds.email);
  });

  it('signs in, sets httpOnly cookies and returns the public user without secrets', async () => {
    const res = await login({ email: 'ANN@example.com', password: creds.password });
    expect(res.status).toBe(200);
    noSecrets(res);
    expect(res.body.user).toMatchObject({ email: creds.email, emailVerified: true });
    const cookies = setCookies(res);
    const access = cookies.find((c) => c.startsWith(`${names.access}=`))!;
    const refresh = cookies.find((c) => c.startsWith(`${names.refresh}=`))!;
    expect(access).toMatch(/HttpOnly/i);
    expect(access).toMatch(/Path=\/;/);
    expect(access).toMatch(/SameSite=Lax/i);
    expect(refresh).toMatch(/HttpOnly/i);
    expect(refresh).toMatch(/Path=\/api\/v1\/auth/);
    expect(res.body).not.toHaveProperty('token');
  });

  it('stores only a hash of the refresh token and starts a new session family', async () => {
    const res = await login(creds);
    const refresh = cookieValue(res, names.refresh)!;
    const sessions = await prisma.session.findMany();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].tokenHash).toBe(sha256(refresh));
    expect(sessions[0].tokenHash).not.toBe(refresh);
    expect(sessions[0].familyId).toBeTruthy();
    expect(sessions[0].revokedAt).toBeNull();
    expect(sessions[0].expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('gives the same 401 for a wrong password, an unknown email and a Google-only account', async () => {
    await prisma.user.create({ data: { email: 'g@example.com', emailVerifiedAt: new Date() } });
    const wrong = await login({ email: creds.email, password: 'wrong password' });
    const unknown = await login({ email: 'nobody@example.com', password: 'whatever123' });
    const googleOnly = await login({ email: 'g@example.com', password: 'whatever123' });
    for (const res of [wrong, unknown, googleOnly]) {
      expect(res.status).toBe(401);
      expect(setCookies(res)).toEqual([]);
    }
    expect(unknown.body).toEqual(wrong.body);
    expect(googleOnly.body).toEqual(wrong.body);
    expect(await prisma.session.count()).toBe(0);
  });

  it('refuses an unverified account with 403 only when the password is right, and creates no session', async () => {
    const unverified = { email: 'unverified@example.com', password: 'another correct horse' };
    await register(unverified);

    const right = await login(unverified);
    expect(right.status).toBe(403);
    expect(right.body.error.code).toBe('EMAIL_NOT_VERIFIED');
    expect(setCookies(right)).toEqual([]);
    expect(await prisma.session.count()).toBe(0);

    // Sai mật khẩu hoặc email lạ vẫn chỉ là 401 chung, nên không ai dò được tài khoản nào chưa xác minh.
    const wrong = await login({ ...unverified, password: 'wrong password' });
    const unknown = await login({ email: 'nobody@example.com', password: 'whatever123' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
  });
});

describe('me', () => {
  it('returns the current user for the cookie, a Bearer token, and rejects bad credentials', async () => {
    await register(creds);
    await verify(creds.email);
    const agent = request.agent(app);
    const loginRes = await agent.post(`${base}/login`).send(creds);
    const meRes = await agent.get(`${base}/me`);
    expect(meRes.status).toBe(200);
    expect(meRes.body.user.email).toBe(creds.email);
    noSecrets(meRes);

    const access = cookieValue(loginRes, names.access)!;
    expect((await request(app).get(`${base}/me`).set('Authorization', `Bearer ${access}`)).status).toBe(200);
    expect((await request(app).get(`${base}/me`)).status).toBe(401);
    expect((await request(app).get(`${base}/me`).set('Authorization', 'Bearer garbage')).status).toBe(401);
    const tampered = access.slice(0, -2) + (access.endsWith('AA') ? 'BB' : 'AA');
    expect((await request(app).get(`${base}/me`).set('Authorization', `Bearer ${tampered}`)).status).toBe(401);
  });

  it('rejects an expired token and a token for another audience', async () => {
    const key = new TextEncoder().encode(process.env.JWT_SECRET);
    const sign = (claims: { aud: string; exp: number }) =>
      new SignJWT({ sid: 's' }).setProtectedHeader({ alg: 'HS256' }).setSubject('u').setIssuer('cmbe').setAudience(claims.aud).setExpirationTime(claims.exp).sign(key);
    const expired = await sign({ aud: 'cmbe-clients', exp: Math.floor(Date.now() / 1000) - 60 });
    const wrongAudience = await sign({ aud: 'someone-else', exp: Math.floor(Date.now() / 1000) + 600 });
    for (const token of [expired, wrongAudience]) {
      expect((await request(app).get(`${base}/me`).set('Authorization', `Bearer ${token}`)).status).toBe(401);
    }
  });
});

describe('logout', () => {
  it('revokes the session, clears both cookies and returns 204', async () => {
    await register(creds);
    await verify(creds.email);
    const agent = request.agent(app);
    await agent.post(`${base}/login`).send(creds);
    const res = await agent.post(`${base}/logout`);
    expect(res.status).toBe(204);
    const cleared = setCookies(res);
    expect(cleared.find((c) => c.startsWith(`${names.access}=`))).toMatch(/Expires=Thu, 01 Jan 1970/);
    expect(cleared.find((c) => c.startsWith(`${names.refresh}=`))).toMatch(/Expires=Thu, 01 Jan 1970/);
    const sessions = await prisma.session.findMany();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].revokedAt).not.toBeNull();
    expect((await agent.get(`${base}/me`)).status).toBe(401);
  });

  it('returns 204 even without any cookie', async () => {
    expect((await request(app).post(`${base}/logout`)).status).toBe(204);
  });
});

describe('origin check', () => {
  it('rejects a disallowed Origin on POST but allows no Origin and an allowed one', async () => {
    const bad = await request(app).post(`${base}/login`).set('Origin', 'http://evil.example').send(creds);
    expect(bad.status).toBe(403);
    expect(bad.body.error.code).toBe('FORBIDDEN');
    const ok = await request(app).post(`${base}/login`).set('Origin', 'http://localhost:3001').send(creds);
    expect(ok.status).toBe(401); // qua được kiểm tra Origin, rồi sai thông tin đăng nhập
    expect((await request(app).post(`${base}/login`).send(creds)).status).toBe(401);
  });
});

describe('rate limit', () => {
  it('returns 429 after too many attempts from one IP', async () => {
    const limited = createApp({ authRateLimit: 3 });
    const attempt = () => request(limited).post(`${base}/login`).send({ email: 'x@example.com', password: 'whatever123' });
    for (let i = 0; i < 3; i++) expect((await attempt()).status).toBe(401);
    const res = await attempt();
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
  });
});

describe('cookie options', () => {
  it('uses prefixed, Secure cookies in production and scopes the refresh cookie to /api/v1/auth', () => {
    const config = { isProduction: true, sameSite: 'lax' as const };
    expect(cookieNames(true)).toEqual({ access: '__Host-access', refresh: '__Secure-refresh', googleState: '__Secure-google_oauth' });
    expect(accessCookieOptions(config)).toMatchObject({ httpOnly: true, secure: true, path: '/', sameSite: 'lax' });
    expect(accessCookieOptions(config)).not.toHaveProperty('domain'); // __Host- không cho phép Domain
    expect(refreshCookieOptions(config)).toMatchObject({ httpOnly: true, secure: true, path: '/api/v1/auth' });
  });

  it('forces Secure when SameSite is none, even outside production', () => {
    expect(accessCookieOptions({ isProduction: false, sameSite: 'none' }).secure).toBe(true);
  });
});

describe('health', () => {
  it('reports ok and ready', async () => {
    expect((await request(app).get('/health')).body).toEqual({ status: 'ok', service: 'CMBE' });
    const ready = await request(app).get('/ready');
    expect(ready.status).toBe(200);
    expect(ready.body).toEqual({ status: 'ready', checks: { database: 'ok', redis: 'ok' } });
  });
});
