import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { CanvasService } from '../src/service.mjs';
import { CodexClient } from '../src/codex.mjs';

function fixture(t, env = {}) {
  const folder = mkdtempSync(join(tmpdir(), 'canvas-reuse-')), log = join(folder, 'requests.jsonl');
  const client = new CodexClient({ launcher: { command: process.execPath, args: [fileURLToPath(new URL('fixtures/fake-codex.mjs', import.meta.url))] }, env: { ...process.env, ...env, FAKE_CODEX_LOG: log } });
  const service = new CanvasService({ filename: ':memory:', seed: false, client });
  t.after(() => service.close());
  const tree = service.store.createTree({ title: 'Reuse', mode: 'codex' }), root = service.store.nodes(tree.id)[0];
  const requests = () => readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  async function submit(node, question) {
    await service.execute('submit', { nodeId: node.id, question, requestId: 'req-' + node.id });
    for (let i = 0; i < 300; i++) {
      const updated = service.store.node(node.id);
      if (!['queued', 'running'].includes(updated.status)) return updated;
      await delay(10);
    }
    assert.fail('Generation did not finish');
  }
  const child = parent => service.store.createDraft(tree.id, parent.id);
  return { service, client, root, child, submit, requests };
}

for (const paginated of [false, true]) test(`linear paths reuse threads; historical alternatives fork; ${paginated ? 'paginated' : 'legacy'} history`, async t => {
  const f = fixture(t, paginated ? { FAKE_CODEX_PAGINATED: '1' } : {});
  const root = await f.submit(f.root, 'COMMON'); assert.equal(root.status, 'complete');
  const beforeDrafts = f.requests().length, aDraft = f.child(root), bDraft = f.child(root);
  assert.equal(f.requests().length, beforeDrafts, 'Draft creation must not create native threads');
  const a = await f.submit(aDraft, 'A_SECRET'), a2 = await f.submit(f.child(a), 'A_CONTINUE');
  assert.equal(a.threadId, root.threadId); assert.equal(a2.threadId, root.threadId);
  assert.equal(new Set([root.turnId, a.turnId, a2.turnId]).size, 3);
  assert.equal(a2.answer, 'COMMON / A_SECRET / A_CONTINUE');
  const b = await f.submit(bDraft, 'B_ONLY'), b2 = await f.submit(f.child(b), 'B_CONTINUE');
  assert.notEqual(b.threadId, root.threadId); assert.equal(b2.threadId, b.threadId);
  assert.equal(b2.answer, 'COMMON / B_ONLY / B_CONTINUE');
  assert.equal(f.service.store.node(root.id).answer, 'COMMON');
  assert.equal(f.service.store.node(a.id).answer, 'COMMON / A_SECRET');
  const calls = f.requests();
  assert.equal(calls.filter(r => r.method === 'thread/start').length, 1);
  const forks = calls.filter(r => r.method === 'thread/fork'); assert.equal(forks.length, 1);
  assert.equal(forks[0].params.lastTurnId, root.turnId);
  assert.equal(calls.filter(r => r.method === 'thread/resume').length, 3);
  if (paginated) {
    assert.ok(calls.some(r => r.method === 'thread/turns/list' && r.params.limit === 1));
    assert.ok(!calls.some(r => r.method === 'thread/read' && r.params.includeTurns));
  }
  assert.equal(f.service.threadLeases.size, 0);
});

test('concurrent siblings reserve one append and fork the other without mixing streamed answers', async t => {
  const f = fixture(t, { FAKE_CODEX_DELAY: '80' }), root = await f.submit(f.root, 'COMMON');
  const [a, b] = await Promise.all([f.submit(f.child(root), 'A_ONLY'), f.submit(f.child(root), 'B_ONLY')]);
  assert.equal(a.answer, 'COMMON / A_ONLY'); assert.equal(b.answer, 'COMMON / B_ONLY');
  assert.notEqual(a.threadId, b.threadId);
  assert.equal([a, b].filter(n => n.threadId === root.threadId).length, 1);
  assert.equal(f.requests().filter(r => r.method === 'thread/fork').length, 1);
  assert.equal(f.service.threadLeases.size, 0);
});

test('native history that advances during resume is rechecked and forked at the selected checkpoint', async t => {
  const f = fixture(t, { FAKE_CODEX_ADVANCE_ON_RESUME: '1' }), root = await f.submit(f.root, 'COMMON');
  const child = await f.submit(f.child(root), 'SAFE');
  assert.equal(child.status, 'complete'); assert.equal(child.answer, 'COMMON / SAFE');
  assert.notEqual(child.threadId, root.threadId);
  assert.equal(f.requests().filter(r => r.method === 'thread/fork').length, 1);
  assert.equal(f.service.threadLeases.size, 0);
});

test('unavailable native history does not send or blindly fork and releases the reservation', async t => {
  const f = fixture(t, { FAKE_CODEX_HEAD_FAILURE: '1' }), root = await f.submit(f.root, 'COMMON');
  const child = await f.submit(f.child(root), 'DO_NOT_SEND');
  assert.equal(child.status, 'failed'); assert.match(child.error, /History unavailable/);
  assert.equal(f.requests().filter(r => r.method === 'turn/start').length, 1);
  assert.equal(f.requests().filter(r => r.method === 'thread/fork').length, 0);
  assert.equal(f.service.threadLeases.size, 0);
});

test('unconfirmed prior execution never appends into the potentially changed native thread', async t => {
  const f = fixture(t), root = await f.submit(f.root, 'COMMON');
  const lost = f.child(root);
  f.service.store.updateNode(lost.id, { status: 'uncertain', threadId: root.threadId, error: 'Acknowledgement lost' });
  const child = await f.submit(f.child(root), 'SAFE');
  assert.equal(child.answer, 'COMMON / SAFE'); assert.notEqual(child.threadId, root.threadId);
  assert.equal(f.requests().filter(r => r.method === 'thread/resume').length, 0);
  assert.equal(f.requests().filter(r => r.method === 'thread/fork').length, 1);
});
