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
import { logger, requestSerializer } from './infra/logger';
import { createAuthRouter } from './modules/auth/auth.routes';
import { defaultGoogleOAuth, type GoogleOAuth } from './modules/auth/google-oauth';

export interface AppOptions {
  authRateLimit?: number;
  // Không truyền: dùng bộ chuyển đổi thật nếu env có cấu hình Google. `null`: tắt Google (test).
  google?: GoogleOAuth | null;
}

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
  app.use('/api/v1', api);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
