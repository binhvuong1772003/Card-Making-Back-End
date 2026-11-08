// Luật của khối `Form` (form tuỳ biến) ở phía server: đọc cấu hình ô từ BẢN ĐÃ XUẤT BẢN và kiểm câu trả lời của khách. Không Prisma,
// không Express để test được thuần. Hợp đồng với frontend (`CMFE/lib/cards/forms/fields.ts`): đổi bên nào phải đổi bên kia.

export const FIELD_TYPES = ['text', 'longtext', 'choice', 'multichoice', 'number', 'yesno', 'date', 'phone'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export interface ShowIf {
  fieldId: string;
  /** Chuỗi phương án của ô `choice`, hoặc "yes"/"no" của ô `yesno`. */
  equals: string;
}

export interface Field {
  id: string;
  type: FieldType;
  label: string;
  hint?: string;
  required: boolean;
  /** Chỉ cho `choice`/`multichoice`: 2–20 phương án, không trùng. */
  options?: string[];
  /** Chỉ cho `number`; mặc định 0 và 100. */
  min?: number;
  max?: number;
  showIf?: ShowIf;
}

export interface PublicList {
  enabled: boolean;
  nameFieldId: string;
  textFieldId: string;
}

export interface FormConfig {
  fields: Field[];
  publicList: PublicList;
  moderation: boolean;
  /** "YYYY-MM-DD"; null là không hạn. */
  deadline: string | null;
}

export interface StoredAnswer {
  id: string;
  label: string;
  type: FieldType;
  value: string | number | boolean | string[];
}

export interface FieldError {
  path: string;
  message: string;
}

export type ValidationResult = { answers: StoredAnswer[] } | { errors: FieldError[] };

const ID = /^[a-z0-9_]{1,24}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PHONE = /^[0-9+().\-\s]+$/;
// Chữ ngắn không nhận xuống dòng; đoạn dài chỉ nhận xuống dòng, không nhận ký tự điều khiển khác.
const CONTROL_TEXT = /[\u0000-\u001F\u007F]/;
const CONTROL_LONG = /[\u0000-\u0009\u000B-\u001F\u007F]/;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

// Ô hỏng bị bỏ chứ không làm cả form hỏng: bản xuất bản đã qua kiểm khi xuất bản, nhưng dữ liệu cũ có thể lạc hậu.
function readField(raw: unknown, taken: Set<string>, before: Field[]): Field | null {
  if (!isRecord(raw)) return null;
  const { id, type, label } = raw;
  if (typeof id !== 'string' || !ID.test(id) || taken.has(id)) return null;
  if (typeof type !== 'string' || !(FIELD_TYPES as readonly string[]).includes(type)) return null;
  if (typeof label !== 'string' || label.trim() === '' || label.trim().length > 120) return null;

  const field: Field = { id, type: type as FieldType, label: label.trim(), required: raw.required === true };

  if (typeof raw.hint === 'string' && raw.hint.trim() !== '' && raw.hint.trim().length <= 160) field.hint = raw.hint.trim();

  if (type === 'choice' || type === 'multichoice') {
    const options = readOptions(raw.options);
    if (!options) return null;
    field.options = options;
  }
  if (type === 'number') {
    const bounds = readBounds(raw.min, raw.max);
    field.min = bounds.min;
    field.max = bounds.max;
  }
  const showIf = readShowIf(raw.showIf, before);
  if (showIf) field.showIf = showIf;
  return field;
}

function readOptions(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > 20) return null;
  const options: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') return null;
    const text = item.trim();
    if (text === '' || text.length > 80 || options.includes(text)) return null;
    options.push(text);
  }
  return options;
}

const MAX_BOUND = 1_000_000;

function readBounds(minRaw: unknown, maxRaw: unknown): { min: number; max: number } {
  const min = typeof minRaw === 'number' && Number.isInteger(minRaw) && minRaw >= 0 && minRaw <= MAX_BOUND ? minRaw : 0;
  const max = typeof maxRaw === 'number' && Number.isInteger(maxRaw) && maxRaw >= 0 && maxRaw <= MAX_BOUND ? maxRaw : 100;
  return min <= max ? { min, max } : { min: 0, max: 100 };
}

