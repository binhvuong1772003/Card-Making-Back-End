import { describe, expect, it } from 'vitest';
import { upgradeLegacyForms } from '../src/modules/cards/responses/legacy';

// Khối như editor lưu thật: vị trí, kích thước, kiểu là của khối chứ không phải thuộc tính.
const block = (id: string, type: string, props: Record<string, unknown> = {}) => ({
  id,
  type,
  props,
  styles: { borderWidth: 1, borderColor: '#511419' },
  position: { mode: 'free', x: { anchor: 'scale', start: 10, size: 80 }, y: { anchor: 'start', offset: 400 } },
  size: { w: { kind: 'px', v: 380 }, h: { kind: 'px', v: 560 } },
  rotation: 0,
  children: [],
});
const page = (...children: unknown[]) => ({ schemaVersion: 1, root: { id: 'root', type: 'Page', props: {}, styles: {}, children } });
const root = (children: unknown[]) => page(...children).root as Parameters<typeof upgradeLegacyForms>[0];

describe('upgradeLegacyForms', () => {
  it('turns an old Rsvp block into the attendance Form and keeps its place and look', () => {
    const old = block('n7', 'Rsvp', {
      heading: 'Mời bạn',
      intro: 'Rất mong bạn đến.',
      button: 'Đi nhé',
      askGuests: true,
      askPhone: true,
      askNote: false,
      askMaybe: false,
      deadline: '2026-12-01',
      maxGuests: 6,
      color: '#111111',
      padding: 20,
    });
    const [form] = upgradeLegacyForms(root([old])).children;

    expect(form).toMatchObject({ id: 'n7', type: 'Form', styles: old.styles, position: old.position, size: old.size, rotation: 0 });
    expect(form?.props).toMatchObject({
      heading: 'Mời bạn',
      intro: 'Rất mong bạn đến.',
      button: 'Đi nhé',
      success: 'Cảm ơn bạn, chúng mình đã nhận được xác nhận.',
      deadline: '2026-12-01',
      moderation: false,
      publicList: { enabled: false, nameFieldId: '', textFieldId: '' },
      color: '#111111',
      padding: 20,
    });

    expect(form?.props.fields).toEqual([
      { id: 'name', type: 'text', label: 'Họ và tên', required: true },
      { id: 'attending', type: 'choice', label: 'Bạn sẽ đến chứ?', required: true, options: ['Có, tôi sẽ đến', 'Rất tiếc, không đến được'] },
      {
        id: 'guests',
        type: 'number',
        label: 'Số khách (tính cả bạn)',
        required: true,
        min: 1,
        max: 6,
        showIf: { fieldId: 'attending', equals: 'Có, tôi sẽ đến' },
      },
      { id: 'phone', type: 'phone', label: 'Số điện thoại', required: false },
    ]);
  });

  it('drops the questions the old block had turned off and keeps the notes', () => {
    const old = block('n8', 'Rsvp', { askGuests: false, askNote: true, askMaybe: true });
    const fields = upgradeLegacyForms(root([old])).children[0]?.props.fields as { id: string; options?: string[] }[];

    expect(fields.map((field) => field.id)).toEqual(['name', 'attending', 'note']);
    expect(fields.find((field) => field.id === 'attending')?.options).toEqual(['Có, tôi sẽ đến', 'Rất tiếc, không đến được', 'Chưa chắc']);
  });

  it('turns an old Guestbook block into the wishes Form with its public list on', () => {
    const old = block('n9', 'Guestbook', {
      heading: 'Lời chúc',
      intro: 'Gửi vài dòng.',
      button: 'Gửi',
      moderation: true,
      pageSize: 8,
    });
    const [form] = upgradeLegacyForms(root([old])).children;

    expect(form).toMatchObject({ id: 'n9', type: 'Form' });
    expect(form?.props).toMatchObject({
      heading: 'Lời chúc',
      intro: 'Gửi vài dòng.',
      button: 'Gửi',
      success: 'Cảm ơn bạn. Lời chúc đã hiện trong sổ.',
      moderation: true,
      publicList: { enabled: true, nameFieldId: 'name', textFieldId: 'message' },
    });
    expect(form?.props.fields).toEqual([
      { id: 'name', type: 'text', label: 'Tên của bạn', required: true },
      { id: 'message', type: 'longtext', label: 'Lời chúc', required: true },
    ]);
  });

  it('leaves pages without old blocks exactly as they were', () => {
    const page = root([block('n1', 'Text'), block('n2', 'Form', { fields: [] })]);
    expect(upgradeLegacyForms(page)).toBe(page);
  });
});
