import { randomUUID } from 'node:crypto';
import { UnrecoverableError, type Worker } from 'bullmq';
import { env } from '../../config/env';
import type { Mailer } from '../../infra/mailer';
import { prisma } from '../../infra/prisma';
import { getQueue, startWorker } from '../../infra/queue';
import { generateOpaqueToken, hashOpaqueToken } from '../../shared/opaque-token';
import { verificationEmail } from './email.templates';

export const EMAIL_QUEUE = 'email';

// Payload chỉ chứa id và loại. TUYỆT ĐỐI không đưa token thô hay link vào đây: nó sẽ nằm trong Redis dạng chữ thường.
export interface EmailJob {
  userId: string;
  purpose: 'EMAIL_VERIFY';
}

// Trang nhận link chưa tồn tại (đang làm: gửi mail, chưa làm: xác nhận), nên đây là địa chỉ giữ chỗ.
export const buildVerificationLink = (token: string): string =>
  `${env.FRONTEND_URL}/verify-email?token=${encodeURIComponent(token)}`;

// Id job lúc đăng ký cố định để một user không bị xếp hai mail đăng ký; BullMQ không cho dấu ':' trong id.
// Gửi lại phải dùng id khác: job cũ còn lưu trong thời gian removeOnComplete và BullMQ lặng lẽ bỏ qua id trùng.
export async function enqueueVerificationEmail(userId: string, options: { resend?: boolean } = {}): Promise<void> {
  await getQueue<EmailJob>(EMAIL_QUEUE).add(
    'verification',
    { userId, purpose: 'EMAIL_VERIFY' },
    { jobId: options.resend ? `verify-email-resend-${userId}-${randomUUID()}` : `verify-email-${userId}` },
  );
}

// Thân của bộ xử lý job. Token được tạo ngay lúc gửi, nên mỗi lần thử lại là một token mới.
// Cố ý KHÔNG xóa token khi gửi lỗi: SMTP có thể đã nhận thư rồi mới đứt kết nối, xóa sẽ làm chết link người dùng đã nhận.
// Token chỉ lưu hash nên để lại vô hại và tự hết hạn; hệ quả là có thể có hai link cùng hợp lệ.
export async function sendVerificationEmail(userId: string, mailer: Mailer): Promise<'sent' | 'skipped'> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || user.emailVerifiedAt) return 'skipped';

  const token = generateOpaqueToken();
  await prisma.verificationToken.create({
    data: {
      userId: user.id,
      purpose: 'EMAIL_VERIFY',
      email: user.email,
      tokenHash: hashOpaqueToken(token),
      expiresAt: new Date(Date.now() + env.emailVerifyTtlMs),
    },
  });

  const message = verificationEmail({
    name: user.name,
    link: buildVerificationLink(token),
    expiresInHours: Math.round(env.emailVerifyTtlMs / 3_600_000),
  });
  try {
    await mailer.send({ to: user.email, ...message });
  } catch (err) {
    // Sai thông tin đăng nhập Gmail là lỗi vĩnh viễn: thử lại năm lần chỉ làm chậm việc báo lỗi.
    if ((err as { code?: string }).code === 'EAUTH') throw new UnrecoverableError('mail authentication failed');
    throw err;
  }
  return 'sent';
}

// Gửi chậm và ít: Gmail cá nhân giới hạn khoảng 500 người nhận mỗi ngày.
export function startEmailWorker(mailer: Mailer): Worker<EmailJob> {
  return startWorker<EmailJob>(
    EMAIL_QUEUE,
    async (job) => {
      if (job.data.purpose !== 'EMAIL_VERIFY') throw new UnrecoverableError(`unknown email purpose: ${String(job.data.purpose)}`);
      return sendVerificationEmail(job.data.userId, mailer);
    },
    { concurrency: 2, limiter: { max: 5, duration: 1_000 } },
  );
}
