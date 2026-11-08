import type { Registry } from '@miditor/core';
import definitions from './components.json';
import retired from './retired-props.json';

// Các khối riêng của CardMaking, dùng để kiểm trang (`parsePageDocument`). `components.json` do CMFE sinh ra (`npm run blocks:export` ở CMFE,
// từ `lib/cards/blocks/definitions.ts`): không sửa tay. Đổi định nghĩa ở CMFE thì chạy lại lệnh đó, rồi commit cả hai repo; CMFE có một bài test
// (`definitions.test.ts`) báo khi file này đã cũ, nếu không backend từ chối trang mà editor vẫn cho dựng.
export const cardComponents = definitions as unknown as Registry;

// Thuộc tính đã bỏ khỏi từng loại khối (cũng do CMFE sinh ra). Thiệp đã lưu có thể còn giữ chúng; `parsePageDocument` bỏ chúng trước khi kiểm.
export const retiredProps = retired as Record<string, readonly string[]>;
