import type { MailMessage, Mailer } from '../../src/infra/mailer';

// Mailer ghi nhớ thư vào mảng thay vì gửi đi; `failWith` làm mọi lần gửi lỗi với lỗi cho trước.
export function createMemoryMailer(options: { failWith?: Error } = {}): Mailer & { sent: MailMessage[] } {
  const sent: MailMessage[] = [];
  return {
    sent,
    async send(message) {
      if (options.failWith) throw options.failWith;
      sent.push(message);
    },
  };
}
