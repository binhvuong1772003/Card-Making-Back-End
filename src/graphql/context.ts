import type { Request } from 'express';
import { AppError } from '../shared/errors';

// Cùng hình dạng với AccessPrincipal của auth, nhưng graphql/ không import module nào nên khai báo lại ở đây.
export interface Principal {
  userId: string;
  sessionId: string;
  exp: number;
}

export interface GraphqlContext {
  principal: Principal | null;
  requestId: string | undefined;
}

export type Authenticate = (input: { authorization?: string; cookies?: Record<string, string | undefined> }) => Promise<Principal>;

// Context được dựng mới cho mỗi request. Không bao giờ ném lỗi vì thiếu hoặc sai token: principal = null, còn việc
// bắt buộc đăng nhập do từng resolver quyết định bằng requireUser (sau này sẽ có thao tác công khai).
export async function buildContext(req: Request, authenticate: Authenticate): Promise<GraphqlContext> {
  const requestId = req.id === undefined ? undefined : String(req.id);
  try {
    const principal = await authenticate({ authorization: req.get('authorization'), cookies: req.cookies });
    return { principal, requestId };
  } catch (err) {
    if (err instanceof AppError && err.code === 'UNAUTHENTICATED') return { principal: null, requestId };
    throw err;
  }
}
