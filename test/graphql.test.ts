import { SignJWT } from 'jose';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createApp } from '../src/app';
import { createGraphql, type Graphql } from '../src/graphql/create-graphql';
import { requireUser } from '../src/graphql/guards';
import { prisma } from '../src/infra/prisma';
import { closeQueueing } from '../src/infra/queue';
import { closeRedis } from '../src/infra/redis';
import { authenticate } from '../src/modules/auth/authenticate';
import { cookieNames } from '../src/modules/auth/cookies';
import { signAccessToken } from '../src/modules/auth/tokens';
import { AppError } from '../src/shared/errors';

// Module giả để thử chính khung: không có nghiệp vụ nào của dự án.
const typeDefs = `
  type Deep { value: Int next: Deep }
  extend type Query {
    whoami: String!
    forbidden: String
    crash: String
    invalid: String
    stamp: DateTime!
    echoDate(at: DateTime!): DateTime!
    echoJson(value: JSON): JSON
    deep: Deep
    one: Int
    two: Int
  }
  type Mutation { rename(title: String!): String! }
`;
const makeDeep = (n: number): { value: number; next: () => unknown } => ({ value: n, next: () => makeDeep(n + 1) });
const resolvers = {
  Query: {
    whoami: (_: unknown, __: unknown, ctx: Parameters<typeof requireUser>[0]) => requireUser(ctx),
    forbidden: () => {
      throw new AppError('FORBIDDEN', 'You cannot do that');
    },
    crash: () => {
      throw new Error('secret database detail');
    },
    invalid: () => z.string().parse(1),
    stamp: () => new Date('2026-10-23T02:09:28.705Z'),
    echoDate: (_: unknown, args: { at: Date }) => args.at,
    echoJson: (_: unknown, args: { value: unknown }) => args.value,
    deep: () => makeDeep(1),
    one: () => 1,
    two: () => 2,
  },
  Mutation: { rename: (_: unknown, args: { title: string }) => args.title },
};

const build = (overrides: Partial<Parameters<typeof createGraphql>[0]> = {}): Graphql =>
  createGraphql({ modules: [{ typeDefs, resolvers }], authenticate, ...overrides });

const names = cookieNames(false);
const app = createApp({ graphql: build() });
const gql = (query: string, init: { cookie?: string; bearer?: string; variables?: unknown; target?: ReturnType<typeof createApp> } = {}) => {
  const req = request(init.target ?? app).post('/graphql');
  if (init.cookie) req.set('Cookie', init.cookie);
  if (init.bearer) req.set('Authorization', `Bearer ${init.bearer}`);
  return req.send({ query, variables: init.variables });
};
const code = (res: request.Response): string | undefined => res.body.errors?.[0]?.extensions?.code;

afterAll(async () => {
  await closeQueueing();
  await closeRedis();
  await prisma.$disconnect();
});

describe('basics', () => {
  it('answers ping without logging in', async () => {
    const res = await gql('{ ping }');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { ping: 'pong' } });
  });

  it('composes the schema of a module and serves queries and mutations', async () => {
    expect((await gql('mutation { rename(title: "Thiệp") }')).body.data.rename).toBe('Thiệp');
    expect((await gql('{ one two }')).body.data).toEqual({ one: 1, two: 2 });
  });

  it('does not serve the Apollo landing page', async () => {
    const res = await request(app).get('/graphql').set('Accept', 'text/html');
    expect(res.text).not.toMatch(/<html/i);
    expect(res.headers['content-type']).toMatch(/json/);
  });
});

describe('authentication in the context', () => {
  const principal = { userId: '6adac1d88b38f73bb659ed5f', sessionId: '6adac1d88b38f73bb659ed60' };

  it('rejects requireUser without any token', async () => {
    const res = await gql('{ whoami }');
    expect(res.status).toBe(200); // lỗi nghiệp vụ trả 200, client phân biệt bằng extensions.code
    expect(code(res)).toBe('UNAUTHENTICATED');
  });

  it('accepts the access cookie and the Bearer header', async () => {
    const token = await signAccessToken(principal);
    expect((await gql('{ whoami }', { cookie: `${names.access}=${token}` })).body.data.whoami).toBe(principal.userId);
    expect((await gql('{ whoami }', { bearer: token })).body.data.whoami).toBe(principal.userId);
  });

  it('treats an expired token, another audience and a refresh token as not logged in', async () => {
    const key = new TextEncoder().encode(process.env.JWT_SECRET);
    const sign = (aud: string, exp: number) =>
      new SignJWT({ sid: 's' }).setProtectedHeader({ alg: 'HS256' }).setSubject('u').setIssuer('cmbe').setAudience(aud).setExpirationTime(exp).sign(key);
    const now = Math.floor(Date.now() / 1000);
    for (const token of [await sign('cmbe-clients', now - 60), await sign('someone-else', now + 600), 'opaque-refresh-token-value']) {
      expect(code(await gql('{ whoami }', { cookie: `${names.access}=${token}` }))).toBe('UNAUTHENTICATED');
    }
    // ping không cần đăng nhập nên token xấu không làm hỏng nó
    expect((await gql('{ ping }', { cookie: `${names.access}=garbage` })).body.data.ping).toBe('pong');
  });
});

