import { generateKeyPairSync } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import { SignJWT, exportJWK } from 'jose';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { prisma } from '../src/infra/prisma';
import { closeQueueing } from '../src/infra/queue';
import { closeRedis } from '../src/infra/redis';
import { cookieNames } from '../src/modules/auth/cookies';
import { createGoogleOAuth, type GoogleClaims, type GoogleOAuth } from '../src/modules/auth/google-oauth';
import { requestSerializer } from '../src/infra/logger';
import { AppError } from '../src/shared/errors';

const base = '/api/v1/auth/google';
const names = cookieNames(false);
const FRONTEND = 'http://localhost:3001';

const claims = (overrides: Partial<GoogleClaims> = {}): GoogleClaims => ({
  sub: 'google-sub-1',
  email: 'ann@example.com',
  emailVerified: true,
  name: 'Ann',
  picture: 'https://example.com/ann.png',
  ...overrides,
});

// Bản giả của Google: không gọi mạng. `next` là kết quả của lần đổi code kế tiếp.
function fakeGoogle() {
  const fake = {
    next: claims() as GoogleClaims | Error,
    exchanged: [] as { code: string; codeVerifier: string }[],
    createPkce: async () => ({ codeVerifier: 'verifier-123', codeChallenge: 'challenge-123' }),
    buildAuthUrl: ({ state, codeChallenge }: { state: string; codeChallenge: string }) =>
      `https://accounts.google.com/o/oauth2/v2/auth?state=${state}&code_challenge=${codeChallenge}`,
    async exchangeCode(input: { code: string; codeVerifier: string }) {
      fake.exchanged.push(input);
      if (fake.next instanceof Error) throw fake.next;
      return fake.next;
    },
  };
  return fake satisfies GoogleOAuth & Record<string, unknown>;
}

const google = fakeGoogle();
const app = createApp({ google });
const noGoogleApp = createApp({ google: null });

const setCookies = (res: request.Response): string[] => ([] as string[]).concat(res.headers['set-cookie'] ?? []);
const cookieValue = (res: request.Response, name: string): string | undefined =>
  setCookies(res).find((c) => c.startsWith(`${name}=`))?.split(';')[0].slice(name.length + 1);

// Bắt đầu luồng và lấy state + cookie, như trình duyệt sẽ làm.
async function begin(returnTo?: string) {
  const res = await request(app).get(`${base}/start`).query(returnTo ? { returnTo } : {});
  expect(res.status).toBe(302);
  const state = new URL(res.headers.location).searchParams.get('state')!;
  const cookie = cookieValue(res, names.googleState)!;
  return { res, state, cookie };
}

async function callback(state: string | undefined, cookie: string | undefined, extra: Record<string, string> = { code: 'auth-code' }) {
  const req = request(app).get(`${base}/callback`).query({ ...(state ? { state } : {}), ...extra });
  return cookie ? req.set('Cookie', `${names.googleState}=${cookie}`) : req;
}

async function signIn(overrides: Partial<GoogleClaims> = {}) {
  google.next = claims(overrides);
  const { state, cookie } = await begin();
  return callback(state, cookie);
}

beforeEach(async () => {
  google.next = claims();
  google.exchanged.length = 0;
  await prisma.verificationToken.deleteMany();
  await prisma.session.deleteMany();
  await prisma.identity.deleteMany();
  await prisma.user.deleteMany();
});

afterAll(async () => {
  await closeQueueing();
  await closeRedis();
  await prisma.$disconnect();
});

