import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Redis } from 'ioredis';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

// Chạy một lần cho cả bộ test: dựng MongoDB replica set trong bộ nhớ và một redis-server tạm
// (cổng ngẫu nhiên, không lưu đĩa). Test không bao giờ chạm vào Redis hay MongoDB thật của máy.
let repl: MongoMemoryReplSet | undefined;
let redisProcess: ChildProcess | undefined;
let redisDir: string | undefined;

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });

async function startRedis(): Promise<string> {
  try {
    execFileSync('redis-server', ['--version'], { stdio: 'pipe' });
  } catch {
    throw new Error('redis-server was not found on PATH. Tests need it installed locally (for example: brew install redis).');
  }
  const port = await freePort();
  redisDir = mkdtempSync(join(tmpdir(), 'cmbe-redis-'));
  redisProcess = spawn(
    'redis-server',
    ['--port', String(port), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no', '--maxmemory-policy', 'noeviction', '--dir', redisDir],
    { stdio: 'ignore' },
  );

  const probe = new Redis({ host: '127.0.0.1', port, lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null });
  probe.on('error', () => {}); // lúc mới khởi động, vài lần dò đầu bị từ chối là bình thường
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      await probe.connect();
      await probe.ping();
      probe.disconnect();
      return `redis://127.0.0.1:${port}`;
    } catch {
      if (Date.now() > deadline) throw new Error('The temporary redis-server did not start in time.');
      await new Promise((resolve) => setTimeout(resolve, 100));
      probe.disconnect();
    }
  }
}

export async function setup(project: { provide: (key: string, value: string) => void }): Promise<void> {
  repl = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const uri = repl.getUri('cmbe_test');
  const output = execFileSync('npx', ['prisma', 'db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: uri },
    encoding: 'utf8',
  });
  // db push là bước ghi; Prisma CLI cũng đọc .env (trỏ Atlas thật), nên xác nhận nó đã đẩy vào database tạm này.
  if (!output.includes('127.0.0.1') || !output.includes('cmbe_test') || output.includes('mongodb.net')) {
    throw new Error('Refusing to continue: prisma db push did not target the in-memory test database.');
  }
  project.provide('databaseUrl', uri);
  project.provide('redisUrl', await startRedis());
}

export async function teardown(): Promise<void> {
  redisProcess?.kill('SIGTERM');
  if (redisDir) rmSync(redisDir, { recursive: true, force: true });
  await repl?.stop();
}