describe('error mapping', () => {
  it('keeps the AppError code and message', async () => {
    const res = await gql('{ forbidden }');
    expect(res.body.errors[0]).toMatchObject({ message: 'You cannot do that', extensions: { code: 'FORBIDDEN' } });
  });

  it('turns a ZodError into VALIDATION with details', async () => {
    const res = await gql('{ invalid }');
    expect(code(res)).toBe('VALIDATION');
    expect(res.body.errors[0].extensions.details).toBeInstanceOf(Array);
  });

  it('hides the detail and the stack of an unexpected error', async () => {
    const res = await gql('{ crash }');
    expect(res.body.errors[0].message).toBe('Internal server error');
    expect(code(res)).toBe('INTERNAL');
    expect(JSON.stringify(res.body)).not.toMatch(/secret database detail|stacktrace|node_modules/);
  });

  it('passes through the standard GraphQL errors', async () => {
    expect(code(await gql('{ doesNotExist }'))).toBe('GRAPHQL_VALIDATION_FAILED');
    expect(code(await gql('{ ping '))).toBe('GRAPHQL_PARSE_FAILED');
    const coercion = await gql('query($at: DateTime!) { echoDate(at: $at) }', { variables: { at: 5 } });
    expect(coercion.status).toBe(400);
  });
});

describe('scalars', () => {
  it('serializes a Date as an ISO string and parses an ISO string back into a Date', async () => {
    expect((await gql('{ stamp }')).body.data.stamp).toBe('2026-10-23T02:09:28.705Z');
    const res = await gql('query($at: DateTime!) { echoDate(at: $at) }', { variables: { at: '2026-10-23T02:09:28.705Z' } });
    expect(res.body.data.echoDate).toBe('2026-10-23T02:09:28.705Z');
    expect((await gql('{ echoDate(at: "2026-10-23T02:09:28Z") }')).body.data.echoDate).toBe('2026-10-23T02:09:28.000Z');
  });

  it.each(['yesterday', '2026-13-45T00:00:00Z', '2026-10-23', '1698000000'])('rejects %s as a DateTime', async (at) => {
    const res = await gql('query($at: DateTime!) { echoDate(at: $at) }', { variables: { at } });
    expect(res.body.errors).toBeDefined();
    expect(res.body.data ?? null).toBeNull();
  });

  it('passes any JSON value through, as a variable or as a literal', async () => {
    const value = { a: [1, 2, { b: null }], c: 'x', d: true };
    expect((await gql('query($v: JSON) { echoJson(value: $v) }', { variables: { v: value } })).body.data.echoJson).toEqual(value);
    expect((await gql('{ echoJson(value: {a: [1, 2.5, "s", true, null], o: {k: 1}}) }')).body.data.echoJson).toEqual({
      a: [1, 2.5, 's', true, null],
      o: { k: 1 },
    });
  });
});

describe('query limits', () => {
  // Truy vấn có đúng `levels` tầng trường: deep, (levels - 2) lần next, rồi value.
  const nest = (levels: number) => `{ deep ${'{ next '.repeat(levels - 2)}{ value }${' }'.repeat(levels - 2)} }`;

  it('allows a query at the maximum depth and rejects one level deeper', async () => {
    expect((await gql(nest(8))).body.errors).toBeUndefined();
    const res = await gql(nest(9));
    expect(res.status).toBe(400);
    expect(res.body.errors[0].message).toMatch(/too deep/);
  });

  it('cannot hide depth inside fragments', async () => {
    const res = await gql(`
      query { deep { ...A } }
      fragment A on Deep { next { ...B } }
      fragment B on Deep { next { ...C } }
      fragment C on Deep { next { ...D } }
      fragment D on Deep { next { ...E } }
      fragment E on Deep { next { ...F } }
      fragment F on Deep { next { ...G } }
      fragment G on Deep { next { ...H } }
      fragment H on Deep { next { value } }`);
    expect(res.status).toBe(400);
    expect(res.body.errors[0].message).toMatch(/too deep/);
  });

  it('rejects aliases that multiply one operation', async () => {
    const aliases = Array.from({ length: 11 }, (_, i) => `a${i}: one`).join(' ');
    const res = await gql(`{ ${aliases} }`);
    expect(res.status).toBe(400);
    expect(res.body.errors[0].message).toMatch(/top-level/);
    expect((await gql(`{ ${aliases.split(' ').slice(0, 10).join(' ')} }`)).body.errors).toBeUndefined();
  });

  it('stops a fragment bomb quickly and survives a fragment cycle', async () => {
    const bomb = `query { ...F0 } ${Array.from({ length: 30 }, (_, i) => `fragment F${i} on Query { ...F${i + 1} ...F${i + 1} }`).join(' ')} fragment F30 on Query { one }`;
    const started = Date.now();
    const res = await gql(bomb);
    expect(res.status).toBe(400);
    expect(Date.now() - started).toBeLessThan(2000);

    const cycle = await gql('query { ...A } fragment A on Query { ...B } fragment B on Query { ...A }');
    expect(cycle.status).toBe(400);
  });
});

