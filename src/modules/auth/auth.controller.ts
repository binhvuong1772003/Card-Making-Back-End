import type { Request, RequestHandler } from 'express';
import type { LoginBody, RegisterBody } from './auth.schema';
import * as authService from './auth.service';
import { clearAuthCookies, names, setAuthCookies } from './cookies';

const clientMeta = (req: Request): authService.SessionMeta => ({
  userAgent: req.get('user-agent')?.slice(0, 256),
  ip: req.ip,
});

export const register: RequestHandler = async (_req, res) => {
  await authService.register(res.locals.body as RegisterBody);
  // Cùng một phản hồi dù email đã tồn tại hay chưa; người dùng đăng nhập ở bước riêng.
  res.status(202).json({ message: 'Registration received. You can now sign in.' });
};

export const login: RequestHandler = async (req, res) => {
  const { user, session } = await authService.login(res.locals.body as LoginBody, clientMeta(req));
  setAuthCookies(res, session);
  res.json({ user });
};

export const me: RequestHandler = async (_req, res) => {
  res.json({ user: await authService.getMe(res.locals.auth!.userId) });
};

export const logout: RequestHandler = async (req, res) => {
  await authService.logout(req.cookies?.[names.refresh]);
  clearAuthCookies(res);
  res.status(204).end();
};
