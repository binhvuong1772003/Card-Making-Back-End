export type ErrorCode =
  | 'VALIDATION'
  | 'UNAUTHENTICATED'
  | 'EMAIL_NOT_VERIFIED'
  | 'TOKEN_INVALID'
  | 'TOKEN_EXPIRED'
  | 'ACCOUNT_CONFLICT'
  | 'REFRESH_CONFLICT'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_FAILED'
  | 'PROVIDER_EMAIL_UNVERIFIED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'INTERNAL';

// Lỗi nghiệp vụ. Mỗi cổng (REST, GraphQL, WebSocket) tự ánh xạ `code` sang dạng của mình.
export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}
