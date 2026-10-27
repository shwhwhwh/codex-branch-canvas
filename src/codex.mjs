import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname, delimiter, resolve, sep, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';

export function resolveCodex(env = process.env) {
  if (env.BRANCH_CANVAS_CODEX_JS) return { command: process.execPath, args: [env.BRANCH_CANVAS_CODEX_JS] };
  const names = process.platform === 'win32' ? ['codex.exe', 'codex.cmd'] : ['codex'];
  for (const folder of (env.PATH || env.Path || '').split(delimiter)) for (const name of names) {
    const candidate = join(folder, name);
    if (!existsSync(candidate)) continue;
    if (name.endsWith('.cmd')) {
      const script = join(dirname(candidate), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
      if (existsSync(script)) return { command: process.execPath, args: [script] };
      continue; // Never pass user prompts through cmd.exe or a PowerShell string.
    }
    return { command: candidate, args: [] };
  }
  throw new Error('未找到 Codex CLI。请安装并登录 Codex，或设置 BRANCH_CANVAS_CODEX_JS。');
}

export class CodexClient extends EventEmitter {
  constructor({ launcher, env = process.env, requestTimeout = 20000, transportArgs = null } = {}) {
    super(); this.launcher = launcher; this.env = env; this.requestTimeout = requestTimeout;
    this.pending = new Map(); this.nextId = 0; this.process = null; this.starting = null; this.schemaCheck = null;
    this.transportArgs = transportArgs;
  }
  async connect() {
    if (this.starting) return this.starting;
    this.starting = this.initialize().catch(error => { this.starting = null; this.close(); throw error; });
    return this.starting;
  }
  async initialize() {
    const launcher = this.launcher || resolveCodex(this.env);
    const args = this.transportArgs || ['--disable', 'apps', '--disable', 'plugins', '-c', 'mcp_servers={}', 'app-server', '--listen', 'stdio://'];
    const child = spawn(launcher.command, [...launcher.args, ...args], {
      windowsHide: true, shell: false, env: { ...this.env, BRANCH_CANVAS_CHILD: '1' }, stdio: ['pipe', 'pipe', 'pipe']
    });
    this.process = child;
    child.stderr.on('data', () => {}); // May contain local paths. Do not expose raw daemon logs to the UI.
    child.on('error', error => this.fail(error));
    child.on('exit', () => { if (this.process === child) { this.process = null; this.starting = null; this.fail(new Error('Codex 连接已关闭。')); } });
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', line => {
      let msg; try { msg = JSON.parse(line); } catch { return; }
      if (msg.method && Object.hasOwn(msg, 'id')) { this.rejectServerRequest(msg); return; }
      if (msg.method) { this.emit('notification', msg); return; }
      const pending = this.pending.get(msg.id); if (!pending) return;
      this.pending.delete(msg.id); clearTimeout(pending.timer);
      if (msg.error) { const error = new Error(msg.error.message || 'Codex 请求失败。'); error.rpcError = true; error.rpcCode = msg.error.code; pending.reject(error); }
      else pending.resolve(msg.result);
    });
    await this.request('initialize', { clientInfo: { name: 'codex_branch_canvas', title: 'Branch Canvas', version: '0.1.1' } });
    this.write({ method: 'initialized', params: {} });
  }
  write(msg) {
    if (!this.process?.stdin.writable) throw new Error('Codex 未连接。');
    this.process.stdin.write(JSON.stringify(msg) + '\n');
  }
  request(method, params, timeout = this.requestTimeout) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => { this.pending.delete(id); const error = new Error(`Codex 请求超时：${method}。结果可能尚未确认，请勿盲目重试。`); error.uncertain = true; reject(error); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  rejectServerRequest(msg) {
    // v0.1 is a read-only discussion client. It never grants escalated permissions.
    const method = msg.method;
    if (/commandExecution\/requestApproval|fileChange\/requestApproval/.test(method)) this.write({ id: msg.id, result: { decision: 'decline' } });
    else if (method === 'item/permissions/requestApproval') this.write({ id: msg.id, result: { permissions: {}, scope: 'turn' } });
    else this.write({ id: msg.id, error: { code: -32601, message: 'Branch Canvas v0.1 does not support this interactive request.' } });
    this.emit('blockedRequest', { method, threadId: msg.params?.threadId });
  }
  fail(error) {
    if (this.pending.size) error.uncertain = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear(); this.emit('disconnected', error);
  }
  close() {
    const child = this.process; this.process = null; this.starting = null;
    if (child) { child.stdin.end(); child.kill(); }
    this.fail(new Error('Codex 连接已停止。'));
  }
  async readConversation(threadId) {
    await this.connect();
    const { thread } = await this.request('thread/read', { threadId });
    if (thread?.id !== threadId) throw new Error('聊天标识不一致。');
    if (thread.historyMode !== 'paginated') {
      const result = await this.request('thread/read', { threadId, includeTurns: true });
      if (result.thread?.id !== threadId) throw new Error('聊天标识不一致。');
      return result.thread;
    }
    const turns = [], seen = new Set(); let cursor;
    do {
      const page = await this.request('thread/turns/list', { threadId, limit: 100, sortDirection: 'asc', itemsView: 'full', ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(page.data)) throw new Error('聊天历史分页无效。');
      turns.push(...page.data); cursor = page.nextCursor;
      if (cursor && seen.has(cursor)) throw new Error('聊天历史分页重复。');
      seen.add(cursor);
    } while (cursor);
    return { ...thread, turns };
  }
  async readThreadHead(threadId) {
    const metadata = await this.request('thread/read', { threadId });
    if (metadata.thread?.id !== threadId) throw new Error('无法确认 Codex 聊天标识，未发送问题。');
    const thread = metadata.thread;
    let tail;
    if (thread.historyMode === 'paginated') {
      const page = await this.request('thread/turns/list', { threadId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' });
      if (!Array.isArray(page.data)) throw new Error('无法确认 Codex 最新回合，未发送问题。');
      tail = page.data[0] || null;
    } else {
      const history = await this.request('thread/read', { threadId, includeTurns: true });
      if (history.thread?.id !== threadId || !Array.isArray(history.thread.turns)) throw new Error('无法确认 Codex 历史，未发送问题。');
      tail = history.thread.turns.at(-1) || null;
      thread.status = history.thread.status;
    }
    return { thread, tail };
  }
  async checkForkSupport() {
    if (this.schemaCheck) return this.schemaCheck;
    this.schemaCheck = (async () => {
      const launcher = this.launcher || resolveCodex(this.env);
      const folder = mkdtempSync(join(tmpdir(), 'branch-canvas-schema-'));
      try {
        await new Promise((resolve, reject) => {
          const child = spawn(launcher.command, [...launcher.args, 'app-server', 'generate-json-schema', '--out', folder], { windowsHide: true, shell: false, env: this.env, stdio: 'ignore' });
          const timer = setTimeout(() => { child.kill(); reject(new Error('读取本机 Codex 协议超时。')); }, 15000);
          child.on('error', error => { clearTimeout(timer); reject(error); });
          child.on('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('无法读取本机 Codex 协议。')); });
        });
        const schema = JSON.parse(readFileSync(join(folder, 'v2', 'ThreadForkParams.json'), 'utf8'));
        if (!schema.properties?.lastTurnId) throw new Error('本机 Codex 不支持从指定回合分支，请升级后再使用真实模式。');
        return true;
      } finally {
        const resolved = resolve(folder), base = resolve(tmpdir());
        if (resolved.startsWith(base + sep) && /^branch-canvas-schema-[\w-]+$/.test(basename(resolved))) rmSync(resolved, { recursive: true, force: true });
      }
    })().catch(error => { this.schemaCheck = null; throw error; });
    return this.schemaCheck;
  }
  async doctor() {
    await this.checkForkSupport(); await this.connect();
    const account = await this.request('account/read', { refreshToken: false });
    const models = await this.request('model/list', {});
    return { connected: true, supportsExactFork: true, signedIn: Boolean(account.account),
      models: (models.data || []).map(model => ({ id: model.id, label: model.displayName || model.id, isDefault: Boolean(model.isDefault) })) };
  }
}
