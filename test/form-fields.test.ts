import { describe, expect, it } from 'vitest';
import { isClosed, parseFormBlock, publicView, validateAnswers, visibleFields, type Field } from '../src/modules/cards/responses/form-fields';

// Ô mẫu cho các bài kiểm tra luật trả lời.
const field = (patch: Partial<Field> & Pick<Field, 'id' | 'type' | 'label'>): Field => ({ required: false, ...patch });

const valid = (fields: Field[], raw: Record<string, unknown>) => {
  const result = validateAnswers(fields, raw);
  if ('errors' in result) throw new Error(`unexpected errors: ${JSON.stringify(result.errors)}`);
  return result.answers;
};

describe('parseFormBlock', () => {
  it('reads fields, public list, moderation and deadline from the block props', () => {
    const config = parseFormBlock({
      fields: [
        { id: 'name', type: 'text', label: 'Họ và tên', required: true },
        { id: 'attending', type: 'choice', label: 'Bạn sẽ đến chứ?', required: true, options: ['Có', 'Không'] },
        { id: 'guests', type: 'number', label: 'Số khách', required: true, min: 1, max: 4, showIf: { fieldId: 'attending', equals: 'Có' } },
      ],
      publicList: { enabled: true, nameFieldId: 'name', textFieldId: 'message' },
      moderation: true,
      deadline: '2026-12-31',
    });
    expect(config.fields.map((item) => item.id)).toEqual(['name', 'attending', 'guests']);
    expect(config.fields[2]).toMatchObject({ min: 1, max: 4, showIf: { fieldId: 'attending', equals: 'Có' } });
    expect(config.publicList).toEqual({ enabled: true, nameFieldId: 'name', textFieldId: 'message' });
    expect(config.moderation).toBe(true);
    expect(config.deadline).toBe('2026-12-31');
  });

  it('drops broken fields instead of throwing', () => {
    const config = parseFormBlock({
      fields: [
        { id: 'ok', type: 'text', label: 'Ổn' },
        { id: '', type: 'text', label: 'Thiếu mã' },
        { id: 'bad-type', type: 'rating', label: 'Loại lạ' },
        { id: 'bad-id', type: 'text', label: 'Mã sai dạng' },
        { id: 'no-label', type: 'text', label: '' },
        { id: 'one-option', type: 'choice', label: 'Một phương án', options: ['A'] },
        { id: 'ok', type: 'text', label: 'Trùng mã' },
        { id: 'bad-show', type: 'text', label: 'Trỏ ô không có', showIf: { fieldId: 'missing', equals: 'x' } },
        { Bad: true },
        null,
      ],
      publicList: 'sai',
      moderation: 'sai',
      deadline: '31-12-2026',
    });
    expect(config.fields.map((item) => item.id)).toEqual(['ok']);
    expect(config.publicList).toEqual({ enabled: false, nameFieldId: '', textFieldId: '' });
    expect(config.moderation).toBe(false);
    expect(config.deadline).toBeNull();
    expect(parseFormBlock({ fields: 'sai' }).fields).toEqual([]);
  });

  it('keeps showIf only when it points at a choice or yesno field before it', () => {
    const config = parseFormBlock({
      fields: [
        { id: 'first', type: 'text', label: 'Chữ' },
        { id: 'pick', type: 'yesno', label: 'Có không' },
        { id: 'a', type: 'text', label: 'A', showIf: { fieldId: 'first', equals: 'x' } },
        { id: 'b', type: 'text', label: 'B', showIf: { fieldId: 'pick', equals: 'yes' } },
        { id: 'c', type: 'text', label: 'C', showIf: { fieldId: 'late', equals: 'x' } },
        { id: 'late', type: 'choice', label: 'Muộn', options: ['x', 'y'] },
      ],
    });
    expect(config.fields.find((item) => item.id === 'a')?.showIf).toBeUndefined();
    expect(config.fields.find((item) => item.id === 'b')?.showIf).toEqual({ fieldId: 'pick', equals: 'yes' });
    expect(config.fields.find((item) => item.id === 'c')?.showIf).toBeUndefined();
  });
});

