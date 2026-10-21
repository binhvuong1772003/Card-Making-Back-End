// tsc chỉ biên dịch .ts, nên chép các file .graphql sang dist giữ nguyên đường dẫn tương đối.
// Code đọc SDL bằng __dirname nên chạy được cả từ src (tsx) lẫn dist (node).
const { cpSync, statSync } = require('node:fs');

cpSync('src', 'dist', {
  recursive: true,
  filter: (src) => statSync(src).isDirectory() || src.endsWith('.graphql'),
});
