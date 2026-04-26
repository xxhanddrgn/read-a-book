// 우리 반 책장 — Zero-dependency static file server (Railway 호환)
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    return res.end('Method Not Allowed');
  }

  // /healthz 헬스체크
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }

  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';

  // path traversal 방지
  const filePath = path.normalize(path.join(ROOT, urlPath));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.stat(filePath, (err, stat) => {
    const sendIndex = () => {
      const idx = path.join(ROOT, 'index.html');
      fs.readFile(idx, (e, data) => {
        if (e) {
          res.writeHead(500);
          return res.end('Server Error');
        }
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(data);
      });
    };

    if (err || !stat.isFile()) return sendIndex(); // SPA 폴백

    fs.readFile(filePath, (e, data) => {
      if (e) {
        res.writeHead(500);
        return res.end('Server Error');
      }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
      });
      res.end(data);
    });
  });
});

server.listen(PORT, HOST, () => {
  console.log(`📚 우리 반 책장 listening on http://${HOST}:${PORT}`);
});