describe('visibleFields', () => {
  const fields: Field[] = [
    field({ id: 'attending', type: 'choice', label: 'Đến?', options: ['Có, tôi sẽ đến', 'Không'] }),
    field({ id: 'guests', type: 'number', label: 'Số khách', min: 1, max: 4, showIf: { fieldId: 'attending', equals: 'Có, tôi sẽ đến' } }),
    field({ id: 'reason', type: 'text', label: 'Lý do', showIf: { fieldId: 'attending', equals: 'Không' } }),
  ];

  it('keeps a field only while its condition matches', () => {
    expect(visibleFields(fields, {}).map((item) => item.id)).toEqual(['attending']);
    expect(visibleFields(fields, { attending: 'Có, tôi sẽ đến' }).map((item) => item.id)).toEqual(['attending', 'guests']);
    expect(visibleFields(fields, { attending: 'Không' }).map((item) => item.id)).toEqual(['attending', 'reason']);
  });

  it('reads yes fields as "yes" and "no"', () => {
    const list: Field[] = [
      field({ id: 'adult', type: 'yesno', label: 'Người lớn?' }),
      field({ id: 'child', type: 'number', label: 'Trẻ em', showIf: { fieldId: 'adult', equals: 'yes' } }),
      field({ id: 'note', type: 'text', label: 'Ghi chú', showIf: { fieldId: 'adult', equals: 'no' } }),
    ];
    expect(visibleFields(list, { adult: true }).map((item) => item.id)).toEqual(['adult', 'child']);
    expect(visibleFields(list, { adult: false }).map((item) => item.id)).toEqual(['adult', 'note']);
  });
});

