import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { completedConversation, importCompletedConversation } from '../src/import.mjs';

const user = (id, text) => ({ id, type: 'userMessage', content: [{ type: 'text', text }] });
const reply = (id, text, phase = 'final_answer') => ({ id, type: 'agentMessage', text, phase });
const fixture = () => ({ id: 'source-chat', cwd: process.cwd(), name: '当前聊天测试', model: 'test-model', turns: [
  { id: 'one', status: 'completed', items: [user('u1', '起点问题'), reply('c1', '可见进度', 'commentary'), { id: 'secret', type: 'reasoning', summary: ['not imported'] }, reply('a1', '第一个回答')] },
  { id: 'two', status: 'completed', items: [user('u2', '第二个问题'), reply('async', '中间的确认问题'), user('u3', '<send_user_message_question_reply>\n[{"question":"确认问题","answer":"用户答复"}]\n</send_user_message_question_reply>'), reply('a2', '最后的完成回答')] },
  { id: 'active', status: 'inProgress', items: [user('u4', '还在执行'), reply('a3', '尚未完成')] }
] });

test('conversation import uses completed native checkpoints and the final public answer, preserving follow-up replies', () => {
  const imported = completedConversation(fixture());
  assert.deepEqual(imported.turns.map(turn => turn.turnId), ['one', 'two']);
  assert.equal(imported.turns[1].answer, '最后的完成回答');
  assert.match(imported.turns[1].question, /答复：用户答复/);
  assert.equal(imported.turns[0].items.some(item => item.type === 'reasoning'), false);
  assert.equal(imported.turns[0].items.some(item => item.id === 'c1'), false);
  assert.throws(() => completedConversation({ ...fixture(), turns: [] }), /还没有/);
});

test('live import is atomic and idempotent, retains original running jobs, and gives every imported node an exact fork anchor', () => {
  const store = new Store(':memory:');
  try {
    const liveTree = store.createTree({ title: '已有运行' }), live = store.nodes(liveTree.id)[0];
    store.queue('existing-job', live.id, '原有问题'); store.updateNode(live.id, { status: 'running' });
    const conversation = completedConversation(fixture());
    const result = importCompletedConversation(store.db, conversation), nodes = store.nodes(result.treeId);
    assert.deepEqual(nodes.map(node => node.turnId), ['one', 'two']);
    assert.ok(nodes.every(node => node.threadId === 'source-chat' && node.status === 'complete'));
    assert.equal(nodes[1].parentId, nodes[0].id);
    assert.equal(store.node(live.id).status, 'running'); assert.equal(store.operation('existing-job').state, 'queued');
    assert.equal(importCompletedConversation(store.db, conversation).treeId, result.treeId);
    assert.equal(store.list().length, 2);
    const draft = store.createDraft(result.treeId, nodes[0].id, '旧回答的另一追问');
    assert.deepEqual(store.path(draft.id).map(node => node.q), ['起点问题', '旧回答的另一追问']);
    const broken = { ...conversation, checkpointTurnId: 'broken', turns: [{ ...conversation.turns[0], turnId: null }] };
    // Fail after the transaction has begun, proving rollback keeps existing trees.
    broken.turns[0].items = [user('duplicate', 'one'), user('duplicate', 'two')];
    assert.throws(() => importCompletedConversation(store.db, broken), /UNIQUE/);
    assert.equal(store.list().length, 2); assert.equal(store.node(live.id).status, 'running');
  } finally { store.close(); }
});
