import type { GraphQLError, GraphQLFormattedError } from 'graphql';
import { ZodError } from 'zod';
import { AppError } from '../shared/errors';

// graphql-js bọc lỗi ném trong resolver vào GraphQLError (có path), và Apollo có thể bọc thêm một lớp nữa: bóc hết các
// lớp GraphQLError còn originalError để tới giá trị thật sự được ném.
// Nhận diện theo hình dạng chứ không theo instanceof/tên lớp: Apollo dùng các lớp con (ValidationError, SyntaxError, ...)
// và dưới vitest graphql có thể được nạp thành hai bản (ESM của test, CJS của Apollo) nên instanceof sai.
export const isGraphQLError = (value: unknown): value is GraphQLError =>
  value instanceof Error && 'extensions' in value && 'locations' in value;

export function unwrapError(error: unknown): unknown {
  let current = error;
  while (isGraphQLError(current) && current.originalError) current = current.originalError;
  return current;
}

// Lỗi của chính GraphQL (cú pháp, sai kiểu, sai schema, vượt giới hạn) không có originalError và đã mang mã chuẩn của
// Apollo: giữ nguyên. Lỗi sinh ra trong resolver thì đổi sang extensions.code của dự án, lỗi lạ thành INTERNAL và
// KHÔNG lộ nội dung (chi tiết chỉ ghi vào log ở plugin).
export function formatError(formatted: GraphQLFormattedError, error: unknown): GraphQLFormattedError {
  const original = unwrapError(error);
  if (isGraphQLError(original)) return formatted; // lỗi của chính GraphQL: không có lỗi nào bên dưới

  if (original instanceof AppError) {
    return {
      ...formatted,
      message: original.message,
      extensions: { code: original.code, ...(original.details === undefined ? {} : { details: original.details }) },
    };
  }
  if (original instanceof ZodError) {
    const details = original.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
    return { ...formatted, message: 'Invalid request', extensions: { code: 'VALIDATION', details } };
  }
  return { ...formatted, message: 'Internal server error', extensions: { code: 'INTERNAL' } };
}
