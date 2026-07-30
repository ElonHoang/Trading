// Server tĩnh để xem dashboard ở máy mình: npm run web → http://localhost:5173
//
// Bản web đã tự tính toán hết trong browser (giống hệt khi chạy trên GitHub Pages),
// nên server này KHÔNG có API nào — nó chỉ phục vụ file, đúng như GitHub Pages làm.
// Nhờ vậy những gì bạn thấy ở local giống chính xác những gì lên Pages.
//
// Bot Telegram (npm run bot) vẫn dùng các module trong src/ trực tiếp, không qua server này.

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 5173);
const HOST = process.env.HOST || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

// Chỉ phục vụ những thư mục cần cho trang web; không lộ .env, node_modules, data/...
const ALLOWED_ROOTS = ['web', 'src', 'config', 'models'];
const ALLOWED_FILES = ['index.html', 'favicon.ico', '.nojekyll', 'README.md'];

function isAllowed(relPath) {
  if (ALLOWED_FILES.includes(relPath)) return true;
  const top = relPath.split('/')[0];
  return ALLOWED_ROOTS.includes(top);
}

const server = http.createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Chỉ hỗ trợ GET');
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  if (rel === '' || rel.endsWith('/')) rel += 'index.html';

  // Chống path traversal: đường dẫn tuyệt đối phải nằm trong ROOT.
  const target = path.resolve(ROOT, rel);
  const relFromRoot = path.relative(ROOT, target).split(path.sep).join('/');
  if (relFromRoot.startsWith('..') || path.isAbsolute(relFromRoot) || !isAllowed(relFromRoot)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Không được phép');
    return;
  }

  try {
    const data = await fs.readFile(target);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-store',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`Không tìm thấy: /${relFromRoot}`);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n  Dashboard: http://${HOST}:${PORT}`);
  console.log('  (bản này giống hệt bản trên GitHub Pages — mọi tính toán chạy trong trình duyệt)');
  console.log('  API key Claude nhập ở tab "Cài đặt AI" trong trang.');
  console.log('  Ctrl+C để dừng.\n');
});

process.once('SIGINT', () => { server.close(); process.exit(0); });
process.once('SIGTERM', () => { server.close(); process.exit(0); });
