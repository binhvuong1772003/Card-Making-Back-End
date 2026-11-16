import { z } from 'zod';
import { AppError } from '../../../shared/errors';

// Luật đầu vào của khách mời. GraphQL chỉ kiểm kiểu; luật về nội dung nằm ở đây.
export const GUEST_LIMITS = {
  maxPerCard: 500,
  maxPerRequest: 200,
  name: 80,
  greeting: 200,
  inviteMessage: 400,
};

// Mã công khai: 8 ký tự bỏ các chữ dễ nhầm (0/O, 1/I/L). 31^8 ≈ 8,5e11, đủ để không đoán được.
export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const CODE_LENGTH = 8;
const CODE_PATTERN = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);
export const parseGuestCode = (value: unknown): string => {
  const code = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!CODE_PATTERN.test(code)) throw new AppError('NOT_FOUND', 'Guest not found');
  return code;
};

const text = (max: number) => z.string().trim().max(max);
// Chuỗi rỗng sau khi cắt khoảng trắng coi như không đặt.
const optionalText = (max: number) => text(max).transform((value) => (value === '' ? null : value)).nullable().optional();

export const guestEntry = z.object({
  name: text(GUEST_LIMITS.name).min(1),
  greeting: optionalText(GUEST_LIMITS.greeting),
  inviteMessage: optionalText(GUEST_LIMITS.inviteMessage),
});
export type GuestEntry = z.infer<typeof guestEntry>;

export const guestEntries = z.array(guestEntry).min(1).max(GUEST_LIMITS.maxPerRequest);

export const guestPatch = z.object({
  name: text(GUEST_LIMITS.name).min(1).optional(),
  greeting: optionalText(GUEST_LIMITS.greeting),
  inviteMessage: optionalText(GUEST_LIMITS.inviteMessage),
});
export type GuestPatch = z.infer<typeof guestPatch>;

export const guestSearch = z.string().trim().max(80).optional();

const OBJECT_ID = /^[0-9a-f]{24}$/i;
export function parseGuestId(value: unknown): string {
  if (typeof value !== 'string' || !OBJECT_ID.test(value)) throw new AppError('NOT_FOUND', 'Not found');
  return value;
}
