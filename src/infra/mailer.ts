import { createTransport, type Transporter } from 'nodemailer';
import { env } from '../config/env';
import { logger } from './logger';

// Điểm thay thế nhà cung cấp gửi mail: Gmail SMTP hôm nay, Resend hoặc SES trước khi mở công khai.
export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

export const createSmtpMailer = (transporter: Transporter, from: string): Mailer => ({
  async send(message) {
    await transporter.sendMail({ from, to: message.to, subject: message.subject, text: message.text, html: message.html });
  },
});

// Chỉ ghi log, không gửi. Nội dung (có link xác thực) chỉ được in ngoài production.
export const createLogMailer = (): Mailer => ({
  async send(message) {
    logger.info(
      env.isProduction ? { to: message.to, subject: message.subject } : { to: message.to, subject: message.subject, text: message.text },
      'mail (log transport, not sent)',
    );
  },
});

function createGmailMailer(): Mailer {
  const transporter = createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user: env.GMAIL_USER, pass: env.GMAIL_APP_PASSWORD },
    connectionTimeout: 10_000,
    socketTimeout: 20_000,
  });
  return createSmtpMailer(transporter, env.mailFrom);
}

let mailer: Mailer | undefined;

export function getMailer(): Mailer {
  mailer ??= env.MAIL_TRANSPORT === 'gmail' ? createGmailMailer() : createLogMailer();
  return mailer;
}
