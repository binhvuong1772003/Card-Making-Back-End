import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ApolloServer } from '@apollo/server';
import { ApolloServerPluginLandingPageDisabled } from '@apollo/server/plugin/disabled';
import { ApolloServerPluginLandingPageLocalDefault } from '@apollo/server/plugin/landingPage/default';
import type { ApolloServerPlugin } from '@apollo/server';
import { expressMiddleware } from '@as-integrations/express5';
import { makeExecutableSchema } from '@graphql-tools/schema';
import type { RequestHandler } from 'express';
import { ZodError } from 'zod';
import { env } from '../config/env';
import { logger } from '../infra/logger';
import { AppError } from '../shared/errors';
import { buildContext, type Authenticate, type GraphqlContext } from './context';
import { formatError, isGraphQLError, unwrapError } from './errors';
import { defaultLimits, limitsRule, type Limits } from './limits';
import { scalarResolvers } from './scalars';

// Một object resolver (không phải mảng): lấy kiểu từ makeExecutableSchema để khỏi thêm gói @graphql-tools/utils.
type Resolvers = Exclude<NonNullable<Parameters<typeof makeExecutableSchema>[0]['resolvers']>, readonly unknown[]>;

// Mỗi module nộp SDL (đọc từ file .graphql cạnh nó) và resolver. graphql/ không import module nào.
export interface GraphqlModule {
  typeDefs: string;
  resolvers: Resolvers;
}

export interface CreateGraphqlOptions {
  modules: GraphqlModule[];
  authenticate: Authenticate;
  introspection?: boolean; // mặc định: bật ngoài production
  sandbox?: boolean; // Apollo Sandbox nhúng ở GET /graphql; mặc định theo env.graphqlSandbox (chỉ dev)
  limits?: Partial<Limits>;
}

export interface Graphql {
  handler: RequestHandler;
  sandbox: boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
}

const baseTypeDefs = readFileSync(join(__dirname, 'base.graphql'), 'utf8');
const baseResolvers = { ...scalarResolvers, Query: { ping: () => 'pong' } };

// Ghi tên thao tác và mã lỗi, TUYỆT ĐỐI không ghi biến (variables) vì có thể chứa dữ liệu nhạy cảm. Mọi request GraphQL đều
// là POST /graphql trả 200 nên log HTTP không cho biết thao tác nào lỗi.
const loggingPlugin: ApolloServerPlugin<GraphqlContext> = {
  async requestDidStart() {
    const startedAt = Date.now();
    return {
      async didEncounterErrors(ctx) {
        for (const error of ctx.errors) {
          const original = unwrapError(error);
          if (original instanceof Error && !isGraphQLError(original) && !(original instanceof AppError) && !(original instanceof ZodError)) {
            logger.error(
              { reqId: ctx.contextValue.requestId, operation: ctx.operationName, name: original.name, message: original.message },
              'graphql internal error',
            );
          }
        }
      },
      async willSendResponse(ctx) {
        const body = ctx.response.body;
        const errors = body.kind === 'single' ? body.singleResult.errors : undefined;
        logger.info(
          {
            reqId: ctx.contextValue.requestId,
            operation: ctx.operationName ?? null,
            type: ctx.operation?.operation ?? null,
            durationMs: Date.now() - startedAt,
            errorCodes: errors?.map((e) => e.extensions?.code) ?? [],
          },
          'graphql operation',
        );
      },
    };
  },
};

export function createGraphql(options: CreateGraphqlOptions): Graphql {
  // Dựng schema ngay (đồng bộ): SDL hỏng làm createApp thất bại lúc khởi động chứ không đợi request đầu.
  const schema = makeExecutableSchema({
    typeDefs: [baseTypeDefs, ...options.modules.map((m) => m.typeDefs)],
    resolvers: [baseResolvers, ...options.modules.map((m) => m.resolvers)],
  });
  const limits = { ...defaultLimits, ...options.limits };
  const sandbox = options.sandbox ?? env.graphqlSandbox;

  // Apollo bắt buộc start() (bất đồng bộ) trước khi gắn middleware, còn createApp là hàm đồng bộ. Nên khởi động lười ở
  // request đầu và nhớ kết quả; nếu thất bại thì quên đi, request sau dựng lại một ApolloServer mới (server đã hỏng
  // không start lại được). server.ts vẫn gọi start() lúc boot để lỗi cấu hình làm server dừng ngay.
  let booting: Promise<{ server: ApolloServer<GraphqlContext>; middleware: RequestHandler }> | undefined;
  const boot = () =>
    (booting ??= (async () => {
      const server = new ApolloServer<GraphqlContext>({
        schema,
        introspection: options.introspection ?? !env.isProduction,
        csrfPrevention: true,
        allowBatchedHttpRequests: false,
        includeStacktraceInErrorResponses: false, // mặc định của Apollo là CÓ stacktrace ngoài production và test
        hideSchemaDetailsFromClientErrors: env.isProduction,
        status400ForVariableCoercionErrors: true,
        stopOnTerminationSignals: false, // server.ts tự lo thứ tự tắt
        validationRules: [limitsRule(limits)],
        formatError,
        plugins: [
          // Sandbox chỉ ở dev: tải giao diện từ CDN của Apollo, request đi từ trình duyệt tới chính server này (kèm cookie đăng
          // nhập), không gửi dữ liệu thao tác về Apollo (runTelemetry: false). Ngoài dev thì tắt hẳn trang landing.
          sandbox
            ? ApolloServerPluginLandingPageLocalDefault({ embed: { runTelemetry: false, endpointIsEditable: false }, includeCookies: true, footer: false })
            : ApolloServerPluginLandingPageDisabled(),
          loggingPlugin,
        ],
      });
      await server.start();
      const middleware = expressMiddleware(server, { context: async ({ req }) => buildContext(req, options.authenticate) });
      return { server, middleware };
    })().catch((err) => {
      booting = undefined;
      throw err;
    }));

  return {
    sandbox,
    // async: Express 5 chuyển lỗi bị từ chối của handler sang errorHandler thay vì để thành unhandled rejection.
    handler: async (req, res, next) => {
      const { middleware } = await boot();
      return middleware(req, res, next);
    },
    async start() {
      await boot();
    },
    async stop() {
      const current = booting;
      booting = undefined;
      if (current) await (await current.catch(() => undefined))?.server.stop();
    },
  };
}
