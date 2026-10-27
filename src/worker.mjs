import { createServer } from 'node:net';
import { createInterface } from 'node:readline';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { writeFileSync, readFileSync, unlinkSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { CanvasService } from './service.mjs';

const filename = resolve(process.argv[2]), cwd = process.argv[3];
const service = new CanvasService({ filename, cwd });
const hash = createHash('sha256').update(filename.toLowerCase()).digest('hex').slice(0, 24);
const address = process.platform === 'win32' ? `\\\\.\\pipe\\codex-branch-canvas-${hash}` : filename + '.sock';
const token = randomBytes(32).toString('hex'), metadataPath = filename + '.runtime.json';
const clients = new Set(); let idle, closing = false;
function scheduleIdle() {
  clearTimeout(idle);
  idle = setTimeout(() => { if (!clients.size && !service.active.size) shutdown(); else scheduleIdle(); }, 30000);
}
const server = createServer(socket => {
  clients.add(socket); clearTimeout(idle);
  let buffered = 0;
  socket.on('data', bytes => { buffered += bytes.length; if (buffered > 1000000) socket.destroy(); });
  socket.on('error', () => {});
  socket.on('close', () => { clients.delete(socket); if (!clients.size) scheduleIdle(); });
  createInterface({ input: socket }).on('error', () => {}).on('line', async line => {
    buffered = 0; let request;
    try {
      request = JSON.parse(line);
      const given = Buffer.from(String(request.token || '')), expected = Buffer.from(token);
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new Error('后台访问令牌不匹配。');
      const result = await service.execute(request.action, request.args || {});
      if (!socket.destroyed) socket.write(JSON.stringify({ id: request.id, result }) + '\n');
    } catch (error) { if (!socket.destroyed) socket.write(JSON.stringify({ id: request?.id, error: error.message }) + '\n'); }
  });
});
server.listen(address, () => {
  writeFileSync(metadataPath, JSON.stringify({ version: 1, pid: process.pid, address, token }), { mode: 0o600 });
  if (process.platform !== 'win32') chmodSync(address, 0o600);
  scheduleIdle();
});
async function shutdown() {
  if (closing) return; closing = true; clearTimeout(idle);
  for (const socket of clients) socket.destroy(); server.close(); await service.close();
  try { if (JSON.parse(readFileSync(metadataPath, 'utf8')).pid === process.pid) unlinkSync(metadataPath); } catch {}
  process.exit(0);
}
server.on('error', shutdown); process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
