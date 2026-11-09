import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { prisma } from '../src/infra/prisma';
import { closeQueueing } from '../src/infra/queue';
import { closeRedis } from '../src/infra/redis';
import { createUserWithToken } from './helpers/auth';
import { resetDatabase } from './helpers/database';
import { samplePage } from './helpers/pages';

// Không gọi Cloudinary thật: mỗi ảnh "được sao chép" thành một địa chỉ mới theo thư mục đích.
vi.mock('../src/infra/cloudinary', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/infra/cloudinary')>()),
  copyImage: vi.fn(async (url: string, folder: string) => `https://res.cloudinary.com/test/image/upload/${folder}/${url.split('/').pop()}`),
}));
// Kho ảnh của test là cloud "test", để địa chỉ ảnh trong các trang mẫu khớp với cấu hình.
vi.mock('../src/config/env', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/config/env')>();
  return { ...original, env: { ...original.env, cloudinary: { apiKey: 'k', apiSecret: 's', cloudName: 'test' } } };
});
import { copyImage } from '../src/infra/cloudinary';
import { approveTemplate } from '../src/modules/cards/gallery/gallery.service';

const app = createApp();
const gql = (token: string, query: string, variables?: Record<string, unknown>) =>
  request(app).post('/graphql').set('Authorization', `Bearer ${token}`).send({ query, variables });
const code = (res: request.Response): string | undefined => res.body.errors?.[0]?.extensions?.code;

const PUBLISH = 'mutation($id: ID!, $gallery: Boolean, $pid: ID) { publishCard(id: $id, listInGallery: $gallery, publicationId: $pid) { slug listInGallery galleryStatus galleryRejectReason } }';
// Xuất bản thiệp: cập nhật bản đã có, chưa có thì tạo (mỗi thiệp trong các test này chỉ có một bản).
async function publish(token: string, id: string, gallery?: boolean) {
  const existing = await prisma.publication.findFirst({ where: { cardId: id }, select: { id: true } });
  return gql(token, PUBLISH, { id, gallery, pid: existing?.id });
}
const UNPUBLISH = 'mutation($id: ID!) { unpublishCard(id: $id) }';
const PUBLICATION = 'query($cardId: ID!) { publication(cardId: $cardId) { listInGallery galleryStatus galleryRejectReason } }';
const TEMPLATES = 'query($category: CardOccasion, $first: Int, $after: String) { templates(category: $category, first: $first, after: $after) { nodes { id title category authorName useCount } pageInfo { hasNextPage endCursor } } }';
const COUNTS = 'query { templateCounts { category count } }';
const ADMIN_LIST = 'query($status: TemplateStatus!) { adminTemplates(status: $status) { nodes { id title status authorEmail rejectReason updatedAt snapshot } } }';
const APPROVE = 'mutation($id: ID!) { approveTemplate(id: $id) { id status snapshot } }';
const REJECT = 'mutation($id: ID!, $reason: String!) { rejectTemplate(id: $id, reason: $reason) { id status rejectReason } }';
const REMOVE = 'mutation($id: ID!) { removeTemplate(id: $id) { id status } }';
const USE = 'mutation($id: ID!) { createCardFromTemplate(id: $id) { id title occasion revision role ownerId } }';
const CARD_DOC = 'query($id: ID!) { card(id: $id) { document } }';

const page = (text: string, src?: string) => samplePage(text, { image: src });

beforeEach(async () => {
  await resetDatabase();
  vi.mocked(copyImage).mockClear();
});
afterAll(async () => {
  await resetDatabase();
  await closeQueueing();
  await closeRedis();
  await prisma.$disconnect();
});

const admin = async (email = 'admin@example.com') => {
  const user = await createUserWithToken(email);
  await prisma.user.update({ where: { id: user.id }, data: { role: 'ADMIN' } });
  return user;
};
const seed = (ownerId: string, title: string, occasion: 'WEDDING' | 'BIRTHDAY' | 'EVENT' | 'OTHER' = 'WEDDING', document: object = page('Xin chào')) =>
  prisma.card.create({ data: { ownerId, title, document, revision: 0, members: [], occasion } });
const publishToGallery = async (token: string, cardId: string) => {
  const res = await publish(token, cardId, true);
  expect(res.body.errors).toBeUndefined();
  return prisma.template.findFirstOrThrow({ where: { sourceCardId: cardId }, orderBy: { createdAt: 'desc' } });
};

