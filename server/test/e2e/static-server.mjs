/**
 * E2E 专用静态服务器：只服务 server/public/workbench。
 * API 全部由 Playwright page.route 提供，不连真实 Base、不需要飞书登录。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../public/workbench');
const PORT = Number(process.env.E2E_PORT || 4173);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
    if (url.pathname === '/' || url.pathname === '/workbench') {
      res.writeHead(302, { location: '/workbench/' });
      res.end();
      return;
    }
    if (!url.pathname.startsWith('/workbench/')) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    const rel = decodeURIComponent(url.pathname.slice('/workbench/'.length)) || 'index.html';
    const full = path.resolve(ROOT, rel);
    if (!full.startsWith(ROOT + path.sep) && full !== ROOT) {
      res.writeHead(403); res.end('forbidden'); return;
    }
    let file = full;
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!fs.existsSync(file)) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  } catch (error) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(String(error?.message || error));
  }
});

server.keepAliveTimeout = 1;
server.listen(PORT, '127.0.0.1', () => {
  console.log(`[e2e] workbench static server http://127.0.0.1:${PORT}/workbench/`);
});