describe('introspection', () => {
  const introspection = '{ __schema { types { fields { type { ofType { ofType { ofType { ofType { name } } } } } } } } }';

  it('is allowed when enabled, even though it is deeper than the normal limit', async () => {
    const res = await gql(introspection);
    expect(res.status).toBe(200);
    expect(res.body.data.__schema.types.length).toBeGreaterThan(0);
  });

  it('does not exempt an operation that mixes introspection with ordinary fields', async () => {
    const aliases = Array.from({ length: 11 }, (_, i) => `a${i}: one`).join(' ');
    const res = await gql(`{ __type(name: "Query") { name } ${aliases} }`);
    expect(res.status).toBe(400);
    expect(res.body.errors[0].message).toMatch(/top-level/);
  });

  it('is refused when disabled (production behaviour)', async () => {
    const closed = createApp({ graphql: build({ introspection: false }) });
    const res = await gql('{ __schema { queryType { name } } }', { target: closed });
    expect(res.status).toBe(400);
    expect(res.body.errors[0].extensions.code).toBe('GRAPHQL_VALIDATION_FAILED');
  });
});

describe('transport protection', () => {
  it('refuses a GET without the preflight header (CSRF) and allows it with the header', async () => {
    const blocked = await request(app).get('/graphql').query({ query: '{ ping }' });
    expect(blocked.status).toBe(400);
    const allowed = await request(app).get('/graphql').query({ query: '{ ping }' }).set('Apollo-Require-Preflight', 'true');
    expect(allowed.body.data.ping).toBe('pong');
  });

  it('refuses a body that is not JSON and refuses batching', async () => {
    const text = await request(app).post('/graphql').set('Content-Type', 'text/plain').send('{ ping }');
    expect(text.status).toBeGreaterThanOrEqual(400);
    expect(text.status).toBeLessThan(500);
    const batch = await request(app).post('/graphql').send([{ query: '{ ping }' }, { query: '{ ping }' }]);
    expect(batch.status).toBe(400);
  });

  it('rejects a POST from a disallowed Origin before it reaches GraphQL', async () => {
    const res = await request(app).post('/graphql').set('Origin', 'https://evil.example').send({ query: '{ ping }' });
    expect(res.status).toBe(403);
  });

  it('rate limits per IP', async () => {
    const limited = createApp({ graphql: build(), graphqlRateLimit: 2 });
    expect((await gql('{ ping }', { target: limited })).status).toBe(200);
    expect((await gql('{ ping }', { target: limited })).status).toBe(200);
    expect((await gql('{ ping }', { target: limited })).status).toBe(429);
  });
});

describe('apollo sandbox (development only)', () => {
  const open = createApp({ graphql: build({ sandbox: true }) });

  it('serves the embedded landing page on GET /graphql without the CSP, and keeps the CSP everywhere else', async () => {
    const page = await request(open).get('/graphql').set('Accept', 'text/html');
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toMatch(/html/);
    expect(page.text).toMatch(/apollographql/i);
    expect(page.text).toMatch(/runTelemetry["']?\s*:\s*false/); // không gửi dữ liệu thao tác về Apollo
    expect(page.headers['content-security-policy']).toBeUndefined();

    expect((await request(open).get('/health')).headers['content-security-policy']).toBeDefined();
    const post = await request(open).post('/graphql').send({ query: '{ ping }' });
    expect(post.body.data.ping).toBe('pong');
    expect(post.headers['content-security-policy']).toBeDefined();
  });

  it('is off by default (tests run with NODE_ENV=test): no landing page and the CSP stays on /graphql', async () => {
    const res = await request(app).get('/graphql').set('Accept', 'text/html');
    expect(res.text).not.toMatch(/<html/i);
    expect(res.headers['content-security-policy']).toBeDefined();
  });
});

describe('lifecycle', () => {
  it('starts lazily, can be started and stopped explicitly, and starts again after a stop', async () => {
    const graphql = build();
    await graphql.start();
    await graphql.start(); // gọi lại không sao
    await graphql.stop();
    const again = createApp({ graphql });
    expect((await gql('{ ping }', { target: again })).body.data.ping).toBe('pong');
    await graphql.stop();
  });

  it('fails at startup, not on the first request, when the SDL is broken', () => {
    expect(() => createGraphql({ modules: [{ typeDefs: 'type Broken {', resolvers: {} }], authenticate })).toThrow();
  });
});