describe('validateAnswers', () => {
  it('stores only the answered visible fields, in field order, with their labels', () => {
    const fields: Field[] = [
      field({ id: 'name', type: 'text', label: 'Họ và tên', required: true }),
      field({ id: 'skip', type: 'text', label: 'Không trả lời' }),
      field({ id: 'message', type: 'longtext', label: 'Lời chúc', required: true }),
    ];
    expect(valid(fields, { name: '  Lan  ', message: 'Chúc mừng!\nHẹn gặp.' })).toEqual([
      { id: 'name', label: 'Họ và tên', type: 'text', value: 'Lan' },
      { id: 'message', label: 'Lời chúc', type: 'longtext', value: 'Chúc mừng!\nHẹn gặp.' },
    ]);
  });

  it('rejects a missing required field and an empty one', () => {
    const fields: Field[] = [field({ id: 'name', type: 'text', label: 'Tên', required: true })];
    expect(validateAnswers(fields, {})).toEqual({ errors: [{ path: 'name', message: 'This question is required' }] });
    expect(validateAnswers(fields, { name: '   ' })).toEqual({ errors: [{ path: 'name', message: 'This question is required' }] });
  });

  it('drops unknown field ids silently', () => {
    const fields: Field[] = [field({ id: 'name', type: 'text', label: 'Tên' })];
    expect(valid(fields, { name: 'Lan', injected: '<script>' })).toEqual([{ id: 'name', label: 'Tên', type: 'text', value: 'Lan' }]);
  });

  it('limits short text to 200 characters and refuses control characters', () => {
    const fields: Field[] = [field({ id: 'name', type: 'text', label: 'Tên' })];
    expect(valid(fields, { name: 'a'.repeat(200) })[0]?.value).toHaveLength(200);
    expect(validateAnswers(fields, { name: 'a'.repeat(201) })).toEqual({ errors: [{ path: 'name', message: 'At most 200 characters' }] });
    expect(validateAnswers(fields, { name: 'a\u0001b' })).toEqual({ errors: [{ path: 'name', message: 'Control characters are not allowed' }] });
    expect(validateAnswers(fields, { name: 'a\nb' })).toEqual({ errors: [{ path: 'name', message: 'Control characters are not allowed' }] });
  });

  it('allows new lines in long text but no other control characters', () => {
    const fields: Field[] = [field({ id: 'message', type: 'longtext', label: 'Lời' })];
    expect(valid(fields, { message: 'a'.repeat(1000) })[0]?.value).toHaveLength(1000);
    expect(validateAnswers(fields, { message: 'a'.repeat(1001) })).toEqual({ errors: [{ path: 'message', message: 'At most 1000 characters' }] });
    expect(valid(fields, { message: 'a\nb' })[0]?.value).toBe('a\nb');
    expect(validateAnswers(fields, { message: 'a\u0007b' })).toEqual({ errors: [{ path: 'message', message: 'Control characters are not allowed' }] });
  });

  it('accepts a phone number of 6 to 20 allowed characters', () => {
    const fields: Field[] = [field({ id: 'phone', type: 'phone', label: 'Số điện thoại' })];
    expect(valid(fields, { phone: '+84 (0) 912-345.678' })[0]?.value).toBe('+84 (0) 912-345.678');
    expect(validateAnswers(fields, { phone: '12345' })).toEqual({ errors: [{ path: 'phone', message: 'Invalid phone number' }] });
    expect(validateAnswers(fields, { phone: '1'.repeat(21) })).toEqual({ errors: [{ path: 'phone', message: 'Invalid phone number' }] });
    expect(validateAnswers(fields, { phone: '0912abc345' })).toEqual({ errors: [{ path: 'phone', message: 'Invalid phone number' }] });
  });

  it('accepts only real dates', () => {
    const fields: Field[] = [field({ id: 'day', type: 'date', label: 'Ngày' })];
    expect(valid(fields, { day: '2026-02-28' })[0]?.value).toBe('2026-02-28');
    expect(validateAnswers(fields, { day: '2026-02-30' })).toEqual({ errors: [{ path: 'day', message: 'Invalid date' }] });
    expect(validateAnswers(fields, { day: '28/02/2026' })).toEqual({ errors: [{ path: 'day', message: 'Invalid date' }] });
  });

  it('keeps a number as an integer inside its bounds', () => {
    const fields: Field[] = [field({ id: 'guests', type: 'number', label: 'Số khách', min: 1, max: 4 })];
    expect(valid(fields, { guests: 3 })[0]?.value).toBe(3);
    expect(validateAnswers(fields, { guests: 0 })).toEqual({ errors: [{ path: 'guests', message: 'Must be between 1 and 4' }] });
    expect(validateAnswers(fields, { guests: 5 })).toEqual({ errors: [{ path: 'guests', message: 'Must be between 1 and 4' }] });
    expect(validateAnswers(fields, { guests: 2.5 })).toEqual({ errors: [{ path: 'guests', message: 'Must be a whole number' }] });
    expect(validateAnswers(fields, { guests: '2' })).toEqual({ errors: [{ path: 'guests', message: 'Must be a whole number' }] });
  });

  it('uses 0 and 100 when the number field does not set bounds', () => {
    const fields: Field[] = [field({ id: 'count', type: 'number', label: 'Số lượng' })];
    expect(valid(fields, { count: 0 })[0]?.value).toBe(0);
    expect(valid(fields, { count: 100 })[0]?.value).toBe(100);
    expect(validateAnswers(fields, { count: 101 })).toEqual({ errors: [{ path: 'count', message: 'Must be between 0 and 100' }] });
  });

  it('requires a choice to be one of its options', () => {
    const fields: Field[] = [field({ id: 'pick', type: 'choice', label: 'Chọn', options: ['A', 'B'] })];
    expect(valid(fields, { pick: 'A' })[0]?.value).toBe('A');
    expect(validateAnswers(fields, { pick: 'C' })).toEqual({ errors: [{ path: 'pick', message: 'Invalid option' }] });
    expect(validateAnswers(fields, { pick: 1 })).toEqual({ errors: [{ path: 'pick', message: 'Invalid option' }] });
  });

  it('takes a set of distinct options for multiple choice', () => {
    const fields: Field[] = [field({ id: 'pick', type: 'multichoice', label: 'Chọn nhiều', options: ['A', 'B', 'C'] })];
    expect(valid(fields, { pick: ['A', 'C'] })[0]?.value).toEqual(['A', 'C']);
    expect(valid(fields, { pick: [] })).toEqual([]);
    expect(validateAnswers(fields, { pick: ['A', 'A'] })).toEqual({ errors: [{ path: 'pick', message: 'Invalid option' }] });
    expect(validateAnswers(fields, { pick: ['A', 'D'] })).toEqual({ errors: [{ path: 'pick', message: 'Invalid option' }] });
    expect(validateAnswers(fields, { pick: 'A' })).toEqual({ errors: [{ path: 'pick', message: 'Invalid option' }] });
  });

  it('rejects an empty multiple choice when it is required', () => {
    const fields: Field[] = [field({ id: 'pick', type: 'multichoice', label: 'Chọn nhiều', required: true, options: ['A', 'B'] })];
    expect(validateAnswers(fields, { pick: [] })).toEqual({ errors: [{ path: 'pick', message: 'This question is required' }] });
  });

  it('takes a boolean for a yes or no question', () => {
    const fields: Field[] = [field({ id: 'adult', type: 'yesno', label: 'Người lớn?' })];
    expect(valid(fields, { adult: true })[0]?.value).toBe(true);
    expect(valid(fields, { adult: false })[0]?.value).toBe(false);
    expect(validateAnswers(fields, { adult: 'yes' })).toEqual({ errors: [{ path: 'adult', message: 'Must be yes or no' }] });
  });

  it('skips a hidden field: not required and its value is dropped', () => {
    const fields: Field[] = [
      field({ id: 'attending', type: 'choice', label: 'Đến?', options: ['Có', 'Không'] }),
      field({ id: 'guests', type: 'number', label: 'Số khách', required: true, min: 1, max: 4, showIf: { fieldId: 'attending', equals: 'Có' } }),
    ];
    expect(valid(fields, { attending: 'Không', guests: 3 })).toEqual([{ id: 'attending', label: 'Đến?', type: 'choice', value: 'Không' }]);
    expect(valid(fields, { attending: 'Có', guests: 2 })).toHaveLength(2);
    expect(validateAnswers(fields, { attending: 'Có' })).toEqual({ errors: [{ path: 'guests', message: 'This question is required' }] });
  });

  it('reports every invalid field at once', () => {
    const fields: Field[] = [
      field({ id: 'name', type: 'text', label: 'Tên', required: true }),
      field({ id: 'phone', type: 'phone', label: 'SĐT' }),
    ];
    expect(validateAnswers(fields, { phone: 'abc' })).toEqual({
      errors: [
        { path: 'name', message: 'This question is required' },
        { path: 'phone', message: 'Invalid phone number' },
      ],
    });
  });
});

