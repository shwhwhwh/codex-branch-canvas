import { Store, AppError } from './store.mjs';
import { CodexClient, resolveCodex } from './codex.mjs';
import { resolve, isAbsolute } from 'node:path';
import { statSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireDatabaseLock } from './lock.mjs';
import { completedConversation, syncCompletedConversation } from './import.mjs';

const visibleKinds = new Set(['agentMessage', 'commandExecution', 'fileChange', 'mcpToolCall', 'webSearch', 'imageView', 'userMessage', 'plan']);
function text(value, label, max = 20000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new AppError(`${label}不能为空，且最多 ${max} 个字符。`);
  return value.trim();
}

export class CanvasService {
  constructor({ filename, cwd = process.cwd(), client, seed = true, demoDelay = 12 } = {}) {
    const database = filename || resolve('data', 'canvas.sqlite');
    this.releaseLock = acquireDatabaseLock(database);
    try { this.store = new Store(database); } catch (error) { this.releaseLock(); throw error; }
    this.cwd = resolve(cwd); this.client = client || new CodexClient(); this.active = new Map(); this.demoDelay = demoDelay;
    this.closing = false; this.threadLeases = new Map(); this.sourceSyncs = new Map();
    if (seed) this.store.seedDemo(this.cwd);
  }
  status() {
    let codexInstalled = true; try { resolveCodex(); } catch { codexInstalled = false; }
    return { version: '0.1.3', codexInstalled, readOnly: true, cwd: this.cwd, threadPolicy: 'reuse-tail-fork-history-v1' };
  }
  snapshot(treeId) { return { ...this.store.snapshot(treeId), runtime: this.status() }; }
  async execute(action, args = {}) {
    switch (action) {
      case 'state': {
        if (!args.followCurrent || !args.sourceThreadId) return { ...this.snapshot(args.treeId), sourceSync: { available: false } };
        const id = text(args.sourceThreadId, '当前聊天标识', 100);
        let entry = this.sourceSyncs.get(id);
        if (!entry || (!entry.promise && Date.now() - entry.at > 5000)) {
          entry = { at: Date.now() }; this.sourceSyncs.set(id, entry);
          entry.promise = (async () => {
            const thread = await this.client.readConversation(id);
            const conversation = completedConversation(thread, { title: (thread.name || thread.preview || '当前聊天').slice(0, 120), allowEmpty: true });
            entry.result = syncCompletedConversation(this.store.db, conversation);
          })().finally(() => { entry.promise = null; });
        }
        if (entry.promise) await entry.promise;
        if (!entry.result) { this.sourceSyncs.delete(id); throw new AppError('当前聊天同步失败，请重试。'); }
        return { ...this.snapshot(entry.result.treeId), sourceSync: { available: true, sourceThreadId: id, added: entry.result.added, at: entry.at } };
      }
      case 'create_tree': {
        const cwd = args.cwd ? resolve(text(args.cwd, '工作目录', 1000)) : this.cwd;
        if (!isAbsolute(cwd) || !statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) throw new AppError('工作目录不存在。');
        const tree = this.store.createTree({ title: args.title, mode: args.mode, cwd, model: args.model || null });
        return this.snapshot(tree.id);
      }
      case 'select_node': {
        const node = this.store.node(args.nodeId); this.store.select(node.treeId, node.id); return this.snapshot(node.treeId);
      }
      case 'create_branch': {
        const parent = this.store.node(args.parentId);
        this.store.createDraft(parent.treeId, parent.id, args.question || ''); return this.snapshot(parent.treeId);
      }
      case 'save_draft': {
        const node = this.store.saveDraft(args.nodeId, args.question); return { node };
      }
      case 'cancel_draft': {
        const node = this.store.node(args.nodeId); this.store.cancelDraft(node.id); return this.snapshot(node.treeId);
      }
      case 'submit': {
        const question = text(args.question, '问题');
        const key = text(args.requestId, '请求标识', 150);
        const queued = this.store.queue(key, args.nodeId, question);
        if (queued.fresh) {
          const node = this.store.node(args.nodeId);
          const job = { controller: new AbortController(), cancelled: false, done: null };
          this.active.set(node.id, job);
          job.done = this.run(node.id, key, job).finally(() => this.active.delete(node.id));
        }
        return this.snapshot(this.store.node(args.nodeId).treeId);
      }
      case 'stop': {
        const node = this.store.node(args.nodeId), job = this.active.get(node.id);
        if (!job) throw new AppError('该节点没有可停止的本地执行，请先检查运行状态。');
        job.cancelled = true; job.controller.abort();
        if (node.threadId && node.turnId) await this.client.request('turn/interrupt', { threadId: node.threadId, turnId: node.turnId });
        return this.snapshot(node.treeId);
      }
      case 'recover': return this.recover(args.nodeId);
      case 'doctor': return this.client.doctor();
      case 'export_tree': return this.store.export(args.treeId);
      case 'node_items': return { items: this.store.items(args.nodeId) };
      default: throw new AppError('未知操作。', 404);
    }
  }
  async run(nodeId, operationId, job) {
    try {
      this.store.updateOperation(operationId, 'preparing');
      const node = this.store.node(nodeId), tree = this.store.tree(node.treeId);
      if (tree.mode === 'demo') await this.runDemo(node, job);
      else await this.runCodex(node, tree, job);
      this.store.updateOperation(operationId, this.store.node(nodeId).status);
    } catch (error) {
      const node = this.store.node(nodeId);
      const status = job.cancelled ? 'interrupted' : error.uncertain || node.threadId && !error.rpcError ? 'uncertain' : 'failed';
      this.store.updateNode(nodeId, { status, error: job.cancelled ? '已停止。' : error.message });
      this.store.updateOperation(operationId, status, error.message);
    } finally {
      this.releaseThread(job);
    }
  }
  releaseThread(job) {
    if (job.threadLease && this.threadLeases.get(job.threadLease) === job) this.threadLeases.delete(job.threadLease);
    job.threadLease = null;
  }
  canAppend(head, parent) {
    const state = head.thread.status?.type;
    return head.tail?.id === parent.turnId && head.tail.status === 'completed' && (!state || ['idle', 'notLoaded'].includes(state));
  }
  async prepareThread(node, options, job) {
    if (!node.parentId) return this.client.request('thread/start', options);
    const parent = this.store.node(node.parentId);
    if (!parent.threadId || !parent.turnId || parent.status !== 'complete') throw new AppError('父节点缺少可验证的 Codex 回合，不能用于真实分支。');
    // Reserve synchronously before reading native history. A competing sibling
    // forks from the immutable checkpoint instead of appending to our live turn.
    if (!this.threadLeases.has(parent.threadId) && !this.store.hasUnconfirmedThreadWork(parent.threadId)) {
      this.threadLeases.set(parent.threadId, job); job.threadLease = parent.threadId;
      const head = await this.client.readThreadHead(parent.threadId);
      if (this.canAppend(head, parent)) {
        if (job.cancelled) throw new Error('已停止。');
        const resumed = await this.client.request('thread/resume', { ...options, threadId: parent.threadId, excludeTurns: true });
        if (resumed.thread?.id !== parent.threadId) throw new Error('Codex 续聊标识不一致，未发送问题。');
        // Resuming may reveal history advanced outside this plugin. Check again
        // while holding the local lease, before any turn/start is sent.
        if (this.canAppend(await this.client.readThreadHead(parent.threadId), parent)) return resumed;
      }
      this.releaseThread(job);
    }
    if (job.cancelled) throw new Error('已停止。');
    return this.client.request('thread/fork', { ...options, threadId: parent.threadId, lastTurnId: parent.turnId, excludeTurns: true });
  }
  async runDemo(node, job) {
    this.store.updateNode(node.id, { status: 'running' });
    const path = this.store.path(node.id);
    const answer = `演示回复（本地规则生成，未调用模型）\n\n这条路径依次讨论：\n${path.map((n, i) => `${i + 1}. ${n.q}`).join('\n')}\n\n你的当前追问是“${node.q}”。它已经保存为独立节点，可以从之前的同一个回答再创建其他追问。兄弟节点的后续内容不会加入这里显示的上下文路径。`;
    for (let i = 0; i < answer.length; i += 16) {
      if (job.cancelled) throw new Error('已停止。');
      this.store.updateNode(node.id, { answer: answer.slice(0, i + 16) });
      await delay(this.demoDelay, undefined, { signal: job.controller.signal });
    }
    this.store.updateNode(node.id, { status: 'complete' });
  }
  async runCodex(node, tree, job) {
    if (process.env.BRANCH_CANVAS_CHILD === '1') throw new AppError('不能在 Branch Canvas 启动的 Codex 子进程里递归运行真实模式。');
    await this.client.checkForkSupport(); await this.client.connect();
    if (job.cancelled) throw new Error('已停止。');
    const options = { cwd: tree.cwd, sandbox: 'read-only', approvalPolicy: 'never',
      ...(tree.model ? { model: tree.model } : {}),
      developerInstructions: 'You are running in Branch Canvas, a read-only discussion client. Do not invoke Branch Canvas tools recursively. Do not modify files or request elevated permissions.' };
    const result = await this.prepareThread(node, options, job);
    const threadId = result.thread?.id;
    if (!threadId) throw new Error('Codex 没有返回分支标识。');
    this.threadLeases.set(threadId, job); job.threadLease = threadId;
    this.store.updateNode(node.id, { threadId, status: 'running' });
    if (job.cancelled) { this.store.updateNode(node.id, { status: 'interrupted', error: '发送之前已停止。' }); return; }
    await new Promise((resolve, reject) => {
      let finished = false;
      const messages = new Map();
      const cleanup = () => { clearTimeout(timer); this.client.off('notification', notify); this.client.off('disconnected', disconnect); this.client.off('blockedRequest', blocked); };
      const finish = (error) => { if (finished) return; finished = true; cleanup(); error ? reject(error) : resolve(); };
      const disconnect = error => finish(error);
      const blocked = event => { if (!event.threadId || event.threadId === threadId) this.store.updateNode(node.id, { error: '初版仅支持只读讨论；额外权限或交互请求已拒绝。' }); };
      const notify = ({ method, params: p }) => {
        if (p?.threadId !== threadId || finished) return;
        try {
          if (method === 'turn/started') this.store.updateNode(node.id, { turnId: p.turn.id });
          if (method === 'item/agentMessage/delta') {
            messages.set(p.itemId, (messages.get(p.itemId) || '') + (p.delta || ''));
            this.store.updateNode(node.id, { answer: [...messages.values()].join('\n\n') });
          }
          if (method === 'item/completed' && visibleKinds.has(p.item?.type)) {
            this.store.putItem(node.id, p.item);
            if (p.item.type === 'agentMessage') { messages.set(p.item.id, p.item.text || ''); this.store.updateNode(node.id, { answer: [...messages.values()].join('\n\n') }); }
          }
          if (method === 'turn/completed') {
            const turn = p.turn;
            for (const item of turn.items || []) if (visibleKinds.has(item.type)) {
              this.store.putItem(node.id, item); if (item.type === 'agentMessage') messages.set(item.id, item.text || '');
            }
            this.store.updateNode(node.id, { turnId: turn.id,
              answer: [...messages.values()].join('\n\n') || this.store.node(node.id).answer,
              status: turn.status === 'completed' ? 'complete' : turn.status === 'interrupted' ? 'interrupted' : 'failed',
              error: turn.error?.message || null });
            finish();
          }
        } catch (error) { finish(error); }
      };
      const timer = setTimeout(() => finish(new Error('等待回复超时。Codex 可能仍在运行，请检查状态，避免重复发送。')), 15 * 60 * 1000);
      this.client.on('notification', notify); this.client.on('disconnected', disconnect); this.client.on('blockedRequest', blocked);
      this.client.request('turn/start', { threadId, input: [{ type: 'text', text: node.q }], cwd: tree.cwd,
        approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly', networkAccess: false }, ...(tree.model ? { model: tree.model } : {}) })
        .then(async response => {
          if (finished) return;
          this.store.updateNode(node.id, { turnId: response.turn.id });
          if (job.cancelled) await this.client.request('turn/interrupt', { threadId, turnId: response.turn.id });
        }).catch(finish);
    });
  }
  async recover(nodeId) {
    const node = this.store.node(nodeId);
    if (this.active.has(nodeId)) return this.snapshot(node.treeId);
    if (!node.threadId || !node.turnId) throw new AppError('没有已确认的运行标识，无法安全自动恢复。请从父回答建立一个新分支。');
    await this.client.connect();
    const result = await this.client.request('thread/read', { threadId: node.threadId, includeTurns: true });
    const turn = result.thread?.turns?.find(t => t.id === node.turnId);
    if (!turn) throw new AppError('当前接口没有返回该回合。请在原生 Codex 中核查，插件不会重新发送。');
    if (turn.status === 'inProgress') throw new AppError('Codex 仍在执行，请稍后再次检查。');
    for (const item of turn.items || []) if (visibleKinds.has(item.type)) this.store.putItem(nodeId, item);
    this.store.updateNode(nodeId, { status: turn.status === 'completed' ? 'complete' : turn.status === 'interrupted' ? 'interrupted' : 'failed',
      answer: (turn.items || []).filter(i => i.type === 'agentMessage').map(i => i.text || '').join('\n\n') || node.answer,
      error: turn.error?.message || null });
    return this.snapshot(node.treeId);
  }
  close() {
    if (this.closePromise) return this.closePromise;
    this.closePromise = (async () => {
      this.closing = true;
      for (const job of this.active.values()) { job.cancelled = true; job.controller.abort(); }
      this.client.close();
      await Promise.allSettled([...this.active.values()].map(job => job.done));
      this.store.close(); this.releaseLock();
    })();
    return this.closePromise;
  }
}
