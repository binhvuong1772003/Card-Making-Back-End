import { describe, expect, it } from 'vitest';
import { MAX_DOCUMENT_BYTES, parsePageDocument } from '../src/modules/cards/page-document';
import { AppError } from '../src/shared/errors';
import { cardComponents } from '../src/modules/cards/components';
import { albumPage, blockPage, calendarPage, mapPage, samplePage } from './helpers/pages';

const refusal = (input: unknown) => {
  try {
    parsePageDocument(input);
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    return err as AppError;
  }
  throw new Error('expected the page to be refused');
};

describe('parsePageDocument', () => {
  it('accepts a page as the editor saves it and gives it back', () => {
    const page = samplePage('Xin chào');
    expect(parsePageDocument(page)).toEqual(page);
  });

  it('accepts a page with a picture and a share picture', () => {
    const url = 'https://res.cloudinary.com/demo/image/upload/v1/a.png';
    expect(() => parsePageDocument(samplePage('x', { image: url, metaImage: url }))).not.toThrow();
  });

  it('drops the props a block no longer has instead of refusing a page saved before', () => {
    const old = mapPage({ borderStyle: 'Đôi', borderWidth: 3, borderColor: '#511419', radius: 4, filled: true, fill: '#ffffff', shadow: 'Nhẹ', tilt: 2, tape: true });
    const parsed = parsePageDocument(old);
    const map = parsed.root.children.find((child) => child.type === 'Map')!;
    for (const key of ['borderStyle', 'borderWidth', 'borderColor', 'radius', 'filled', 'fill', 'shadow', 'tilt', 'tape']) expect(map.props).not.toHaveProperty(key);
    expect(map.props).toMatchObject({ name: 'White Palace', innerFrame: true, padding: 14 });
    expect(parsePageDocument(calendarPage({ filled: true, fill: '#511419', borderWidth: 2, borderColor: '#511419', radius: 8 }))).toBeTruthy();
    expect(JSON.stringify(old)).toContain('borderStyle'); // trang gốc không bị đổi
  });

  it('accepts a page with an Album block, a kind of CardMaking', () => {
    const url = 'https://res.cloudinary.com/demo/image/upload/v1/a.png';
    const page = albumPage([url, url]);
    expect(parsePageDocument(page)).toEqual(page);
  });

  it('refuses an Album whose interval is out of range', () => {
    const bad = albumPage([]);
    (bad.root.children[1] as { props: Record<string, unknown> }).props.interval = 99;
    expect(refusal(bad).code).toBe('VALIDATION');
  });

  it('accepts a page with a Map block and refuses an option it does not offer or a number out of range', () => {
    const page = mapPage();
    expect(parsePageDocument(page)).toEqual(page);
    expect(refusal(mapPage({ zoom: 99 })).code).toBe('VALIDATION');
    expect(refusal(mapPage({ padding: 99 })).code).toBe('VALIDATION');
  });

  it('accepts a page with a Calendar block and refuses a shape it does not offer or a size out of range', () => {
    const page = calendarPage({ font: "'Great Vibes', cursive" });
    expect(parsePageDocument(page)).toEqual(page);
    expect(refusal(calendarPage({ markShape: 'Rồng' })).code).toBe('VALIDATION');
    expect(refusal(calendarPage({ size: 99 })).code).toBe('VALIDATION');
  });

  it('accepts every block of CardMaking added with its default properties', () => {
    const types = Object.keys(cardComponents);
    expect(types.length).toBeGreaterThanOrEqual(10);
    for (const type of types) {
      const page = blockPage(type, cardComponents[type]!.defaultProps);
      expect(parsePageDocument(page)).toEqual(page);
    }
  });

  it('refuses what is not a page, with VALIDATION and no echo of the data', () => {
    for (const input of [null, 'text', 42, [], {}, { a: 1 }, { schemaVersion: 1 }, { schemaVersion: 1, root: { id: 'root', type: 'Page', children: [] } }]) {
      expect(refusal(input).code).toBe('VALIDATION');
    }
  });

  it('refuses a page made by a newer version', () => {
    expect(refusal({ ...samplePage(), schemaVersion: 99 }).code).toBe('VALIDATION');
  });

  it('refuses a block kind the registry does not know', () => {
    const page = samplePage();
    (page.root.children[0] as { type: string }).type = 'NotABlock';
    expect(refusal(page).code).toBe('VALIDATION');
  });

  // Thiệp lưu trước khi có khối `Form` vẫn còn `Rsvp`/`Guestbook`; mở ra phải thành `Form` chứ không bị từ chối.
  it('opens a page saved with the old Rsvp or Guestbook block as the Form block', () => {
    const rsvp = blockPage('Rsvp', {
      heading: 'Bạn sẽ đến chứ?',
      intro: '',
      button: 'Gửi xác nhận',
      askGuests: true,
      askPhone: false,
      askNote: true,
      askMaybe: true,
      deadline: '',
      maxGuests: 4,
      color: '#511419',
      padding: 16,
    });
    const upgraded = parsePageDocument(rsvp).root.children.find((child) => child.id === 'n9')!;
    expect(upgraded.type).toBe('Form');
    expect(upgraded.props).toMatchObject({ heading: 'Bạn sẽ đến chứ?', button: 'Gửi xác nhận' });
    expect(JSON.stringify(rsvp)).toContain('"Rsvp"'); // trang gốc không bị đổi

    const guestbook = blockPage('Guestbook', { heading: 'Sổ lưu bút', intro: '', button: 'Gửi', moderation: false, pageSize: 5, color: '#511419', padding: 16 });
    expect(parsePageDocument(guestbook).root.children.find((child) => child.id === 'n9')!.type).toBe('Form');
  });

  it('gives a copy of a form (same formId) a key of its own when the page is saved, and leaves unique forms alone', () => {
    const formProps = { formId: 'f_abc', heading: 'Biểu mẫu', intro: '', button: 'Gửi', success: 'Cảm ơn', deadline: '', moderation: false, color: '#511419', padding: 16 };
    const one = blockPage('Form', formProps);
    expect(parsePageDocument(one)).toEqual(one);
    const first = one.root.children.at(-1)!;
    const twice = { ...one, root: { ...one.root, children: [...one.root.children, { ...first, id: 'n10' }] } };
    const kids = parsePageDocument(twice).root.children;
    expect(kids.find((child) => child.id === 'n9')!.props.formId).toBe('f_abc');
    expect(kids.find((child) => child.id === 'n10')!.props.formId).toBe('f_abc_n10');
  });

  it('accepts a calendar with the add to calendar button filled in, and refuses a length out of range', () => {
    const event = { eventButton: 'Thêm vào lịch', eventTitle: 'Tiệc cưới', eventTime: '18:00', eventMinutes: 180, eventPlace: 'Gala Center', eventNote: 'Khai tiệc 18:00' };
    expect(() => parsePageDocument(calendarPage(event))).not.toThrow();
    expect(refusal(calendarPage({ eventMinutes: 5 })).code).toBe('VALIDATION');
    expect(refusal(calendarPage({ eventButton: 'x'.repeat(41) })).code).toBe('VALIDATION');
  });

  it('accepts a photo frame of each kind with a crop and a ring, and refuses a crop or ring out of range', () => {
    const props = { src: 'https://res.cloudinary.com/demo/image/upload/v1/a.png', alt: 'Ảnh cưới', shape: 'heart', zoom: 150, posX: 30, posY: 70, frameWidth: 6, frameColor: '#511419' };
    for (const type of ['PhotoFrameArch', 'PhotoFrameCircle', 'PhotoFrameHeart', 'PhotoFrameScallop', 'PhotoFrameSeal', 'PhotoFrameRounded']) {
      expect(() => parsePageDocument(blockPage(type, props)), type).not.toThrow();
    }
    expect(refusal(blockPage('PhotoFrameArch', { ...props, zoom: 50 })).code).toBe('VALIDATION');
    expect(refusal(blockPage('PhotoFrameArch', { ...props, posX: 101 })).code).toBe('VALIDATION');
    expect(refusal(blockPage('PhotoFrameArch', { ...props, frameWidth: 25 })).code).toBe('VALIDATION');
    expect(refusal(blockPage('PhotoFrameArch', { ...props, src: 'javascript:alert(1)' })).code).toBe('VALIDATION');
    expect(() => parsePageDocument(blockPage('PhotoFrameArch', { ...props, src: '' }))).not.toThrow(); // khung chưa có ảnh
  });

  it('refuses a picture address that is not safe to draw', () => {
    expect(refusal(samplePage('x', { metaImage: 'javascript:alert(1)' })).code).toBe('VALIDATION');
  });

  it('refuses a page bigger than the limit', () => {
    const big = samplePage('x'.repeat(MAX_DOCUMENT_BYTES));
    expect(refusal(big).message).toMatch(/large/i);
  });
});
