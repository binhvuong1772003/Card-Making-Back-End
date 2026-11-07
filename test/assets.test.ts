import { createHash } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { prisma } from '../src/infra/prisma';
import { closeQueueing } from '../src/infra/queue';
import { closeRedis } from '../src/infra/redis';
import { signUpload } from '../src/modules/assets/assets.service';
import { createUserWithToken } from './helpers/auth';
import { resetDatabase } from './helpers/database';

const cloudinary = { apiKey: '123456789012345', apiSecret: 'test-secret-value', cloudName: 'demo-cloud' };
const app = createApp({ cloudinary, assetsUserHourlyLimit: 3, assetsUserDailyLimit: 5 });
const sha1 = (text: string) => createHash('sha1').update(text).digest('hex');

beforeEach(resetDatabase);
afterAll(async () => {
  await resetDatabase();
  await closeQueueing();
  await closeRedis();
  await prisma.$disconnect();
});

describe('POST /api/v1/assets/sign', () => {
  it('signs an upload for the signed-in user, in their own folder', async () => {
    const user = await createUserWithToken('uploader@example.com');
    const before = Math.floor(Date.now() / 1000);

    const res = await request(app).post('/api/v1/assets/sign').set('Authorization', `Bearer ${user.token}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ cloudName: 'demo-cloud', apiKey: '123456789012345', folder: `cardmaking/${user.id}` });
    expect(res.body.timestamp).toBeGreaterThanOrEqual(before);
    expect(res.body.timestamp).toBeLessThanOrEqual(before + 5);
    // Cùng công thức Cloudinary, tính độc lập với mã nguồn.
    const expected = sha1(`allowed_formats=${res.body.allowedFormats}&folder=cardmaking/${user.id}&timestamp=${res.body.timestamp}&transformation=${res.body.transformation}test-secret-value`);
    expect(res.body.signature).toBe(expected);
  });

  it('signs a size cap so a huge picture is shrunk as it is stored', async () => {
    const user = await createUserWithToken('uploader@example.com');
    const res = await request(app).post('/api/v1/assets/sign').set('Authorization', `Bearer ${user.token}`);
    expect(res.body.transformation).toBe('c_limit,h_4000,w_4000');
  });

  it('limits how many uploads one person can ask to sign, without affecting others', async () => {
    const heavy = await createUserWithToken('heavy@example.com');
    const other = await createUserWithToken('other@example.com');
    const sign = (token: string) => request(app).post('/api/v1/assets/sign').set('Authorization', `Bearer ${token}`);
    for (let i = 0; i < 3; i++) expect((await sign(heavy.token)).status).toBe(200);
    const blocked = await sign(heavy.token);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    expect((await sign(other.token)).status).toBe(200);
  });

  it('never sends the api secret to the client', async () => {
    const user = await createUserWithToken('uploader@example.com');
    const res = await request(app).post('/api/v1/assets/sign').set('Authorization', `Bearer ${user.token}`);
    expect(JSON.stringify(res.body)).not.toContain('test-secret-value');
  });

  it('refuses a request that is not signed in', async () => {
    const res = await request(app).post('/api/v1/assets/sign');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('answers 503 when image storage is not configured', async () => {
    const user = await createUserWithToken('uploader@example.com');
    const res = await request(createApp({ cloudinary: null })).post('/api/v1/assets/sign').set('Authorization', `Bearer ${user.token}`);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('PROVIDER_UNAVAILABLE');
  });
});

describe('signUpload', () => {
  it('gives each user a different folder and signature', () => {
    const a = signUpload('user-a', cloudinary, 1_700_000_000_000);
    const b = signUpload('user-b', cloudinary, 1_700_000_000_000);
    expect(a.folder).not.toBe(b.folder);
    expect(a.signature).not.toBe(b.signature);
    expect(a.timestamp).toBe(1_700_000_000);
  });
});
