import { randomUUID } from 'node:crypto';

function visibleUserText(item) {
  const text = (item.content || []).filter(part => part.type === 'text').map(part => part.text || '').join('\n').trim();
  if (text.startsWith('<send_user_message_question_reply>')) {
    try {
      const replies = JSON.parse(text.replace(/^<send_user_message_question_reply>\s*/, '').replace(/\s*<\/send_user_message_question_reply>$/, ''));
      return replies.map(reply => [reply.question, `答复：${reply.answer}`].filter(Boolean).join('\n')).join('\n\n');
    } catch { return text; }
  }
  return text.replace(/<in-app-browser-context\b[^>]*>[\s\S]*?<\/in-app-browser-context>/g, '')
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/g, '')
    .replace(/<external_codex_apps_open_page>[\s\S]*?<\/external_codex_apps_open_page>/g, '')
    .replace(/^\s*## My request:\s*/m, '').trim();
}

export function completedConversation(thread, { title, allowEmpty = false } = {}) {
  if (!thread?.id || !thread.cwd || !Array.isArray(thread.turns)) throw new Error('当前聊天没有可读取的本机历史。');
  const turns = [], ids = new Set();
  for (const turn of thread.turns) {
    if (turn.status !== 'completed') continue;
    const messages = (turn.items || []).filter(item => item.type === 'agentMessage' && typeof item.text === 'string' && item.text.trim());
    const finals = messages.filter(item => ['final', 'final_answer'].includes(item.phase));
    const final = finals.at(-1) || messages.filter(item => item.phase == null).at(-1);
    if (!final) continue;
    const question = (turn.items || []).filter(item => item.type === 'userMessage').map(visibleUserText).filter(Boolean).join('\n\n');
    if (!question) continue;
    if (!turn.id || ids.has(turn.id)) throw new Error('聊天中的回合标识缺失或重复。');
    ids.add(turn.id);
    turns.push({ turnId: turn.id, question, answer: final.text, items: (turn.items || []).filter(item => item.type === 'userMessage' || item === final) });
  }
  if (!turns.length && !allowEmpty) throw new Error('当前聊天还没有可用于分支的已完成问答。');
  const name = title || `当前聊天：${thread.name || '对话树测试'}`;
  if (typeof name !== 'string' || !name.trim() || name.length > 120) throw new Error('导入后的树名称需要 1–120 个字符。');
  return { sourceThreadId: thread.id, checkpointTurnId: turns.at(-1)?.turnId, title: name.trim(), cwd: thread.cwd, model: thread.model || null, turns };
}