describe('GET /auth/google/start', () => {
  it('redirects to Google and sets a short-lived, httpOnly, Lax state cookie scoped to the google path', async () => {
    const { res } = await begin();
    expect(res.headers.location).toMatch(/^https:\/\/accounts\.google\.com\//);
    expect(res.headers['cache-control']).toBe('no-store');
    const header = setCookies(res).find((c) => c.startsWith(`${names.googleState}=`))!;
    expect(header).toMatch(/HttpOnly/i);
    expect(header).toMatch(/SameSite=Lax/i);
    expect(header).toMatch(/Path=\/api\/v1\/auth\/google/);
    expect(header).toMatch(/Max-Age=600/);
  });

  it('ignores a malformed returnTo (array, too long) instead of failing the redirect', async () => {
    for (const query of ['returnTo[]=a&returnTo[]=b', `returnTo=/${'a'.repeat(300)}`]) {
      const res = await request(app).get(`${base}/start?${query}`);
      expect(res.status).toBe(302);
      expect(res.headers.location).toMatch(/^https:\/\/accounts\.google\.com\//);
    }
  });

  it('returns 503 when Google is not configured', async () => {
    const res = await request(noGoogleApp).get(`${base}/start`);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('PROVIDER_UNAVAILABLE');
  });
});

describe('GET /auth/google/callback', () => {
  it('creates a verified user with a Google identity, sets session cookies and redirects to the frontend', async () => {
    const res = await signIn();
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${FRONTEND}/`);
    expect(cookieValue(res, names.access)).toBeTruthy();
    expect(cookieValue(res, names.refresh)).toBeTruthy();
    expect(res.headers.location).not.toMatch(/code|state|token/);

    const user = await prisma.user.findUniqueOrThrow({ where: { email: 'ann@example.com' }, include: { identities: true } });
    expect(user.emailVerifiedAt).not.toBeNull();
    expect(user.passwordHash ?? null).toBeNull();
    expect(user.identities).toHaveLength(1);
    expect(user.identities[0]).toMatchObject({ provider: 'GOOGLE', providerAccountId: 'google-sub-1' });
    expect(google.exchanged).toEqual([{ code: 'auth-code', codeVerifier: 'verifier-123' }]);
  });

  it('lets the new session reach /me', async () => {
    const res = await signIn();
    const agent = [cookieValue(res, names.access) && `${names.access}=${cookieValue(res, names.access)}`].filter(Boolean).join('; ');
    const me = await request(app).get('/api/v1/auth/me').set('Cookie', agent);
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe('ann@example.com');
  });

  it('redirects to a validated returnTo and ignores hostile ones', async () => {
    const ok = await begin('/editor/42?tab=a');
    expect((await callback(ok.state, ok.cookie)).headers.location).toBe(`${FRONTEND}/editor/42?tab=a`);

    for (const bad of ['//evil.com', 'https://evil.com', '/\\evil.com', 'javascript:alert(1)', '/ok\nbad']) {
      const flow = await begin(bad);
      expect((await callback(flow.state, flow.cookie)).headers.location).toBe(`${FRONTEND}/`);
    }
  });

  it('clears the state cookie and makes it single-use', async () => {
    const { state, cookie } = await begin();
    const first = await callback(state, cookie);
    expect(setCookies(first).find((c) => c.startsWith(`${names.googleState}=`))).toMatch(/Expires=Thu, 01 Jan 1970|Max-Age=0/);
    // Phát lại cùng cookie + state vẫn hợp lệ về chữ ký, nhưng code Google đã dùng một lần: ở đây kiểm tra đường lỗi sạch.
    google.next = new AppError('PROVIDER_FAILED', 'used');
    const replay = await callback(state, cookie);
    expect(replay.headers.location).toBe(`${FRONTEND}/login?error=google_failed`);
  });

  it.each([
    ['no cookie', (s: string) => ({ state: s, cookie: undefined })],
    ['tampered cookie', (s: string, c: string) => ({ state: s, cookie: `${c}x` })],
    ['state mismatch', (_s: string, c: string) => ({ state: 'other-state', cookie: c })],
    ['missing state', (_s: string, c: string) => ({ state: undefined, cookie: c })],
  ])('rejects %s with invalid_state and never calls Google', async (_name, build) => {
    const flow = await begin();
    const { state, cookie } = build(flow.state, flow.cookie);
    const res = await callback(state, cookie);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${FRONTEND}/login?error=invalid_state`);
    expect(google.exchanged).toHaveLength(0);
    expect(setCookies(res).some((c) => c.startsWith(`${names.access}=`))).toBe(false);
  });

  it('rejects an access token used as the state cookie (separate audience)', async () => {
    const login = await signIn();
    const access = cookieValue(login, names.access)!;
    const flow = await begin();
    const res = await callback(flow.state, access);
    expect(res.headers.location).toBe(`${FRONTEND}/login?error=invalid_state`);
  });

  it('maps Google errors to generic redirect codes', async () => {
    const denied = await begin();
    expect((await callback(denied.state, denied.cookie, { error: 'access_denied' })).headers.location).toBe(`${FRONTEND}/login?error=cancelled`);
    const other = await begin();
    expect((await callback(other.state, other.cookie, { error: 'server_error' })).headers.location).toBe(`${FRONTEND}/login?error=google_failed`);

    google.next = new AppError('PROVIDER_FAILED', 'boom');
    const failed = await begin();
    expect((await callback(failed.state, failed.cookie)).headers.location).toBe(`${FRONTEND}/login?error=google_failed`);

    google.next = new Error('unexpected');
    const crashed = await begin();
    expect((await callback(crashed.state, crashed.cookie)).headers.location).toBe(`${FRONTEND}/login?error=server_error`);
  });

  it('rejects an email Google has not verified and creates nothing', async () => {
    const res = await signIn({ emailVerified: false });
    expect(res.headers.location).toBe(`${FRONTEND}/login?error=email_unverified`);
    expect(await prisma.user.count()).toBe(0);
  });
});

describe('rate limiting', () => {
  it('limits start but the callback always answers with a redirect, never JSON', async () => {
    const limited = createApp({ authRateLimit: 1, google });
    expect((await request(limited).get(`${base}/start`)).status).toBe(302);
    expect((await request(limited).get(`${base}/start`)).status).toBe(429);
    for (let i = 0; i < 3; i++) {
      const res = await request(limited).get(`${base}/callback`).query({ code: 'x', state: 'y' });
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(`${FRONTEND}/login?error=invalid_state`);
    }
  });
});

describe('account rules', () => {
  it('signs the same Google account in again without creating duplicates, filling only empty profile fields', async () => {
    await signIn();
    await prisma.user.update({ where: { email: 'ann@example.com' }, data: { name: 'Custom' } });
    const res = await signIn({ name: 'Different', picture: 'https://example.com/other.png' });
    expect(res.headers.location).toBe(`${FRONTEND}/`);
    expect(await prisma.user.count()).toBe(1);
    expect(await prisma.identity.count()).toBe(1);
    const user = await prisma.user.findUniqueOrThrow({ where: { email: 'ann@example.com' } });
    expect(user.name).toBe('Custom');
    expect(user.avatarUrl).toBe('https://example.com/ann.png');
  });

  it('matches by sub even if the email at Google changed, and never rewrites the stored email', async () => {
    await signIn();
    const res = await signIn({ email: 'new-address@example.com' });
    expect(res.headers.location).toBe(`${FRONTEND}/`);
    expect(await prisma.user.count()).toBe(1);
    expect((await prisma.user.findFirstOrThrow()).email).toBe('ann@example.com');
  });

  it('links Google to an existing VERIFIED account and keeps its password and sessions', async () => {
    const user = await prisma.user.create({ data: { email: 'ann@example.com', passwordHash: 'hash', emailVerifiedAt: new Date() } });
    const session = await prisma.session.create({ data: { userId: user.id, tokenHash: 'h1', familyId: 'f1', familyStartedAt: new Date(), expiresAt: new Date(Date.now() + 1e6) } });
    const res = await signIn();
    expect(res.headers.location).toBe(`${FRONTEND}/`);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id }, omit: { passwordHash: false } });
    expect(after.passwordHash).toBe('hash');
    expect((await prisma.session.findUniqueOrThrow({ where: { id: session.id } })).revokedAt ?? null).toBeNull();
    expect(await prisma.identity.count({ where: { userId: user.id } })).toBe(1);
  });

  it('on an UNVERIFIED password account: wipes the password, revokes sessions, retires tokens, then links', async () => {
    const user = await prisma.user.create({ data: { email: 'ann@example.com', passwordHash: 'attacker-chosen' } });
    const session = await prisma.session.create({ data: { userId: user.id, tokenHash: 'h2', familyId: 'f2', familyStartedAt: new Date(), expiresAt: new Date(Date.now() + 1e6) } });
    const token = await prisma.verificationToken.create({ data: { userId: user.id, tokenHash: 't1', email: 'ann@example.com', purpose: 'EMAIL_VERIFY', expiresAt: new Date(Date.now() + 1e6) } });

    const res = await signIn();
    expect(res.headers.location).toBe(`${FRONTEND}/`);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id }, omit: { passwordHash: false } });
    expect(after.passwordHash ?? null).toBeNull();
    expect(after.emailVerifiedAt).not.toBeNull();
    expect((await prisma.session.findUniqueOrThrow({ where: { id: session.id } })).revokedAt).not.toBeNull();
    expect((await prisma.verificationToken.findUniqueOrThrow({ where: { id: token.id } })).usedAt).not.toBeNull();
    expect(await prisma.identity.count({ where: { userId: user.id } })).toBe(1);
  });

  it('refuses to relink when the account already has a different Google sub', async () => {
    const user = await prisma.user.create({ data: { email: 'ann@example.com', emailVerifiedAt: new Date() } });
    await prisma.identity.create({ data: { userId: user.id, provider: 'GOOGLE', providerAccountId: 'original-sub' } });
    const res = await signIn({ sub: 'recycled-sub' });
    expect(res.headers.location).toBe(`${FRONTEND}/login?error=account_conflict`);
    expect(setCookies(res).some((c) => c.startsWith(`${names.access}=`))).toBe(false);
    expect(await prisma.identity.count()).toBe(1);
  });

  it('survives two concurrent first sign-ins of the same Google account', async () => {
    const a = await begin();
    const b = await begin();
    const [x, y] = await Promise.all([callback(a.state, a.cookie), callback(b.state, b.cookie)]);
    expect([x.headers.location, y.headers.location]).toEqual([`${FRONTEND}/`, `${FRONTEND}/`]);
    expect(await prisma.user.count()).toBe(1);
    expect(await prisma.identity.count()).toBe(1);
  });
});

