const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

// `name` do người dùng nhập nên phải escape trước khi đưa vào HTML.
export function verificationEmail(input: { name: string | null; link: string; expiresInHours: number }): {
  subject: string;
  text: string;
  html: string;
} {
  const greeting = input.name ? `Chào ${input.name}` : 'Chào bạn';
  const expiry = `Liên kết có hiệu lực trong ${input.expiresInHours} giờ.`;
  const ignore = 'Nếu bạn không đăng ký tài khoản CardMaking, hãy bỏ qua email này.';

  return {
    subject: 'Xác nhận email đăng ký CardMaking',
    text: [
      `${greeting},`,
      '',
      'Cảm ơn bạn đã đăng ký CardMaking. Mở liên kết dưới đây để xác nhận địa chỉ email:',
      input.link,
      '',
      expiry,
      ignore,
    ].join('\n'),
    html: [
      `<p>${escapeHtml(greeting)},</p>`,
      '<p>Cảm ơn bạn đã đăng ký CardMaking. Bấm vào nút dưới đây để xác nhận địa chỉ email:</p>',
      `<p><a href="${escapeHtml(input.link)}">Xác nhận email</a></p>`,
      `<p>${escapeHtml(expiry)}<br>${escapeHtml(ignore)}</p>`,
    ].join('\n'),
  };
}
