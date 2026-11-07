// Ảnh trong bản chụp của một trang (PageData). Chỉ ảnh nằm trong kho Cloudinary của mình mới được sao chép: địa chỉ bên ngoài
// giữ nguyên (mình không quản và không nên bắt Cloudinary tải bất kỳ địa chỉ nào).
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const imagePattern = (cloudName: string): RegExp => new RegExp(`^https://res\\.cloudinary\\.com/${escapeRegExp(cloudName)}/image/upload/`);

// Các địa chỉ ảnh của kho mình có trong trang, mỗi địa chỉ một lần, theo thứ tự gặp.
export function collectImageUrls(value: unknown, cloudName: string): string[] {
  const found = new Set<string>();
  const pattern = imagePattern(cloudName);
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      if (pattern.test(node)) found.add(node);
    } else if (Array.isArray(node)) {
      node.forEach(walk);
    } else if (node && typeof node === 'object') {
      Object.values(node).forEach(walk);
    }
  };
  walk(value);
  return [...found];
}

// Bản sao của trang với các địa chỉ trong `map` được thay; trang gốc không bị đổi.
export function replaceImageUrls(value: unknown, map: ReadonlyMap<string, string>): unknown {
  if (typeof value === 'string') return map.get(value) ?? value;
  if (Array.isArray(value)) return value.map((item) => replaceImageUrls(item, map));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceImageUrls(item, map)]));
  }
  return value;
}
