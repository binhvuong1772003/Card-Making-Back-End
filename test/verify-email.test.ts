import { createHash } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { prisma } from '../src/infra/prisma';
import { closeQueueing, getQueue } from '../src/infra/queue';
import { closeRedis, getRedis } from '../src/infra/redis';
import { EMAIL_QUEUE, sendVerificationEmail, type EmailJob } from '../src/modules/auth/email.jobs';
import { createMemoryMailer } from './helpers/memory-mailer';

const app = createApp();
const base = '/api/v1/auth';
const creds = { email: 'ann@example.com', password: 'correct horse battery' };
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const post = (path: string, body: unknown) => request(app).post(`${base}${path}`).send(body as object);
const cookies = (res: request.Response): string[] => ([] as string[]).concat(res.headers['set-cookie'] ?? []);

// Đăng ký, chạy bộ xử lý job như worker sẽ làm, rồi lấy token thô từ chính email đã "gửi".
async function registerAndGetToken(email = creds.email) {
  expect((await post('/register', { email, password: creds.password })).status).toBe(202);
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  const mailer = createMemoryMailer();
  await sendVerificationEmail(user.id, mailer);
  const token = decodeURIComponent(mailer.sent[0].text.match(/verify-email\?token=([^\s"]+)/)![1]);
  return { user, token };
}

const jobsFor = async (userId: string) =>
  (await getQueue<EmailJob>(EMAIL_QUEUE).getJobs(['waiting', 'delayed', 'active', 'completed', 'failed'])).filter((job) => job.data.userId === userId);

beforeEach(async () => {
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

describe('POST /verify-email', () => {
  it('verifies the user, consumes the token, retires sibling tokens and then allows login', async () => {
    const { user, token } = await registerAndGetToken();
    // Một link gửi lại trước đó (token thứ hai chưa dùng) cũng phải bị vô hiệu sau khi xác minh xong.
    await sendVerificationEmail(user.id, createMemoryMailer());
    expect(await prisma.verificationToken.count()).toBe(2);

    expect((await post('/login', creds)).status).toBe(403); // chưa xác minh

    const res = await post('/verify-email', { token });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ emailVerified: true });
    expect(cookies(res)).toEqual([]); // không tự đăng nhập

    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.emailVerifiedAt).not.toBeNull();
    const rows = await prisma.verificationToken.findMany();
    expect(rows.every((row) => row.usedAt !== null)).toBe(true);

    expect((await post('/login', creds)).status).toBe(200);
  });

  it('is idempotent: submitting the same token again still returns 200', async () => {
    const { token } = await registerAndGetToken();
    expect((await post('/verify-email', { token })).status).toBe(200);
    expect((await post('/verify-email', { token })).status).toBe(200);
  });

  it('lets exactly one of two parallel requests consume the token while both succeed', async () => {
    const { user, token } = await registerAndGetToken();
    const [a, b] = await Promise.all([post('/verify-email', { token }), post('/verify-email', { token })]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.emailVerifiedAt).not.toBeNull();
    const used = await prisma.verificationToken.findMany({ where: { usedAt: { isSet: true } } });
    expect(used).toHaveLength(1);
  });

  it('rejects an unknown token', async () => {
    const res = await post('/verify-email', { token: 'x'.repeat(43) });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('TOKEN_INVALID');
  });

  it('rejects an expired token with its own code and leaves the user unverified', async () => {
    const { user, token } = await registerAndGetToken();
    await prisma.verificationToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    const res = await post('/verify-email', { token });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('TOKEN_EXPIRED');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).emailVerifiedAt).toBeNull();
  });

  it('rejects a token of another purpose', async () => {
    const { token } = await registerAndGetToken();
    await prisma.verificationToken.updateMany({ data: { purpose: 'PASSWORD_RESET' } });
    const res = await post('/verify-email', { token });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('TOKEN_INVALID');
  });

  it('rejects a token issued for an email address the account no longer has', async () => {
    const { user, token } = await registerAndGetToken();
    await prisma.user.update({ where: { id: user.id }, data: { email: 'changed@example.com' } });
    const res = await post('/verify-email', { token });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('TOKEN_INVALID');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).emailVerifiedAt).toBeNull();
  });

  it('validates the request body and never exposes token data', async () => {
    expect((await post('/verify-email', {})).status).toBe(400);
    expect((await post('/verify-email', { token: '' })).status).toBe(400);
    const { token } = await registerAndGetToken();
    const res = await post('/verify-email', { token });
    expect(JSON.stringify(res.body)).not.toContain(sha256(token));
    expect(JSON.stringify(res.body)).not.toContain(token);
  });
});

describe('POST /resend-verification', () => {
  it('answers every email identically and only queues for an existing unverified account', async () => {
    const unverified = await prisma.user.create({ data: { email: 'u@example.com', passwordHash: 'x' } });
    const verified = await prisma.user.create({ data: { email: 'v@example.com', emailVerifiedAt: new Date() } });

    const responses = [];
    for (const email of ['u@example.com', 'v@example.com', 'nobody@example.com']) {
      responses.push(await post('/resend-verification', { email }));
    }
    for (const res of responses) {
      expect(res.status).toBe(202);
      expect(res.body).toEqual(responses[0].body);
    }
    expect(await jobsFor(unverified.id)).toHaveLength(1);
    expect(await jobsFor(verified.id)).toHaveLength(0);
  });

  it('uses a job id different from the registration one and carries only ids', async () => {
    await post('/register', { email: 'both@example.com', password: creds.password });
    const user = await prisma.user.findUniqueOrThrow({ where: { email: 'both@example.com' } });
    await post('/resend-verification', { email: 'both@example.com' });

    const jobs = await jobsFor(user.id);
    expect(jobs).toHaveLength(2);
    expect(new Set(jobs.map((job) => job.id)).size).toBe(2);
    expect(jobs.some((job) => job.id === `verify-email-${user.id}`)).toBe(true);
    expect(jobs.some((job) => job.id?.startsWith(`verify-email-resend-${user.id}-`))).toBe(true);
    for (const job of jobs) expect(job.data).toEqual({ userId: user.id, purpose: 'EMAIL_VERIFY' });
  });

  it('allows one resend per account per cooldown period', async () => {
    const user = await prisma.user.create({ data: { email: 'cool@example.com', passwordHash: 'x' } });
    await post('/resend-verification', { email: 'cool@example.com' });
    await post('/resend-verification', { email: 'cool@example.com' });
    expect(await jobsFor(user.id)).toHaveLength(1);

    await (await getRedis()).del(`cmbe-test:cooldown:verify-email:${user.id}`); // hết thời gian chờ
    await post('/resend-verification', { email: 'cool@example.com' });
    expect(await jobsFor(user.id)).toHaveLength(2);
  });

  it('rejects an invalid body', async () => {
    expect((await post('/resend-verification', { email: 'not-an-email' })).status).toBe(400);
    expect((await post('/resend-verification', {})).status).toBe(400);
  });
});
