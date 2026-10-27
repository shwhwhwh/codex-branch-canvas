import { createInterface } from 'node:readline';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
if (process.argv.includes('generate-json-schema')) {
  const out = process.argv[process.argv.indexOf('--out') + 1]; mkdirSync(join(out, 'v2'), { recursive: true });
  writeFileSync(join(out, 'v2', 'ThreadForkParams.json'), JSON.stringify({ properties: { lastTurnId: { type: 'string' } } })); process.exit(0);
}
const threads = new Map();
let advancedOnResume = false;
const send = msg => process.stdout.write(JSON.stringify(msg) + '\n');
const notify = (method, params) => send({ method, params });
function view(thread, full = false) {
  return { ...thread, status: { type: thread.turns.at(-1)?.status === 'inProgress' ? 'active' : 'idle' }, turns: full ? thread.turns : [] };
}
createInterface({ input: process.stdin }).on('line', line => {
  const msg = JSON.parse(line); if (!msg.method || !Object.hasOwn(msg, 'id')) return;
  if (process.env.FAKE_CODEX_LOG) appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify(msg) + '\n');
  const p = msg.params; let result = {};
  switch (msg.method) {
    case 'initialize': result = { userAgent: 'test', platformFamily: 'test', platformOs: 'test' }; break;
    case 'account/read': result = { account: { type: 'chatgpt', planType: 'test' } }; break;
    case 'model/list': result = { data: [{ id: 'test-model', displayName: 'Test model', isDefault: true }] }; break;
    case 'thread/start': { const thread = { id: randomUUID(), historyMode: process.env.FAKE_CODEX_PAGINATED ? 'paginated' : 'legacy', turns: [] }; threads.set(thread.id, thread); result = { thread: view(thread) }; break; }
    case 'thread/fork': {
      const parent = threads.get(p.threadId), index = parent.turns.findIndex(t => t.id === p.lastTurnId);
      if (index < 0) { send({ id: msg.id, error: { code: -32602, message: 'Unknown lastTurnId' } }); return; }
      const thread = { id: randomUUID(), historyMode: parent.historyMode, turns: structuredClone(parent.turns.slice(0, index + 1)) }; threads.set(thread.id, thread); result = { thread: view(thread) }; break;
    }
    case 'thread/resume': {
      const thread = threads.get(p.threadId);
      if (process.env.FAKE_CODEX_ADVANCE_ON_RESUME && !advancedOnResume) {
        advancedOnResume = true;
        thread.turns.push({ id: randomUUID(), status: 'completed', items: [{ id: randomUUID(), type: 'userMessage', content: [{ type: 'text', text: 'EXTERNAL_AFTER_READ' }] }] });
      }
      result = { thread: view(thread, !p.excludeTurns) }; break;
    }
    case 'thread/read': {
      if (process.env.FAKE_CODEX_HEAD_FAILURE) { send({ id: msg.id, error: { code: -32000, message: 'History unavailable' } }); return; }
      result = { thread: view(threads.get(p.threadId), p.includeTurns) }; break;
    }
    case 'thread/turns/list': {
      const turns = threads.get(p.threadId).turns;
      result = { data: [...turns].reverse().slice(0, p.limit).map(turn => ({ ...turn, items: [] })), nextCursor: null }; break;
    }
    case 'turn/start': {
      const thread = threads.get(p.threadId), q = p.input[0].text;
      const turn = { id: randomUUID(), status: 'inProgress', items: [{ id: randomUUID(), type: 'userMessage', content: [{ type: 'text', text: q }] }] };
      thread.turns.push(turn); result = { turn: { id: turn.id, status: 'inProgress' } };
      setTimeout(() => {
        notify('turn/started', { threadId: thread.id, turn });
        const answer = thread.turns.map(t => t.items[0].content[0].text).join(' / ');
        const item = { id: randomUUID(), type: 'agentMessage', text: answer };
        notify('item/agentMessage/delta', { threadId: thread.id, turnId: turn.id, itemId: item.id, delta: answer.slice(0, 5) });
        notify('item/agentMessage/delta', { threadId: thread.id, turnId: turn.id, itemId: item.id, delta: answer.slice(5) });
        turn.items.push(item); turn.status = 'completed';
        notify('item/completed', { threadId: thread.id, turnId: turn.id, item });
        notify('turn/completed', { threadId: thread.id, turn });
      }, Number(process.env.FAKE_CODEX_DELAY || 10)); break;
    }
    case 'turn/interrupt': break;
    default: send({ id: msg.id, error: { code: -32601, message: 'Unknown method' } }); return;
  }
  send({ id: msg.id, result });
});