// Chỉ nhận điều kiện trỏ tới ô `choice`/`yesno` ĐỨNG TRƯỚC: nhờ vậy khi vẽ và khi kiểm chỉ cần một lượt từ trên xuống.
function readShowIf(raw: unknown, before: Field[]): ShowIf | undefined {
  if (!isRecord(raw)) return undefined;
  const fieldId = raw.fieldId;
  const equals = raw.equals;
  if (typeof fieldId !== 'string' || typeof equals !== 'string') return undefined;
  const target = before.find((item) => item.id === fieldId);
  return target && (target.type === 'choice' || target.type === 'yesno') ? { fieldId, equals } : undefined;
}

export function parseFormBlock(props: unknown): FormConfig {
  const block = isRecord(props) ? props : {};
  const fields: Field[] = [];
  const taken = new Set<string>();
  if (Array.isArray(block.fields)) {
    for (const raw of block.fields) {
      if (fields.length >= 20) break;
      const field = readField(raw, taken, fields);
      if (field) {
        fields.push(field);
        taken.add(field.id);
      }
    }
  }

  const list = isRecord(block.publicList) ? block.publicList : {};
  const publicList: PublicList = {
    enabled: list.enabled === true,
    nameFieldId: typeof list.nameFieldId === 'string' ? list.nameFieldId : '',
    textFieldId: typeof list.textFieldId === 'string' ? list.textFieldId : '',
  };

  return {
    fields,
    publicList,
    moderation: block.moderation === true,
    deadline: typeof block.deadline === 'string' && DATE.test(block.deadline) ? block.deadline : null,
  };
}

// Đáp án của ô điều kiện, quy về chuỗi: ô yesno thành "yes"/"no". Ô bị ẩn từ trước cũng không đáp án.
function conditionValue(field: Field | undefined, values: Record<string, unknown>): string | undefined {
  if (!field) return undefined;
  const value = values[field.id];
  if (field.type === 'yesno') return value === true ? 'yes' : value === false ? 'no' : undefined;
  return typeof value === 'string' ? value : undefined;
}

export function visibleFields(fields: Field[], values: Record<string, unknown>): Field[] {
  const byId = new Map(fields.map((field) => [field.id, field]));
  const visible: Field[] = [];
  const seen: Record<string, unknown> = {};
  for (const field of fields) {
    const condition = field.showIf;
    if (condition && conditionValue(byId.get(condition.fieldId), seen) !== condition.equals) continue;
    visible.push(field);
    seen[field.id] = values[field.id];
  }
  return visible;
}

const MISSING = Symbol('missing');

type Read = { ok: true; value: string | number | boolean | string[] } | { ok: true; value: typeof MISSING } | { ok: false; message: string };

const same = (value: string | number | boolean | string[]) => (typeof value === 'string' ? value.trim() === '' : Array.isArray(value) && value.length === 0);