describe('isClosed', () => {
  it('is open until the end of the deadline day in Vietnam time', () => {
    expect(isClosed('2026-12-31', new Date('2026-12-31T16:59:59.999Z'))).toBe(false);
    expect(isClosed('2026-12-31', new Date('2026-12-31T17:00:00.000Z'))).toBe(true);
  });

  it('treats an empty or impossible deadline as no deadline', () => {
    expect(isClosed(null, new Date('2030-01-01T00:00:00Z'))).toBe(false);
    expect(isClosed('2026-02-30', new Date('2030-01-01T00:00:00Z'))).toBe(false);
  });
});

describe('publicView', () => {
  const answers = [
    { id: 'name', label: 'Tên', type: 'text' as const, value: 'Lan' },
    { id: 'message', label: 'Lời', type: 'longtext' as const, value: 'Chúc mừng!' },
  ];

  it('reads the name and the text from the chosen fields', () => {
    expect(publicView(answers, { enabled: true, nameFieldId: 'name', textFieldId: 'message' })).toEqual({ name: 'Lan', text: 'Chúc mừng!' });
  });

  it('is nothing when the list is off or the fields are missing', () => {
    expect(publicView(answers, { enabled: false, nameFieldId: 'name', textFieldId: 'message' })).toBeNull();
    expect(publicView(answers, { enabled: true, nameFieldId: 'missing', textFieldId: 'message' })).toBeNull();
    expect(publicView(answers, { enabled: true, nameFieldId: 'name', textFieldId: '' })).toBeNull();
  });
});
