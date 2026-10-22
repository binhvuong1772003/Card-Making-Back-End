import { AppError } from '../../shared/errors';
import { names } from './cookies';
import { verifyAccessToken, type AccessPrincipal } from './tokens';

export interface AuthInput {
  authorization?: string;
  cookies?: Record<string, string | undefined>;
}

// Hàm dùng chung cho REST, GraphQL và WebSocket: lấy access token từ header Bearer hoặc cookie rồi kiểm tra.
export async function authenticate(input: AuthInput): Promise<AccessPrincipal> {
  const bearer = input.authorization?.startsWith('Bearer ') ? input.authorization.slice(7) : undefined;
  const token = bearer ?? input.cookies?.[names.access];
  if (!token) throw new AppError('UNAUTHENTICATED', 'Authentication required');
  return verifyAccessToken(token);
}