describe('request logging', () => {
  it('strips the query string so code and state never reach the logs', () => {
    expect(requestSerializer({ id: 'r1', method: 'GET', originalUrl: '/api/v1/auth/google/callback?code=SECRET&state=SECRET2' })).toEqual({
      id: 'r1',
      method: 'GET',
      url: '/api/v1/auth/google/callback',
    });
  });
});

// Bộ chuyển đổi thật, chạy offline: thay chứng chỉ của Google bằng khóa cục bộ và chặn lệnh đổi code.
describe('createGoogleOAuth (real adapter, offline)', () => {
  const config = { clientId: 'cid.apps.googleusercontent.com', clientSecret: 'secret', redirectUri: 'http://localhost:3000/api/v1/auth/google/callback' };
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

  async function adapter(payload: Record<string, unknown>, audience = config.clientId) {
    const idToken = await new SignJWT(payload)
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer('https://accounts.google.com')
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
    const client = new OAuth2Client(config.clientId, config.clientSecret, config.redirectUri);
    const pem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
    void exportJWK; // chứng chỉ ở dạng PEM, không cần JWK
    (client as unknown as { getFederatedSignonCertsAsync: () => Promise<unknown> }).getFederatedSignonCertsAsync = async () => ({ certs: { k1: pem } });
    const calls: unknown[] = [];
    (client as unknown as { getToken: (o: unknown) => Promise<unknown> }).getToken = async (options: unknown) => {
      calls.push(options);
      return { tokens: { id_token: idToken } };
    };
    return { oauth: createGoogleOAuth(config, client), calls };
  }

  it('builds an auth URL with S256 PKCE, identity-only scope and no offline access', async () => {
    const { oauth } = await adapter({});
    const { codeChallenge } = await oauth.createPkce();
    const url = new URL(oauth.buildAuthUrl({ state: 'st', codeChallenge }));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: 'code',
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      scope: 'openid email profile',
      state: 'st',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      prompt: 'select_account',
    });
    expect(url.searchParams.has('access_type')).toBe(false);
  });

  it('exchanges the code (with the PKCE verifier and fixed redirect_uri) and returns normalized claims', async () => {
    const { oauth, calls } = await adapter({ sub: '123', email: 'Ann@Example.com', email_verified: true, name: 'Ann', picture: 'p.png' });
    const result = await oauth.exchangeCode({ code: 'c', codeVerifier: 'v' });
    expect(result).toEqual({ sub: '123', email: 'Ann@Example.com', emailVerified: true, name: 'Ann', picture: 'p.png' });
    expect(calls).toEqual([{ code: 'c', codeVerifier: 'v', redirect_uri: config.redirectUri }]);
  });

  it('reports an unverified email as such', async () => {
    const { oauth } = await adapter({ sub: '1', email: 'a@b.co', email_verified: false });
    expect((await oauth.exchangeCode({ code: 'c', codeVerifier: 'v' })).emailVerified).toBe(false);
  });

  it('rejects a token issued for another client', async () => {
    const { oauth } = await adapter({ sub: '1', email: 'a@b.co', email_verified: true }, 'someone-else.apps.googleusercontent.com');
    await expect(oauth.exchangeCode({ code: 'c', codeVerifier: 'v' })).rejects.toMatchObject({ code: 'PROVIDER_FAILED' });
  });

  it('rejects a token without sub or email', async () => {
    const { oauth } = await adapter({ email_verified: true });
    await expect(oauth.exchangeCode({ code: 'c', codeVerifier: 'v' })).rejects.toMatchObject({ code: 'PROVIDER_FAILED' });
  });
});