function readValue(field: Field, raw: unknown): Read {
  switch (field.type) {
    case 'text':
    case 'longtext': {
      if (raw === undefined || raw === null) return { ok: true, value: MISSING };
      if (typeof raw !== 'string') return { ok: false, message: 'Must be text' };
      const value = raw.trim();
      if (value === '') return { ok: true, value: MISSING };
      const max = field.type === 'text' ? 200 : 1000;
      if (value.length > max) return { ok: false, message: `At most ${max} characters` };
      if ((field.type === 'text' ? CONTROL_TEXT : CONTROL_LONG).test(value)) return { ok: false, message: 'Control characters are not allowed' };
      return { ok: true, value };
    }
    case 'phone': {
      if (raw === undefined || raw === null) return { ok: true, value: MISSING };
      if (typeof raw !== 'string') return { ok: false, message: 'Invalid phone number' };
      const value = raw.trim();
      if (value === '') return { ok: true, value: MISSING };
      if (value.length < 6 || value.length > 20 || !PHONE.test(value)) return { ok: false, message: 'Invalid phone number' };
      return { ok: true, value };
    }
    case 'date': {
      if (raw === undefined || raw === null || raw === '') return { ok: true, value: MISSING };
      if (typeof raw !== 'string' || !DATE.test(raw)) return { ok: false, message: 'Invalid date' };
      const [year, month, day] = raw.split('-').map(Number) as [number, number, number];
      const probe = new Date(Date.UTC(year, month - 1, day));
      if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return { ok: false, message: 'Invalid date' };
      return { ok: true, value: raw };
    }
    case 'number': {
      if (raw === undefined || raw === null) return { ok: true, value: MISSING };
      if (typeof raw !== 'number' || !Number.isInteger(raw)) return { ok: false, message: 'Must be a whole number' };
      const min = field.min ?? 0;
      const max = field.max ?? 100;
      if (raw < min || raw > max) return { ok: false, message: `Must be between ${min} and ${max}` };
      return { ok: true, value: raw };
    }
    case 'choice': {
      if (raw === undefined || raw === null || raw === '') return { ok: true, value: MISSING };
      if (typeof raw !== 'string' || !field.options?.includes(raw)) return { ok: false, message: 'Invalid option' };
      return { ok: true, value: raw };
    }
    case 'multichoice': {
      if (raw === undefined || raw === null) return { ok: true, value: MISSING };
      if (!Array.isArray(raw)) return { ok: false, message: 'Invalid option' };
      const values: string[] = [];
      for (const item of raw) {
        if (typeof item !== 'string' || !field.options?.includes(item) || values.includes(item)) return { ok: false, message: 'Invalid option' };
        values.push(item);
      }
      if (values.length === 0) return field.required ? { ok: false, message: 'This question is required' } : { ok: true, value: MISSING };
      return { ok: true, value: values };
    }
    case 'yesno': {
      if (raw === undefined || raw === null) return { ok: true, value: MISSING };
      if (typeof raw !== 'boolean') return { ok: false, message: 'Must be yes or no' };
      return { ok: true, value: raw };
    }
  }
}

// Trả câu trả lời theo đúng thứ tự ô, chỉ gồm ô đang hiện và đã trả lời, kèm nhãn LÚC TRẢ LỜI: chủ thiệp đổi nhãn sau đó thì câu trả lời cũ vẫn đọc được.
// Ô lạ trong đầu vào bị bỏ; ô bị showIf ẩn thì bỏ qua (không bắt buộc, không lưu giá trị).
export function validateAnswers(fields: Field[], raw: unknown): ValidationResult {
  const values = isRecord(raw) ? raw : {};
  const answers: StoredAnswer[] = [];
  const errors: FieldError[] = [];
  for (const field of visibleFields(fields, values)) {
    const read = readValue(field, values[field.id]);
    if (!read.ok) {
      errors.push({ path: field.id, message: read.message });
      continue;
    }
    if (read.value === MISSING || same(read.value)) {
      if (field.required) errors.push({ path: field.id, message: 'This question is required' });
      continue;
    }
    answers.push({ id: field.id, label: field.label, type: field.type, value: read.value });
  }
  // Lỗi của mọi ô một lượt để giao diện đánh dấu đúng từng ô.
  return errors.length > 0 ? { errors } : { answers };
}

// Hết ngày hạn theo giờ Việt Nam (UTC+7): 23:59:59.999 ngày đó là 16:59:59.999 UTC. Ngày không có thật (30 tháng 2) coi như không có hạn.
export function isClosed(deadline: string | null, now: Date): boolean {
  if (!deadline) return false;
  const [year, month, day] = deadline.split('-').map(Number) as [number, number, number];
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return false;
  return now.getTime() > Date.UTC(year, month - 1, day, 16, 59, 59, 999);
}

// Một dòng của sổ công khai chỉ có tên và lời: không có trạng thái hay mã IP. Thiếu ô tên/lời thì không có gì để hiện.
export function publicView(answers: StoredAnswer[], publicList: PublicList): { name: string; text: string } | null {
  if (!publicList.enabled) return null;
  const name = answers.find((answer) => answer.id === publicList.nameFieldId)?.value;
  const text = answers.find((answer) => answer.id === publicList.textFieldId)?.value;
  return typeof name === 'string' && name !== '' && typeof text === 'string' && text !== '' ? { name, text } : null;
}