// Runs in the owning worker; never resets jobs or overwrites existing branches.
export function syncCompletedConversation(db, conversation) {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS source_conversations (
      sourceThreadId TEXT PRIMARY KEY, treeId TEXT NOT NULL REFERENCES trees(id));
      CREATE INDEX IF NOT EXISTS nodes_native_turn ON nodes(threadId,turnId);`);
    const source = conversation.sourceThreadId;
    let treeId = db.prepare('SELECT treeId FROM source_conversations WHERE sourceThreadId=?').get(source)?.treeId;
    if (!treeId) treeId = db.prepare('SELECT treeId FROM nodes WHERE threadId=? AND status=\'complete\' ORDER BY createdAt LIMIT 1').get(source)?.treeId;
    const stamp = new Date().toISOString();
    if (!treeId) {
      treeId = randomUUID();
      db.prepare('INSERT INTO trees VALUES(?,?,?,?,?,NULL,?)').run(treeId, conversation.title, 'codex', conversation.cwd, conversation.model, stamp);
    }
    db.prepare('INSERT OR IGNORE INTO source_conversations VALUES(?,?)').run(source, treeId);
    let parentId = null, added = 0;
    for (const turn of conversation.turns) {
      const existing = db.prepare('SELECT id,status FROM nodes WHERE treeId=? AND threadId=? AND turnId=?').get(treeId, source, turn.turnId);
      if (existing) { parentId = existing.id; continue; }
      // Fork histories share ancestral turn IDs. Reuse that prefix in this tree.
      const ancestor = db.prepare('SELECT id FROM nodes WHERE treeId=? AND turnId=? AND status=\'complete\'').get(treeId, turn.turnId);
      if (ancestor) { parentId = ancestor.id; continue; }
      const id = randomUUID();
      db.prepare(`INSERT INTO nodes VALUES(?,?,?,?,?,'complete',?,?,NULL,?,?)`).run(id, treeId, parentId, turn.question, turn.answer, source, turn.turnId, stamp, stamp);
      for (const item of turn.items) if (item.id) db.prepare('INSERT INTO items VALUES(?,?,?,?)').run(id, item.id, item.type, JSON.stringify(item));
      parentId = id; added++;
    }
    // A new empty source gets a draft root so the normal composer remains usable.
    if (!db.prepare('SELECT id FROM nodes WHERE treeId=? LIMIT 1').get(treeId)) {
      parentId = randomUUID();
      db.prepare(`INSERT INTO nodes VALUES(?,?,NULL,'','','draft',NULL,NULL,NULL,?,?)`).run(parentId, treeId, stamp, stamp);
    }
    db.prepare('UPDATE trees SET selectedId=COALESCE(selectedId,?) WHERE id=?').run(parentId, treeId);
    db.exec('COMMIT'); return { treeId, added };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

// An additive import into the live WAL database. This intentionally does not
// construct Store/CanvasService: their startup recovery would reset live jobs.
export function importCompletedConversation(db, conversation) {
  if (db.prepare('PRAGMA user_version').get().user_version !== 1) throw new Error('不支持这份对话树数据库的版本。');
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; BEGIN IMMEDIATE;');
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS imported_conversations (
      sourceThreadId TEXT NOT NULL, checkpointTurnId TEXT NOT NULL,
      treeId TEXT NOT NULL REFERENCES trees(id), createdAt TEXT NOT NULL,
      PRIMARY KEY(sourceThreadId,checkpointTurnId));`);
    const existing = db.prepare('SELECT treeId FROM imported_conversations WHERE sourceThreadId=? AND checkpointTurnId=?')
      .get(conversation.sourceThreadId, conversation.checkpointTurnId);
    if (existing) {
      const tree = db.prepare('SELECT * FROM trees WHERE id=?').get(existing.treeId);
      if (!tree) throw new Error('已导入聊天的树记录缺失。');
      db.exec('COMMIT'); return { treeId: tree.id, selectedId: tree.selectedId, importedTurns: conversation.turns.length, reused: true };
    }
    const treeId = randomUUID(), timestamp = new Date().toISOString();
    db.prepare('INSERT INTO trees (id,title,mode,cwd,model,selectedId,createdAt) VALUES(?,?,?,?,?,NULL,?)')
      .run(treeId, conversation.title, 'codex', conversation.cwd, conversation.model, timestamp);
    let parentId = null;
    const insertNode = db.prepare(`INSERT INTO nodes (id,treeId,parentId,q,answer,status,threadId,turnId,error,createdAt,updatedAt)
      VALUES(?,?,?,?,?,'complete',?,?,NULL,?,?)`);
    const insertItem = db.prepare('INSERT INTO items (nodeId,itemId,kind,payload) VALUES(?,?,?,?)');
    for (const turn of conversation.turns) {
      const id = randomUUID();
      insertNode.run(id, treeId, parentId, turn.question, turn.answer, conversation.sourceThreadId, turn.turnId, timestamp, timestamp);
      for (const item of turn.items) if (item.id) insertItem.run(id, item.id, item.type, JSON.stringify(item));
      parentId = id;
    }
    db.prepare('UPDATE trees SET selectedId=? WHERE id=?').run(parentId, treeId);
    db.prepare('INSERT INTO imported_conversations VALUES(?,?,?,?)')
      .run(conversation.sourceThreadId, conversation.checkpointTurnId, treeId, timestamp);
    db.exec('COMMIT');
    return { treeId, selectedId: parentId, importedTurns: conversation.turns.length, reused: false };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
