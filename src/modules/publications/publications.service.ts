import { prisma } from '../../infra/prisma';
import { AppError } from '../../shared/errors';

export interface PublicPage {
  slug: string;
  title: string;
  document: unknown;
  publishedAt: Date;
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Trang công khai theo slug: không cần đăng nhập, chỉ trả những gì khách cần thấy (không có chủ thiệp, id thiệp, thành viên).
// Slug sai dạng, không có, hoặc đã gỡ đều là NOT_FOUND cùng một thông điệp.
export async function getPublicPage(slug: string): Promise<PublicPage> {
  if (!SLUG.test(slug) || slug.length > 60) throw new AppError('NOT_FOUND', 'Page not found');
  const publication = await prisma.publication.findFirst({
    where: { slug, OR: [{ unpublishedAt: null }, { unpublishedAt: { isSet: false } }] },
    include: { card: { select: { title: true } } },
  });
  if (!publication) throw new AppError('NOT_FOUND', 'Page not found');
  return { slug: publication.slug, title: publication.card.title, document: publication.document, publishedAt: publication.publishedAt };
}
