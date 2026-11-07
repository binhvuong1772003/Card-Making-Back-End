import { Router } from 'express';
import { rateLimiter } from '../../http/rate-limit';
import { requireAuth } from '../auth/auth.middleware';
import { createSignHandler } from './assets.controller';
import type { CloudinaryConfig } from './assets.service';

export function createAssetsRouter(options: { rateLimit: number; cloudinary: CloudinaryConfig | null }): Router {
  const router = Router();
  router.post('/sign', rateLimiter(options.rateLimit), requireAuth, createSignHandler(options.cloudinary));
  return router;
}
