import type { RequestHandler } from 'express';
import { authenticate } from './authenticate';

export const requireAuth: RequestHandler = async (req, res, next) => {
  res.locals.auth = await authenticate({ authorization: req.get('authorization'), cookies: req.cookies });
  next();
};
