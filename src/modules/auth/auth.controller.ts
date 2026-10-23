import type { Request, RequestHandler } from 'express';
import type { LoginBody, RegisterBody, ResendVerificationBody, VerifyEmailBody } from './auth.schema';
import * as authService from './auth.service';
import { clearAuthCookies, names, setAuthCookies } from './cookies';

export const clientMeta = (req: Request): authService.SessionMeta => ({
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

export const verifyEmail: RequestHandler = async (_req, res) => {
  await authService.verifyEmail((res.locals.body as VerifyEmailBody).token);
  res.json({ emailVerified: true });
};

export const resendVerification: RequestHandler = async (_req, res) => {
  await authService.resendVerification((res.locals.body as ResendVerificationBody).email);
  // Cùng một phản hồi cho mọi email, kể cả email không tồn tại hay đã xác minh.
  res.status(202).json({ message: 'If the account exists and is not verified, a new email has been sent.' });
};

export const me: RequestHandler = async (_req, res) => {
  res.json({ user: await authService.getMe(res.locals.auth!.userId) });
};

export const logout: RequestHandler = async (req, res) => {
  await authService.logout(req.cookies?.[names.refresh]);
  clearAuthCookies(res);
  res.status(204).end();
};
