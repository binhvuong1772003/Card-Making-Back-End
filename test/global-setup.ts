import { execFileSync } from 'node:child_process';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

// Chạy một lần cho cả bộ test: dựng MongoDB replica set trong bộ nhớ và đẩy schema Prisma vào đó.
let repl: MongoMemoryReplSet | undefined;

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
}

export async function teardown(): Promise<void> {
  await repl?.stop();
}
