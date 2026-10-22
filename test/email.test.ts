import { createHash } from 'node:crypto';
import { UnrecoverableError } from 'bullmq';
import type { Transporter } from 'nodemailer';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { createSmtpMailer } from '../src/infra/mailer';
import { prisma } from '../src/infra/prisma';
import { closeQueueing, getQueue } from '../src/infra/queue';
import { closeRedis } from '../src/infra/redis';
import { EMAIL_QUEUE, enqueueVerificationEmail, sendVerificationEmail, startEmailWorker, type EmailJob } from '../src/modules/auth/email.jobs';
import { verificationEmail } from '../src/modules/auth/email.templates';
import { createMemoryMailer } from './helpers/memory-mailer';

const app = createApp();
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const within = <T>(promise: Promise<T>, ms = 8000): Promise<T> =>
  Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms))]);
const tokenFromLink = (text: string): string => decodeURIComponent(text.match(/verify-email\?token=([^\s"]+)/)![1]);
const jobFor = (userId: string) => getQueue<EmailJob>(EMAIL_QUEUE).getJob(`verify-email-${userId}`);

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

describe('register enqueues the verification email', () => {
  it('adds one job that carries only ids, never a token or a link', async () => {
    const res = await request(app).post('/api/v1/auth/register').send({ email: 'new@example.com', password: 'correct horse battery', name: 'New' });
    expect(res.status).toBe(202);
    const user = await prisma.user.findUniqueOrThrow({ where: { email: 'new@example.com' } });
    const job = await jobFor(user.id);
    expect(job?.data).toEqual({ userId: user.id, purpose: 'EMAIL_VERIFY' });
    expect(JSON.stringify(job?.data)).not.toMatch(/token|http|@/i);
    expect(await prisma.verificationToken.count()).toBe(0); // token chỉ được tạo lúc gửi
  });

  it('enqueues nothing for a duplicate email or a Google-only account', async () => {
    const body = { email: 'dup@example.com', password: 'correct horse battery' };
    await request(app).post('/api/v1/auth/register').send(body);
    const first = await prisma.user.findUniqueOrThrow({ where: { email: 'dup@example.com' } });
    await getQueue<EmailJob>(EMAIL_QUEUE).remove(`verify-email-${first.id}`);

    await request(app).post('/api/v1/auth/register').send(body);
    expect(await jobFor(first.id)).toBeUndefined();

    const google = await prisma.user.create({ data: { email: 'g@example.com', emailVerifiedAt: new Date() } });
    await request(app).post('/api/v1/auth/register').send({ email: 'g@example.com', password: 'correct horse battery' });
    expect(await jobFor(google.id)).toBeUndefined();
  });

  it('still answers 202 and keeps the user when the queue is unavailable', async () => {
    await getQueue<EmailJob>(EMAIL_QUEUE).close(); // mô phỏng Redis không dùng được
    const res = await request(app).post('/api/v1/auth/register').send({ email: 'orphan@example.com', password: 'correct horse battery' });
    expect(res.status).toBe(202);
    expect(await prisma.user.count()).toBe(1);
    await closeQueueing(); // xóa hàng đợi đã đóng khỏi bộ nhớ đệm
  });
});

describe('sendVerificationEmail', () => {
  it('creates a hashed EMAIL_VERIFY token and sends a link whose token matches it', async () => {
    const user = await prisma.user.create({ data: { email: 'ann@example.com', name: 'Ann' } });
    const mailer = createMemoryMailer();
    expect(await sendVerificationEmail(user.id, mailer)).toBe('sent');

    expect(mailer.sent).toHaveLength(1);
    const [mail] = mailer.sent;
    expect(mail.to).toBe('ann@example.com');
    expect(mail.text).toContain('http://localhost:3001/verify-email?token=');
    const token = tokenFromLink(mail.text);

    const rows = await prisma.verificationToken.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: user.id, purpose: 'EMAIL_VERIFY', email: 'ann@example.com', tokenHash: sha256(token) });
    expect(rows[0].tokenHash).not.toBe(token);
    const ttl = rows[0].expiresAt.getTime() - Date.now();
    expect(ttl).toBeGreaterThan(23 * 3_600_000);
    expect(ttl).toBeLessThanOrEqual(24 * 3_600_000);
  });

  it('skips a missing user and an already verified user', async () => {
    const mailer = createMemoryMailer();
    expect(await sendVerificationEmail('64b64b64b64b64b64b64b64b', mailer)).toBe('skipped');
    const verified = await prisma.user.create({ data: { email: 'v@example.com', emailVerifiedAt: new Date() } });
    expect(await sendVerificationEmail(verified.id, mailer)).toBe('skipped');
    expect(mailer.sent).toHaveLength(0);
    expect(await prisma.verificationToken.count()).toBe(0);
  });

  it('keeps the token when sending fails (the message may have been delivered), and retries mint a new one', async () => {
    const user = await prisma.user.create({ data: { email: 'flaky@example.com' } });
    await expect(sendVerificationEmail(user.id, createMemoryMailer({ failWith: new Error('connection reset') }))).rejects.toThrow('connection reset');
    expect(await prisma.verificationToken.count()).toBe(1);
    await sendVerificationEmail(user.id, createMemoryMailer());
    expect(await prisma.verificationToken.count()).toBe(2);
  });

  it('does not retry a permanent Gmail authentication failure', async () => {
    const user = await prisma.user.create({ data: { email: 'auth@example.com' } });
    const failure = Object.assign(new Error('Invalid login'), { code: 'EAUTH' });
    await expect(sendVerificationEmail(user.id, createMemoryMailer({ failWith: failure }))).rejects.toBeInstanceOf(UnrecoverableError);
  });
});

describe('worker end to end', () => {
  it('sends the email for a queued job through the real queue and worker', async () => {
    const user = await prisma.user.create({ data: { email: 'e2e@example.com', name: 'E2E' } });
    const mailer = createMemoryMailer();
    startEmailWorker(mailer);
    await enqueueVerificationEmail(user.id);

    const deadline = Date.now() + 8000;
    while (mailer.sent.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0].to).toBe('e2e@example.com');
    expect(await prisma.verificationToken.count()).toBe(1);
    await within(closeQueueing(), 5000);
  });
});

describe('message building and transport', () => {
  it('escapes the user-supplied name and the link in the HTML body', () => {
    const mail = verificationEmail({ name: '<script>alert(1)</script>', link: 'http://x.test/v?token=a&b="c"', expiresInHours: 24 });
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('&lt;script&gt;');
    expect(mail.html).toContain('&amp;b=&quot;c&quot;');
    expect(mail.text).toContain('24 giờ');
  });

  it('hands the message to the SMTP transport with the configured From address', async () => {
    const sendMail = vi.fn().mockResolvedValue({});
    const mailer = createSmtpMailer({ sendMail } as unknown as Transporter, 'CardMaking <me@gmail.com>');
    await mailer.send({ to: 'a@example.com', subject: 'Hi', text: 'text', html: '<p>html</p>' });
    expect(sendMail).toHaveBeenCalledWith({ from: 'CardMaking <me@gmail.com>', to: 'a@example.com', subject: 'Hi', text: 'text', html: '<p>html</p>' });
  });
});
