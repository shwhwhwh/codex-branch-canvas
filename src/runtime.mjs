import { createConnection } from 'node:net';
import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export async function sharedRuntime({ filename, cwd = process.cwd() }) {
  const database = resolve(filename), metadataPath = database + '.runtime.json';
  let launched = false, lastError;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const info = JSON.parse(await readFile(metadataPath, 'utf8'));
      return await connectRuntime(info);
    } catch (error) { lastError = error; }
    if (!launched) {
      launched = true;
      const worker = spawn(process.execPath, [fileURLToPath(new URL('./worker.mjs', import.meta.url)), database, resolve(cwd)], {
        detached: true, windowsHide: true, stdio: 'ignore', env: process.env
      });
      worker.on('error', error => { lastError = error; }); worker.unref();
    }
    await delay(150);
  }
  throw new Error('对话树共享后台无法启动。请检查是否仍有旧版工作区占用这份数据库。' + (lastError?.code ? ` (${lastError.code})` : ''));
}

function connectRuntime(info) {
  return new Promise((resolve, reject) => {
    if (info.version !== 1 || typeof info.token !== 'string' || typeof info.address !== 'string') { reject(new Error('无效的后台信息。')); return; }
    const socket = createConnection(info.address), pending = new Map(); let sequence = 0, ready = false;
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('连接共享后台超时。')); }, 700);
    const request = (action, args = {}) => new Promise((resolveRequest, rejectRequest) => {
      const id = ++sequence;
      const timeout = setTimeout(() => { pending.delete(id); rejectRequest(new Error('共享后台请求结果未确认，请刷新状态后再操作。')); }, 35000);
      pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timeout });
      socket.write(JSON.stringify({ id, token: info.token, action, args }) + '\n');
    });
    socket.on('error', error => { if (!ready) { clearTimeout(timer); reject(error); } });
    socket.on('close', () => { for (const item of pending.values()) { clearTimeout(item.timeout); item.reject(new Error('共享后台连接已关闭。')); } pending.clear(); });
    // readline forwards socket errors on its own emitter as well. A stale pipe
    // must fall through to worker startup instead of terminating the MCP client.
    createInterface({ input: socket }).on('error', () => {}).on('line', line => {
      let message; try { message = JSON.parse(line); } catch { return; }
      const item = pending.get(message.id); if (!item) return;
      pending.delete(message.id); clearTimeout(item.timeout);
      message.error ? item.reject(new Error(message.error)) : item.resolve(message.result);
    });
    socket.once('connect', async () => {
      clearTimeout(timer);
      try {
        await request('state'); ready = true;
        resolve({ execute: request, snapshot: treeId => request('state', { treeId }), close: async () => { socket.end(); } });
      } catch (error) { socket.destroy(); reject(error); }
    });
  });
}
