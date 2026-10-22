import { createHash, randomBytes } from 'node:crypto';

// Token ngẫu nhiên đủ mạnh nên chỉ cần SHA-256 (không cần argon2) để lưu vào database.
export const generateOpaqueToken = (): string => randomBytes(32).toString('base64url');

export const hashOpaqueToken = (token: string): string => createHash('sha256').update(token).digest('hex');
