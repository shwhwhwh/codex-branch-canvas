import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { CanvasService } from './service.mjs';
import { sharedRuntime } from './runtime.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
export function createHttpServer(service) {
  const token = randomBytes(24).toString('hex');
  const server = createServer(async (req, res) => {
    const send = (status, body, type = 'application/json; charset=utf-8') => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" });
      res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
    };
    const expectedHosts = [`127.0.0.1:${req.socket.localPort}`, `localhost:${req.socket.localPort}`];
    if (!expectedHosts.includes(req.headers.host)) { send(403, { error: '只允许从本机地址访问。' }); return; }
    if (req.headers.origin && !expectedHosts.map(host => `http://${host}`).includes(req.headers.origin)) { send(403, { error: '请求来源不受信任。' }); return; }
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (req.method === 'GET' && url.pathname === '/') {
        const html = (await readFile(join(root, 'dist', 'index.html'), 'utf8')).replace('__CANVAS_TOKEN__', token);
        send(200, html, 'text/html; charset=utf-8'); return;
      }
      if (req.method === 'GET' && ['/app.js', '/style.css'].includes(url.pathname)) {
        send(200, await readFile(join(root, 'dist', url.pathname.slice(1))), url.pathname.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8'); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/state') { send(200, await service.snapshot(url.searchParams.get('treeId') || undefined)); return; }
      if (req.method === 'POST' && url.pathname === '/api/action') {
        const given = Buffer.from(String(req.headers['x-canvas-token'] || ''));
        if (given.length !== token.length || !timingSafeEqual(given, Buffer.from(token))) { send(403, { error: '请刷新页面后再操作。' }); return; }
        if (!req.headers['content-type']?.startsWith('application/json')) { send(415, { error: '需要 JSON 请求。' }); return; }
        let body = '';
        for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 100000) throw Object.assign(new Error('请求过大。'), { status: 413 }); }
        let data; try { data = JSON.parse(body); } catch { throw Object.assign(new Error('无效的 JSON。'), { status: 400 }); }
        send(200, await service.execute(data.action, data.args)); return;
      }
      send(404, { error: '页面不存在。' });
    } catch (error) { send(error.status || 500, { error: error.message || '操作失败。' }); }
  });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const service = await sharedRuntime({ filename: process.env.BRANCH_CANVAS_DB || join(root, 'data', 'canvas.sqlite'), cwd: process.env.BRANCH_CANVAS_CWD || process.cwd() });
  const server = createHttpServer(service);
  const recordPath = join(root, 'data', 'server.json');
  server.listen(Number(process.env.PORT || 47832), '127.0.0.1', () => {
    try { writeFileSync(recordPath, JSON.stringify({ pid: process.pid, entry: resolve(process.argv[1]) })); } catch {}
    console.log(`Branch Canvas: http://127.0.0.1:${server.address().port}`);
  });
  server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? '端口已被占用，可设置 PORT 后重新启动。' : error.message); process.exitCode = 1; service.close(); });
  const shutdown = async () => {
    server.closeAllConnections(); server.close(); await service.close();
    try { if (JSON.parse(readFileSync(recordPath, 'utf8')).pid === process.pid) unlinkSync(recordPath); } catch {}
    process.exit(0);
  };
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
}
