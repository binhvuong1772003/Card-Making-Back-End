import { Prisma, type Card } from '@prisma/client';
import { prisma } from '../../infra/prisma';
import { AppError } from '../../shared/errors';
import { can, roleOf, type CardAccessRole, type CardAction } from './cards.access';
import { decodeCursor, encodeCursor, type CardOccasion, type CreateCardInput, type ListCardsArgs, type UpdateCardTitleInput } from './cards.schema';

// Hình dạng trả cho tầng giao tiếp: không có document (cấu trúc nội dung chưa chốt nên chưa đưa ra API).
export interface CardView {
  id: string;
  title: string;
  revision: number;
  role: CardAccessRole;
  ownerId: string;
  occasion: CardOccasion;
  published: boolean; // có bản xuất bản đang công khai
  createdAt: Date;
  updatedAt: Date;
}

// Chi tiết một thiệp: thêm bản nháp. Hình dạng của document chưa chốt nên chỉ chuyển nguyên xi.
export interface CardDetailView extends CardView {
  document: unknown;
}

export interface CardPage {
  nodes: CardView[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

type CardRow = Pick<Card, 'id' | 'title' | 'revision' | 'ownerId' | 'members' | 'occasion' | 'createdAt' | 'updatedAt'> & {
  publication?: { unpublishedAt: Date | null } | null;
};

// Đủ để biết thiệp đang công khai hay không, không tải bản chụp document của publication.
const WITH_PUBLICATION = { publication: { select: { unpublishedAt: true } } } as const;

function toCardView(card: CardRow, actor: string): CardView {
  const role = roleOf(card, actor);
  if (!role) throw new Error('actor has no role on the card'); // không xảy ra: gọi sau khi chắc chắn có quyền
  return {
    id: card.id,
    title: card.title,
    revision: card.revision,
    role,
    ownerId: card.ownerId,
    occasion: card.occasion ?? 'OTHER', // thiệp cũ chưa có dịp
    published: Boolean(card.publication && !card.publication.unpublishedAt),
    createdAt: card.createdAt,
    updatedAt: card.updatedAt,
  };
}

const isWriteConflict = (err: unknown): boolean =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034';

// Đọc vai trò và kiểm quyền. Người không liên quan nhận NOT_FOUND (không lộ thiệp có tồn tại), người có vai trò nhưng
// không đủ quyền nhận FORBIDDEN. Không tải document (nặng và không cần để kiểm quyền).
async function requireAccess(actor: string, id: string, action: CardAction): Promise<void> {
  const card = await prisma.card.findUnique({ where: { id }, select: { ownerId: true, members: true } });
  const role = card && roleOf(card, actor);
  if (!card || !role) throw new AppError('NOT_FOUND', 'Card not found');
  if (!can(role, action)) throw new AppError('FORBIDDEN', 'You do not have permission to do that');
}

// `actor` là userId của người gọi. Service không biết req, res hay GraphQL.
export async function createCard(actor: string, input: CreateCardInput): Promise<CardView> {
  const card = await prisma.card.create({
    data: {
      ownerId: actor,
      title: input.title,
      occasion: input.occasion ?? 'OTHER',
      document: {}, // giữ chỗ: cấu trúc nội dung thiệp chưa chốt
      revision: 0,
      members: [], // tường minh: bỏ trống thì Prisma không ghi trường này và các bộ lọc none/isEmpty/NOT some không khớp
    },
    omit: { document: true },
  });
  return toCardView(card, actor);
}

// Xung đột ghi (P2034) xảy ra khi hai lệnh ghi đụng cùng một thiệp (đổi tên đồng thời với xóa hoặc với một lần đổi tên khác).
// Là lỗi tạm: thử lại vài lần, nghỉ ngắn và ngẫu nhiên giữa các lần. Chỉ thử một lần thì xóa thiệp đang bị đổi tên liên tục
// vẫn có thể thất bại (đo được: khoảng một nửa số lần xóa trong cuộc đua với bốn lần đổi tên), nên người dùng thấy lỗi nội bộ.
const MAX_ATTEMPTS = 6;
async function withConflictRetry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS || !isWriteConflict(err)) throw err;
      await new Promise((resolve) => setTimeout(resolve, 5 * attempt + Math.random() * 10));
    }
  }
}

// Chỉ đổi tiêu đề: không đụng document hay revision (bản nháp chỉ đổi qua applyOps). updatedAt tự tăng.
export function updateCardTitle(actor: string, id: string, input: UpdateCardTitleInput): Promise<CardView> {
  return withConflictRetry(async () => {
    await requireAccess(actor, id, 'rename'); // thử lại thì kiểm lại: thiệp có thể đã bị xóa (NOT_FOUND)
    try {
      // Lặp lại điều kiện quyền ngay trong lệnh ghi: vai trò bị hạ hoặc thiệp bị xóa giữa lúc kiểm và lúc ghi thì không ghi.
      const card = await prisma.card.update({
        where: { id, OR: [{ ownerId: actor }, { members: { some: { userId: actor, role: 'EDITOR' } } }] },
        data: { title: input.title },
        include: WITH_PUBLICATION,
        omit: { document: true },
      });
      return toCardView(card, actor);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        throw new AppError('NOT_FOUND', 'Card not found');
      }
      throw err;
    }
  });
}