describe('sending a card to the gallery', () => {
  it('keeps every page when publishing, approving and copying a template', async () => {
    const owner = await createUserWithToken('multipage-template@example.com');
    const image = 'https://res.cloudinary.com/test/image/upload/v1/a.png';
    const envelope = { kind: 'card', version: 1, startPageId: 'p2', pages: [
      { id: 'p1', name: 'Cover', data: page('cover'), interactions: {} },
      { id: 'p2', name: 'Message', data: page('message', image), interactions: {} },
    ] };
    const card = await seed(owner.id, 'Many pages', 'WEDDING', envelope);
    const pending = await publishToGallery(owner.token, card.id);
    expect(pending.snapshot).toEqual(envelope);
    const boss = await admin();
    const approved = await gql(boss.token, APPROVE, { id: pending.id });
    expect(approved.body.errors).toBeUndefined();
    expect(approved.body.data.approveTemplate.snapshot.pages[1].data.root.children[1].props.src).toBe(`https://res.cloudinary.com/test/image/upload/cardmaking/templates/${pending.id}/a.png`);
    const used = await gql(owner.token, USE, { id: pending.id });
    expect(used.body.errors).toBeUndefined();
    const copied = (await prisma.card.findUniqueOrThrow({ where: { id: used.body.data.createCardFromTemplate.id } })).document;
    expect(copied).toEqual(approved.body.data.approveTemplate.snapshot);
  });

  it('queues a pending template with the published snapshot, category and author', async () => {
    const owner = await createUserWithToken('o@example.com');
    await prisma.user.update({ where: { id: owner.id }, data: { name: 'Thu Hà' } });
    const card = await seed(owner.id, 'Lễ cưới Hà', 'WEDDING');
    const res = await publish(owner.token, card.id, true);
    expect(res.body.data.publishCard).toMatchObject({ listInGallery: true, galleryStatus: 'PENDING' });
    const tpl = await prisma.template.findFirstOrThrow({ where: { sourceCardId: card.id } });
    expect(tpl).toMatchObject({ status: 'PENDING', title: 'Lễ cưới Hà', category: 'WEDDING', authorId: owner.id, version: 1 });
    expect(tpl.snapshot).toEqual(page('Xin chào'));
  });

  it('does nothing for the gallery when the switch is off, and a plain publish stays private', async () => {
    const owner = await createUserWithToken('o@example.com');
    const card = await seed(owner.id, 'T');
    const res = await publish(owner.token, card.id);
    expect(res.body.data.publishCard).toMatchObject({ listInGallery: false, galleryStatus: 'NONE' });
    expect(await prisma.template.count()).toBe(0);
  });

  it('replaces the pending snapshot when republished before review instead of queueing a second one', async () => {
    const owner = await createUserWithToken('o@example.com');
    const card = await seed(owner.id, 'T');
    await publishToGallery(owner.token, card.id);
    await prisma.card.update({ where: { id: card.id }, data: { document: page('Bản mới') } });
    await publishToGallery(owner.token, card.id);
    const rows = await prisma.template.findMany({ where: { sourceCardId: card.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.snapshot).toEqual(page('Bản mới'));
  });

  it('withdraws everything when the switch goes off or the page is unpublished', async () => {
    const owner = await createUserWithToken('o@example.com');
    const card = await seed(owner.id, 'T');
    const pending = await publishToGallery(owner.token, card.id);
    await publish(owner.token, card.id, false);
    expect(await prisma.template.findUnique({ where: { id: pending.id } })).toBeNull();

    const live = await publishToGallery(owner.token, card.id);
    const boss = await admin();
    await gql(boss.token, APPROVE, { id: live.id });
    await gql(owner.token, UNPUBLISH, { id: card.id });
    expect((await prisma.template.findUniqueOrThrow({ where: { id: live.id } })).status).toBe('UNLISTED');
    expect((await gql(owner.token, TEMPLATES)).body.data.templates.nodes).toEqual([]);
    expect((await prisma.publication.findFirstOrThrow({ where: { cardId: card.id } })).listInGallery).toBe(false);
  });
});

describe('review', () => {
  it('lets only an admin list, approve, reject or remove', async () => {
    const owner = await createUserWithToken('o@example.com');
    const tpl = await publishToGallery(owner.token, (await seed(owner.id, 'T')).id);
    for (const [query, vars] of [[ADMIN_LIST, { status: 'PENDING' }], [APPROVE, { id: tpl.id }], [REJECT, { id: tpl.id, reason: 'x' }], [REMOVE, { id: tpl.id }]] as const) {
      expect(code(await gql(owner.token, query, vars))).toBe('FORBIDDEN');
    }
    expect((await prisma.template.findUniqueOrThrow({ where: { id: tpl.id } })).status).toBe('PENDING');
  });

  it('shows pending templates to an admin with the author email', async () => {
    const owner = await createUserWithToken('hostess@example.com');
    await publishToGallery(owner.token, (await seed(owner.id, 'T')).id);
    const boss = await admin();
    const res = await gql(boss.token, ADMIN_LIST, { status: 'PENDING' });
    expect(res.body.data.adminTemplates.nodes).toHaveLength(1);
    expect(res.body.data.adminTemplates.nodes[0]).toMatchObject({ title: 'T', status: 'PENDING', authorEmail: 'hostess@example.com' });
    expect(Number.isNaN(Date.parse(res.body.data.adminTemplates.nodes[0].updatedAt))).toBe(false); // lúc gửi hoặc đổi trạng thái gần nhất
  });

  it('approves: the template goes live and appears in the list', async () => {
    const owner = await createUserWithToken('o@example.com');
    const tpl = await publishToGallery(owner.token, (await seed(owner.id, 'Lễ cưới')).id);
    const boss = await admin();
    const res = await gql(boss.token, APPROVE, { id: tpl.id });
    expect(res.body.data.approveTemplate.status).toBe('PUBLISHED');
    const stored = await prisma.template.findUniqueOrThrow({ where: { id: tpl.id } });
    expect(stored).toMatchObject({ status: 'PUBLISHED', reviewedById: boss.id });
    expect(stored.publishedAt).toBeInstanceOf(Date);
    const list = await gql(owner.token, TEMPLATES);
    expect(list.body.data.templates.nodes.map((n: { title: string }) => n.title)).toEqual(['Lễ cưới']);
    expect((await gql(owner.token, PUBLICATION, { cardId: stored.sourceCardId })).body.data.publication.galleryStatus).toBe('LIVE');
  });

  it('refuses to approve something that is not waiting', async () => {
    const owner = await createUserWithToken('o@example.com');
    const tpl = await publishToGallery(owner.token, (await seed(owner.id, 'T')).id);
    const boss = await admin();
    await gql(boss.token, APPROVE, { id: tpl.id });
    expect(code(await gql(boss.token, APPROVE, { id: tpl.id }))).toBe('CONFLICT');
    expect(code(await gql(boss.token, APPROVE, { id: '000000000000000000000000' }))).toBe('NOT_FOUND');
  });

  it('rejects with a reason the author can read, and republishing sends it back for review', async () => {
    const owner = await createUserWithToken('o@example.com');
    const card = await seed(owner.id, 'T');
    const tpl = await publishToGallery(owner.token, card.id);
    const boss = await admin();
    const res = await gql(boss.token, REJECT, { id: tpl.id, reason: 'Có số điện thoại' });
    expect(res.body.data.rejectTemplate).toMatchObject({ status: 'REJECTED', rejectReason: 'Có số điện thoại' });
    expect((await gql(owner.token, TEMPLATES)).body.data.templates.nodes).toEqual([]);
    expect((await gql(owner.token, PUBLICATION, { cardId: card.id })).body.data.publication).toMatchObject({ galleryStatus: 'REJECTED', galleryRejectReason: 'Có số điện thoại' });

    await publish(owner.token, card.id, true);
    const again = await prisma.template.findMany({ where: { sourceCardId: card.id } });
    expect(again).toHaveLength(1);
    expect(again[0]).toMatchObject({ id: tpl.id, status: 'PENDING', rejectReason: null });
  });

  it('needs a reason to reject', async () => {
    const owner = await createUserWithToken('o@example.com');
    const tpl = await publishToGallery(owner.token, (await seed(owner.id, 'T')).id);
    const boss = await admin();
    expect(code(await gql(boss.token, REJECT, { id: tpl.id, reason: '   ' }))).toBe('VALIDATION');
  });

  it('keeps the live template (same id, uses, link) while an edit waits, then replaces it in place on approval', async () => {
    const owner = await createUserWithToken('o@example.com');
    const user = await createUserWithToken('u@example.com');
    const card = await seed(owner.id, 'Cũ', 'WEDDING', page('v1'));
    const live = await publishToGallery(owner.token, card.id);
    const boss = await admin();
    await gql(boss.token, APPROVE, { id: live.id });
    await gql(user.token, USE, { id: live.id }); // one use

    await prisma.card.update({ where: { id: card.id }, data: { title: 'Mới', document: page('v2') } });
    const pending = await publishToGallery(owner.token, card.id);
    expect(pending.id).not.toBe(live.id);
    expect((await gql(owner.token, TEMPLATES)).body.data.templates.nodes.map((n: { title: string }) => n.title)).toEqual(['Cũ']); // old version still shown
    expect((await gql(owner.token, PUBLICATION, { cardId: card.id })).body.data.publication.galleryStatus).toBe('PENDING');

    await gql(boss.token, APPROVE, { id: pending.id });
    expect(await prisma.template.findUnique({ where: { id: pending.id } })).toBeNull();
    const after = await prisma.template.findUniqueOrThrow({ where: { id: live.id } });
    expect(after).toMatchObject({ title: 'Mới', version: 2, status: 'PUBLISHED', useCount: 1 });
    expect(after.snapshot).toEqual(page('v2'));
  });

  it('removes a live template from the gallery without touching cards already made from it', async () => {
    const owner = await createUserWithToken('o@example.com');
    const user = await createUserWithToken('u@example.com');
    const tpl = await publishToGallery(owner.token, (await seed(owner.id, 'T')).id);
    const boss = await admin();
    await gql(boss.token, APPROVE, { id: tpl.id });
    const made = (await gql(user.token, USE, { id: tpl.id })).body.data.createCardFromTemplate;
    expect((await gql(boss.token, REMOVE, { id: tpl.id })).body.data.removeTemplate.status).toBe('REMOVED');
    expect((await gql(user.token, TEMPLATES)).body.data.templates.nodes).toEqual([]);
    expect((await gql(user.token, CARD_DOC, { id: made.id })).body.data.card.document).toEqual(page('Xin chào'));
  });
});

describe('browsing', () => {
  const live = async (ownerId: string, token: string, title: string, occasion: 'WEDDING' | 'BIRTHDAY' | 'EVENT', boss: { token: string }) => {
    const tpl = await publishToGallery(token, (await seed(ownerId, title, occasion)).id);
    await gql(boss.token, APPROVE, { id: tpl.id });
    return tpl;
  };

  it('needs a login, lists only live templates and filters by category', async () => {
    const owner = await createUserWithToken('o@example.com');
    const boss = await admin();
    await live(owner.id, owner.token, 'Cưới 1', 'WEDDING', boss);
    await live(owner.id, owner.token, 'Sinh nhật 1', 'BIRTHDAY', boss);
    await publishToGallery(owner.token, (await seed(owner.id, 'Chưa duyệt', 'EVENT')).id); // pending: hidden
    const all = await gql(owner.token, TEMPLATES);
    expect(all.body.data.templates.nodes.map((n: { title: string }) => n.title).sort()).toEqual(['Cưới 1', 'Sinh nhật 1']);
    const wedding = await gql(owner.token, TEMPLATES, { category: 'WEDDING' });
    expect(wedding.body.data.templates.nodes.map((n: { title: string }) => n.title)).toEqual(['Cưới 1']);
    expect((await request(app).post('/graphql').send({ query: TEMPLATES })).body.errors[0].extensions.code).toBe('UNAUTHENTICATED');
  });

  it('pages newest first with a cursor, and shows a neutral author name when none is set', async () => {
    const owner = await createUserWithToken('private-name@example.com');
    const boss = await admin();
    for (const t of ['A', 'B', 'C']) await live(owner.id, owner.token, t, 'WEDDING', boss);
    const first = await gql(owner.token, TEMPLATES, { first: 2 });
    const nodes = first.body.data.templates.nodes;
    expect(nodes).toHaveLength(2);
    expect(first.body.data.templates.pageInfo.hasNextPage).toBe(true);
    expect(nodes[0].authorName).toBe('Người dùng CardMaking');
    expect(JSON.stringify(first.body)).not.toContain('private-name');
    const second = await gql(owner.token, TEMPLATES, { first: 2, after: first.body.data.templates.pageInfo.endCursor });
    expect(second.body.data.templates.nodes).toHaveLength(1);
    expect(second.body.data.templates.pageInfo.hasNextPage).toBe(false);
    const titles = [...nodes, ...second.body.data.templates.nodes].map((n: { title: string }) => n.title);
    expect(titles).toEqual(['C', 'B', 'A']);
  });

  it('counts live templates per category', async () => {
    const owner = await createUserWithToken('o@example.com');
    const boss = await admin();
    await live(owner.id, owner.token, 'a', 'WEDDING', boss);
    await live(owner.id, owner.token, 'b', 'WEDDING', boss);
    await live(owner.id, owner.token, 'c', 'EVENT', boss);
    const res = await gql(owner.token, COUNTS);
    const byCategory = Object.fromEntries(res.body.data.templateCounts.map((c: { category: string; count: number }) => [c.category, c.count]));
    expect(byCategory).toEqual({ WEDDING: 2, BIRTHDAY: 0, EVENT: 1, OTHER: 0 });
  });
});

describe('createCardFromTemplate', () => {
  it('makes an independent card for the caller and counts the use', async () => {
    const owner = await createUserWithToken('o@example.com');
    const user = await createUserWithToken('u@example.com');
    const boss = await admin();
    const tpl = await publishToGallery(owner.token, (await seed(owner.id, 'Mẫu cưới', 'WEDDING')).id);
    await gql(boss.token, APPROVE, { id: tpl.id });
    const res = await gql(user.token, USE, { id: tpl.id });
    expect(res.body.errors).toBeUndefined();
    const made = res.body.data.createCardFromTemplate;
    expect(made).toMatchObject({ title: 'Mẫu cưới', occasion: 'WEDDING', revision: 0, role: 'OWNER', ownerId: user.id });
    const stored = await prisma.card.findUniqueOrThrow({ where: { id: made.id } });
    expect(stored.sourceTemplateId).toBe(tpl.id);
    expect(stored.document).toEqual(page('Xin chào'));
    expect((await prisma.template.findUniqueOrThrow({ where: { id: tpl.id } })).useCount).toBe(1);
  });

  it('refuses a template that is not live', async () => {
    const owner = await createUserWithToken('o@example.com');
    const tpl = await publishToGallery(owner.token, (await seed(owner.id, 'T')).id); // still pending
    expect(code(await gql(owner.token, USE, { id: tpl.id }))).toBe('NOT_FOUND');
    expect(code(await gql(owner.token, USE, { id: 'not-an-id' }))).toBe('NOT_FOUND');
    expect(await prisma.card.count({ where: { sourceTemplateId: tpl.id } })).toBe(0);
  });
});

describe('images on approval', () => {
  const own = 'https://res.cloudinary.com/test/image/upload/v1/cardmaking/u1/pic.png';
  const outside = 'https://example.com/pic.png';

  it('copies our pictures into the shared template folder and rewrites the snapshot, leaving outside links alone', async () => {
    const owner = await createUserWithToken('o@example.com');
    const card = await seed(owner.id, 'T', 'WEDDING', samplePage(`link ${outside}`, { image: own, metaImage: own }));
    const tpl = await publishToGallery(owner.token, card.id);
    const boss = await admin();
    const res = await gql(boss.token, APPROVE, { id: tpl.id });
    expect(res.body.errors).toBeUndefined();
    expect(vi.mocked(copyImage)).toHaveBeenCalledTimes(1); // one picture, used twice
    expect(vi.mocked(copyImage).mock.calls[0]![1]).toBe(`cardmaking/templates/${tpl.id}`);
    const text = JSON.stringify((await prisma.template.findUniqueOrThrow({ where: { id: tpl.id } })).snapshot);
    expect(text).not.toContain('cardmaking/u1/');
    expect(text).toContain(`cardmaking/templates/${tpl.id}/pic.png`);
    expect(text).toContain(outside);
  });

  it('keeps the template pending when a copy fails', async () => {
    const owner = await createUserWithToken('o@example.com');
    const tpl = await publishToGallery(owner.token, (await seed(owner.id, 'T', 'WEDDING', page('x', own))).id);
    const { AppError } = await import('../src/shared/errors');
    vi.mocked(copyImage).mockRejectedValueOnce(new AppError('PROVIDER_FAILED', 'down'));
    const boss = await admin();
    expect(code(await gql(boss.token, APPROVE, { id: tpl.id }))).toBe('PROVIDER_FAILED');
    expect((await prisma.template.findUniqueOrThrow({ where: { id: tpl.id } })).status).toBe('PENDING');
  });

  it('refuses to approve pictures it cannot copy when image storage is not configured, but approves a page with none', async () => {
    const owner = await createUserWithToken('o@example.com');
    const withPic = await publishToGallery(owner.token, (await seed(owner.id, 'A', 'WEDDING', page('x', own))).id);
    const without = await publishToGallery(owner.token, (await seed(owner.id, 'B')).id);
    const boss = await admin();
    await expect(approveTemplate(boss.id, withPic.id, { cloudinary: null, copy: vi.fn() })).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect((await prisma.template.findUniqueOrThrow({ where: { id: withPic.id } })).status).toBe('PENDING');
    await expect(approveTemplate(boss.id, without.id, { cloudinary: null, copy: vi.fn() })).resolves.toMatchObject({ status: 'PUBLISHED' });
  });
});
