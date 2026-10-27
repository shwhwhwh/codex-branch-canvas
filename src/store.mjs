import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export class AppError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const now = () => new Date().toISOString();
const nodeColumns = new Set(['q', 'answer', 'status', 'threadId', 'turnId', 'error']);

export class Store {
  constructor(filename) {
    this.filename = filename === ':memory:' ? filename : resolve(filename);
    if (filename !== ':memory:') mkdirSync(dirname(this.filename), { recursive: true });
    this.db = new DatabaseSync(this.filename);
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS trees (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, mode TEXT NOT NULL,
        cwd TEXT NOT NULL, model TEXT, selectedId TEXT, createdAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY, treeId TEXT NOT NULL REFERENCES trees(id),
        parentId TEXT REFERENCES nodes(id), q TEXT NOT NULL DEFAULT '',
        answer TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'draft',
        threadId TEXT, turnId TEXT, error TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS nodes_tree ON nodes(treeId, createdAt);
      CREATE TABLE IF NOT EXISTS items (
        nodeId TEXT NOT NULL REFERENCES nodes(id), itemId TEXT NOT NULL,
        kind TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(nodeId,itemId)
      );
      CREATE TABLE IF NOT EXISTS operations (
        id TEXT PRIMARY KEY, nodeId TEXT NOT NULL REFERENCES nodes(id),
        question TEXT NOT NULL, state TEXT NOT NULL, error TEXT,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
      );
      PRAGMA user_version=1;`);
    // A crash is not evidence that generation failed. Never automatically resubmit.
    this.db.exec(`UPDATE nodes SET status='uncertain', error='服务曾中断。请检查运行状态，或回到父回答建立新分支。'
      WHERE status IN ('queued','running');
      UPDATE operations SET state='uncertain' WHERE state IN ('queued','preparing','running');`);
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() { this.db.close(); }
  list() {
    return this.db.prepare(`SELECT t.*, (SELECT COUNT(*) FROM nodes n WHERE n.treeId=t.id AND n.status!='discarded') AS nodeCount
      FROM trees t ORDER BY createdAt DESC, id`).all();
  }
  tree(id) {
    const tree = this.db.prepare('SELECT * FROM trees WHERE id=?').get(id);
    if (!tree) throw new AppError('对话树不存在。', 404);
    return tree;
  }
  node(id) {
    const node = this.db.prepare("SELECT * FROM nodes WHERE id=? AND status!='discarded'").get(id);
    if (!node) throw new AppError('问答节点不存在。', 404);
    return node;
  }
  nodes(treeId) {
    this.tree(treeId);
    return this.db.prepare("SELECT * FROM nodes WHERE treeId=? AND status!='discarded' ORDER BY rowid").all(treeId);
  }
  createTree({ title = '新的探索', mode = 'demo', cwd = process.cwd(), model = null } = {}) {
    if (!['demo', 'codex'].includes(mode)) throw new AppError('无效的运行模式。');
    if (typeof title !== 'string' || !title.trim() || title.length > 120) throw new AppError('标题需要 1–120 个字符。');
    return this.transaction(() => {
      const id = randomUUID();
      this.db.prepare('INSERT INTO trees VALUES(?,?,?,?,?,?,?)').run(id, title.trim(), mode, cwd, model || null, null, now());
      this.createDraft(id, null);
      return this.tree(id);
    });
  }
  createDraft(treeId, parentId, q = '') {
    this.tree(treeId);
    if (parentId) {
      const parent = this.node(parentId);
      if (parent.treeId !== treeId) throw new AppError('父节点不属于这棵树。');
      if (parent.status !== 'complete') throw new AppError('只能从已完成的回答创建分支。');
    } else if (this.nodes(treeId).length) throw new AppError('一棵树只能有一个起点。');
    if (typeof q !== 'string' || q.length > 20000) throw new AppError('追问最多 20000 个字符。');
    const id = randomUUID(), timestamp = now();
    this.db.prepare(`INSERT INTO nodes (id,treeId,parentId,q,status,createdAt,updatedAt) VALUES(?,?,?,?,'draft',?,?)`)
      .run(id, treeId, parentId || null, q, timestamp, timestamp);
    this.select(treeId, id);
    return this.node(id);
  }
  updateNode(id, patch) {
    this.node(id);
    const entries = Object.entries(patch).filter(([key]) => nodeColumns.has(key));
    if (!entries.length) return this.node(id);
    this.db.prepare(`UPDATE nodes SET ${entries.map(([key]) => `${key}=?`).join(',')},updatedAt=? WHERE id=?`)
      .run(...entries.map(([, value]) => value ?? null), now(), id);
    return this.db.prepare('SELECT * FROM nodes WHERE id=?').get(id);
  }
  saveDraft(id, q) {
    if (this.node(id).status !== 'draft') throw new AppError('已提交的问答不会被原地改写。');
    if (typeof q !== 'string' || q.length > 20000) throw new AppError('追问最多 20000 个字符。');
    return this.updateNode(id, { q });
  }
  cancelDraft(id) {
    const node = this.node(id);
    if (node.status !== 'draft' || !node.parentId) throw new AppError('只能取消尚未发送的子分支。');
    this.updateNode(id, { status: 'discarded' });
    this.select(node.treeId, node.parentId);
  }
  select(treeId, nodeId) {
    if (this.node(nodeId).treeId !== treeId) throw new AppError('无效的节点选择。');
    this.db.prepare('UPDATE trees SET selectedId=? WHERE id=?').run(nodeId, treeId);
  }
  path(nodeId) {
    const path = [], seen = new Set();
    let node = this.node(nodeId);
    while (node) {
      if (seen.has(node.id)) throw new AppError('检测到循环引用。');
      seen.add(node.id); path.unshift(node);
      node = node.parentId ? this.node(node.parentId) : null;
    }
    return path;
  }
  operation(id) { return this.db.prepare('SELECT * FROM operations WHERE id=?').get(id); }
  hasUnconfirmedThreadWork(threadId) {
    return Boolean(this.db.prepare("SELECT 1 FROM nodes WHERE threadId=? AND status IN ('queued','running','uncertain') LIMIT 1").get(threadId));
  }
  queue(id, nodeId, question) {
    return this.transaction(() => {
      const existing = this.operation(id);
      if (existing) {
        if (existing.nodeId !== nodeId || existing.question !== question) throw new AppError('重复请求标识对应了不同的内容。', 409);
        return { operation: existing, fresh: false };
      }
      if (this.node(nodeId).status !== 'draft') throw new AppError('该节点已经提交，请勿重复发送。', 409);
      this.saveDraft(nodeId, question);
      this.updateNode(nodeId, { status: 'queued', error: null });
      const timestamp = now();
      this.db.prepare('INSERT INTO operations VALUES(?,?,?,?,?,?,?)').run(id, nodeId, question, 'queued', null, timestamp, timestamp);
      return { operation: this.operation(id), fresh: true };
    });
  }
  updateOperation(id, state, error = null) {
    this.db.prepare('UPDATE operations SET state=?,error=?,updatedAt=? WHERE id=?').run(state, error, now(), id);
  }
  putItem(nodeId, item) {
    if (!item?.id || typeof item.type !== 'string') return;
    this.db.prepare(`INSERT INTO items VALUES(?,?,?,?) ON CONFLICT(nodeId,itemId)
      DO UPDATE SET kind=excluded.kind,payload=excluded.payload`).run(nodeId, item.id, item.type, JSON.stringify(item));
  }
  items(nodeId) {
    this.node(nodeId);
    return this.db.prepare('SELECT payload FROM items WHERE nodeId=? ORDER BY rowid').all(nodeId).map(row => JSON.parse(row.payload));
  }
  snapshot(treeId = null) {
    const trees = this.list();
    const tree = treeId ? this.tree(treeId) : trees[0] || null;
    return { trees, tree, nodes: tree ? this.nodes(tree.id) : [] };
  }
  export(treeId) {
    const tree = this.tree(treeId), nodes = this.nodes(treeId);
    return { format: 'codex-branch-canvas', version: 1, exportedAt: now(), tree, nodes,
      items: nodes.flatMap(node => this.items(node.id).map(item => ({ nodeId: node.id, item }))) };
  }
  seedDemo(cwd) {
    if (this.list().length) return;
    const tree = this.createTree({ title: '示例：从一个回答探索不同方向', cwd });
    const root = this.nodes(tree.id)[0];
    this.updateNode(root.id, { q: '怎样用树状对话探索一个问题？', answer: '从一个共同问题出发，把不同追问放到不同分支。每条路径都继承自己的祖先，之后可以回到任意已完成回答，继续探索另一种思路。', status: 'complete' });
    const child = this.createDraft(tree.id, root.id, '对话历史应该怎样存储？');
    this.updateNode(child.id, { status: 'complete', answer: '每轮问答保存一次，用 parentId 指向父节点。共同前缀不必复制；节点选择、草稿、回复和分支关系都保存在本地 SQLite 数据库。' });
    this.select(tree.id, root.id);
  }
}
