import { randomUUID } from 'node:crypto';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { Router } from 'express';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { env } from './config/env';
import { errorHandler, notFoundHandler } from './http/error-handler';
import { originCheck } from './http/origin';
import systemRoutes from './http/system.routes';
import { createGraphql, type Graphql } from './graphql/create-graphql';
import { rateLimiter } from './http/rate-limit';
import { logger, requestSerializer } from './infra/logger';
import { createAssetsRouter } from './modules/assets/assets.routes';
import type { CloudinaryConfig } from './modules/assets/assets.service';
import { authenticate } from './modules/auth/authenticate';
import { requireAuth } from './modules/auth/auth.middleware';
import { createAuthRouter } from './modules/auth/auth.routes';
import { cardsModule } from './modules/cards/cards.resolvers';
import { galleryModule } from './modules/cards/gallery/gallery.resolvers';
import { responsesModule } from './modules/cards/responses/responses.resolvers';
import { createResponsesRouter, formResponsesCsv } from './modules/cards/responses/responses.routes';
import { publishingModule } from './modules/cards/publishing/publishing.resolvers';
import { createPublicationsRouter } from './modules/publications/publications.routes';
import { defaultGoogleOAuth, type GoogleOAuth } from './modules/auth/google-oauth';

export interface AppOptions {
  authRateLimit?: number;
  // Không truyền: dùng bộ chuyển đổi thật nếu env có cấu hình Google. `null`: tắt Google (test).
  google?: GoogleOAuth | null;
  // Không truyền: dùng bản mặc định (defaultGraphql). Test truyền bản có module giả.
  graphql?: Graphql;
  graphqlRateLimit?: number;
  // Không truyền: dùng cấu hình Cloudinary của env. `null`: tắt kho ảnh (test).
  cloudinary?: CloudinaryConfig | null;
  assetsRateLimit?: number;
  assetsUserHourlyLimit?: number;
  assetsUserDailyLimit?: number;
  publicRateLimit?: number;
  formsHourlyLimit?: number;
}

// Nơi ghép các module GraphQL; thêm module mới vào mảng này.
export const defaultGraphql = (): Graphql => createGraphql({ modules: [cardsModule, publishingModule, galleryModule, responsesModule], authenticate });

const REQUEST_ID = /^[\w.-]{1,100}$/;

export function createApp(options: AppOptions = {}): express.Express {
  const app = express();
  app.set('trust proxy', env.TRUST_PROXY);

  app.use(helmet());
  app.use(
    pinoHttp({
      logger,
      serializers: { req: requestSerializer },
      genReqId: (req, res) => {
        const incoming = req.headers['x-request-id'];
        const id = typeof incoming === 'string' && REQUEST_ID.test(incoming) ? incoming : randomUUID();
        res.setHeader('x-request-id', id);
        return id;
      },
    }),
  );
  app.use(cors({ origin: env.CORS_ORIGINS, credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use(originCheck);

  app.use(systemRoutes);

  const api = Router();
  api.use('/auth', createAuthRouter({
      rateLimit: options.authRateLimit ?? env.AUTH_RATE_LIMIT,
      google: options.google === undefined ? defaultGoogleOAuth() : options.google,
    }),
  );
  api.use('/assets', createAssetsRouter({
    rateLimit: options.assetsRateLimit ?? env.ASSETS_RATE_LIMIT,
    userHourlyLimit: options.assetsUserHourlyLimit ?? env.ASSETS_USER_HOURLY_LIMIT,
    userDailyLimit: options.assetsUserDailyLimit ?? env.ASSETS_USER_DAILY_LIMIT,
    cloudinary: options.cloudinary === undefined ? env.cloudinary : options.cloudinary,
  }));
  api.use('/publications', createPublicationsRouter({ rateLimit: options.publicRateLimit ?? env.PUBLIC_RATE_LIMIT }));
  // Khách gửi câu trả lời form và đọc sổ công khai: công khai, cùng tiền tố với trang công khai.
  api.use('/publications', createResponsesRouter({
    publicRateLimit: options.publicRateLimit ?? env.PUBLIC_RATE_LIMIT,
    formsHourlyLimit: options.formsHourlyLimit ?? env.FORMS_HOURLY_LIMIT,
  }));
  // Tải câu trả lời của một form thành CSV: cần đăng nhập; quyền xem được kiểm trong service.
  api.get('/cards/:id/forms/:blockId/responses.csv', requireAuth, formResponsesCsv);
  app.use('/api/v1', api);

  const graphql = (options.graphql ??= defaultGraphql());
  if (graphql.sandbox) {
    // Trang Sandbox cần script nội tuyến và tải giao diện từ CDN của Apollo nên không chạy dưới CSP mặc định của helmet. Chỉ gỡ CSP
    // của đúng GET /graphql (trang landing), và chỉ khi Sandbox đang bật (dev). Mọi route khác và mọi POST vẫn giữ nguyên CSP.
    app.use('/graphql', (req, res, next) => {
      if (req.method === 'GET') res.removeHeader('Content-Security-Policy');
      next();
    });
  }
  app.use('/graphql', rateLimiter(options.graphqlRateLimit ?? env.GRAPHQL_RATE_LIMIT), graphql.handler);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
