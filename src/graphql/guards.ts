import { AppError } from '../shared/errors';
import type { GraphqlContext } from './context';

// Chỉ kiểm tra đã đăng nhập; quyền trên từng thiệp do service quyết định. Trả userId để truyền cho service làm actor.
export function requireUser(ctx: GraphqlContext): string {
  if (!ctx.principal) throw new AppError('UNAUTHENTICATED', 'Authentication required');
  return ctx.principal.userId;
}