// Xóa thiệp cùng publication và link mời trong một transaction (Prisma trên Mongo không xóa dây chuyền, và Restrict còn
// chặn xóa thiệp khi con còn tồn tại). Mẫu đã đăng từ thiệp này không bị ảnh hưởng.
export async function deleteCard(actor: string, id: string): Promise<void> {
  await withConflictRetry(async () => {
    await requireAccess(actor, id, 'delete'); // thử lại thì kiểm lại: hai lần xóa đồng thời thì lần sau thấy NOT_FOUND
    await prisma.$transaction(async (tx) => {
      await tx.publication.deleteMany({ where: { cardId: id } });
      await tx.cardInvite.deleteMany({ where: { cardId: id } });
      const deleted = await tx.card.deleteMany({ where: { id, ownerId: actor } });
      if (deleted.count === 0) throw new AppError('NOT_FOUND', 'Card not found'); // hoàn tác cả transaction
    });
  });
}

// OTHER gồm cả thiệp chưa có dịp (trường vắng hẳn vì Prisma trên Mongo không ghi null).
const occasionFilter = (occasion: CardOccasion): Prisma.CardWhereInput =>
  occasion === 'OTHER' ? { OR: [{ occasion: 'OTHER' }, { occasion: { isSet: false } }] } : { occasion };

// Thiệp của người gọi: thiệp họ sở hữu và thiệp được chia sẻ. userId luôn là actor, không nhận từ client (không thể xem
// danh sách của người khác). Mới nhất lên đầu; không tải document.
export async function listCards(actor: string, args: ListCardsArgs): Promise<CardPage> {
  const cursor = args.after ? decodeCursor(args.after) : undefined;
  const rows = await prisma.card.findMany({
    where: {
      AND: [
        { OR: [{ ownerId: actor }, { members: { some: { userId: actor } } }] },
        ...(args.occasion ? [occasionFilter(args.occasion)] : []),
        ...(args.search ? [{ title: { contains: args.search, mode: 'insensitive' as const } }] : []),
        ...(cursor
          ? [{ OR: [{ updatedAt: { lt: cursor.updatedAt } }, { updatedAt: cursor.updatedAt, id: { lt: cursor.id } }] }]
          : []),
      ],
    },
    orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    take: args.first + 1, // lấy dư một dòng để biết còn trang sau
    include: WITH_PUBLICATION,
    omit: { document: true },
  });
  const page = rows.slice(0, args.first);
  const last = page[page.length - 1];
  return {
    nodes: page.map((card) => toCardView(card, actor)),
    pageInfo: { hasNextPage: rows.length > args.first, endCursor: last ? encodeCursor(last) : null },
  };
}

// Chi tiết một thiệp kèm bản nháp. Người không liên quan và id không tồn tại cùng nhận NOT_FOUND.
export async function getCard(actor: string, id: string): Promise<CardDetailView> {
  const card = await prisma.card.findUnique({ where: { id }, include: WITH_PUBLICATION });
  const role = card && roleOf(card, actor);
  if (!card || !role || !can(role, 'view')) throw new AppError('NOT_FOUND', 'Card not found');
  return { ...toCardView(card, actor), document: card.document };
}

// Lưu bản nháp: ghi cả PageData một lần, có điều kiện `revision` client đang giữ (và vai trò owner/editor ngay trong điều kiện ghi),
// tăng `revision` thêm 1. `revision` cũ thì CONFLICT và client tải lại. Chưa kiểm cấu trúc PageData, chỉ kiểm là object.
export async function saveCardDocument(actor: string, id: string, revision: number, document: unknown): Promise<{ revision: number }> {
  await requireAccess(actor, id, 'edit');
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    throw new AppError('VALIDATION', 'document must be an object');
  }
  const { count } = await prisma.card.updateMany({
    where: { id, revision, OR: [{ ownerId: actor }, { members: { some: { userId: actor, role: 'EDITOR' } } }] },
    data: { document: document as Prisma.InputJsonObject, revision: { increment: 1 } },
  });
  if (count === 0) throw new AppError('CONFLICT', 'Revision is stale');
  return { revision: revision + 1 };
}


// Nhân bản vào thư viện của người gọi: thiệp mới thuộc về họ, sao chép bản nháp và dịp, revision 0. Ai xem được thiệp đều
// nhân bản được (nội dung họ đã thấy). Ảnh giữ nguyên địa chỉ, không sao chép sang kho của người nhân bản.
const COPY_SUFFIX = ' (bản sao)';
export async function duplicateCard(actor: string, id: string): Promise<CardView> {
  const source = await prisma.card.findUnique({ where: { id } });
  const role = source && roleOf(source, actor);
  if (!source || !role || !can(role, 'view')) throw new AppError('NOT_FOUND', 'Card not found');
  const title = source.title.slice(0, 100 - COPY_SUFFIX.length).trimEnd() + COPY_SUFFIX;
  const copy = await prisma.card.create({
    data: {
      ownerId: actor,
      title,
      occasion: source.occasion ?? 'OTHER',
      document: source.document as Prisma.InputJsonValue,
      revision: 0,
      members: [], // tường minh, xem createCard
    },
    omit: { document: true },
  });
  return toCardView(copy, actor);
}

// Tạo thiệp của người gọi từ một bản chụp có sẵn (dùng mẫu): độc lập với nguồn từ đây, chỉ nhớ `sourceTemplateId`.
// Ảnh trong bản chụp giữ nguyên địa chỉ (mẫu đã đưa ảnh vào thư mục chung lúc duyệt).
export async function createCardFromSnapshot(
  actor: string,
  input: { title: string; occasion: CardOccasion; document: unknown; sourceTemplateId: string },
): Promise<CardView> {
  const card = await prisma.card.create({
    data: {
      ownerId: actor,
      title: input.title,
      occasion: input.occasion,
      document: input.document as Prisma.InputJsonValue,
      revision: 0,
      sourceTemplateId: input.sourceTemplateId,
      members: [], // tường minh, xem createCard
    },
    omit: { document: true },
  });
  return toCardView(card, actor);
}
