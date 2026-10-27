import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { request as httpRequest } from 'node:http';
import { Store } from '../src/store.mjs';
import { CodexClient } from '../src/codex.mjs';
import { CanvasService } from '../src/service.mjs';
import { createHttpServer } from '../src/http.mjs';
import { createMcpServer, resourceUri } from '../src/mcp.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

test('storage retains branches and drafts across restart; completed history is immutable', () => {
  const filename = join(mkdtempSync(join(tmpdir(), 'canvas-test-')), 'tree.sqlite');
  let store = new Store(filename); const tree = store.createTree({ title: 'Test' });
  const root = store.nodes(tree.id)[0]; store.updateNode(root.id, { q: 'shared', answer: 'root reply', status: 'complete' });
  const a = store.createDraft(tree.id, root.id, 'A only'); store.updateNode(a.id, { status: 'complete', answer: 'A reply' });
  const b = store.createDraft(tree.id, root.id, 'B draft'); store.close(); store = new Store(filename);
  assert.deepEqual(store.path(b.id).map(n => n.q), ['shared', 'B draft']);
  assert.throws(() => store.saveDraft(root.id, 'rewrite'), /不会被原地改写/);
  const exported = store.export(tree.id); assert.equal(exported.nodes.filter(n => n.parentId === root.id).length, 2);
  assert.equal(exported.nodes.filter(n => n.id === root.id).length, 1);
  store.cancelDraft(b.id); assert.equal(store.tree(tree.id).selectedId, root.id); store.close();
});

test('in-flight work becomes uncertain after restart and is not resent', () => {
  const filename = join(mkdtempSync(join(tmpdir(), 'canvas-test-')), 'tree.sqlite');
  let store = new Store(filename); const tree = store.createTree({ title: 'Crash' }), node = store.nodes(tree.id)[0];
  store.queue('key-1', node.id, 'question'); store.close(); store = new Store(filename);
  assert.equal(store.node(node.id).status, 'uncertain'); assert.equal(store.operation('key-1').state, 'uncertain');
  assert.equal(store.queue('key-1', node.id, 'question').fresh, false);
  assert.throws(() => store.queue('key-2', node.id, 'question'), /已经提交/); store.close();
});

async function finished(service, id) {
  for (let i = 0; i < 150; i++) { const node = service.store.node(id); if (!['queued', 'running'].includes(node.status)) return node; await delay(20); }
  assert.fail('Generation did not finish');
}

test('native adapter forks at the selected old turn; siblings and later source turns are excluded', async t => {
  const folder = mkdtempSync(join(tmpdir(), 'canvas-test-')), log = join(folder, 'requests.jsonl');
  const launcher = { command: process.execPath, args: [fileURLToPath(new URL('fixtures/fake-codex.mjs', import.meta.url))] };
  const client = new CodexClient({ launcher, env: { ...process.env, FAKE_CODEX_LOG: log } });
  const service = new CanvasService({ filename: ':memory:', seed: false, client }); t.after(() => service.close());
  const tree = service.store.createTree({ title: 'Native test', mode: 'codex' }), root = service.store.nodes(tree.id)[0];
  const submit = (nodeId, question, requestId) => service.execute('submit', { nodeId, question, requestId });
  await submit(root.id, 'COMMON', 'root-key'); assert.equal((await finished(service, root.id)).status, 'complete');
  const original = service.store.node(root.id);
  await client.request('turn/start', { threadId: original.threadId, input: [{ type: 'text', text: 'FUTURE_SECRET' }] }); await delay(40);
  const a = service.store.createDraft(tree.id, root.id);
  await Promise.all([submit(a.id, 'A_SECRET', 'a-key'), submit(a.id, 'A_SECRET', 'a-key')]);
  assert.equal((await finished(service, a.id)).answer, 'COMMON / A_SECRET');
  await submit(a.id, 'A_SECRET', 'a-key');
  const b = service.store.createDraft(tree.id, root.id); await submit(b.id, 'B_ONLY', 'b-key');
  const final = await finished(service, b.id); assert.equal(final.status, 'complete'); assert.equal(final.answer, 'COMMON / B_ONLY');
  assert.notEqual(final.threadId, original.threadId);
  const requests = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const forks = requests.filter(r => r.method === 'thread/fork'); assert.equal(forks.length, 2);
  for (const request of forks) { assert.equal(request.params.lastTurnId, original.turnId); assert.equal(request.params.sandbox, 'read-only'); }
  assert.equal(requests.filter(r => r.method === 'turn/start').length, 4);
  const submitted = requests.filter(r => r.method === 'turn/start' && r.params.input[0].text !== 'FUTURE_SECRET');
  assert.ok(submitted.every(r => r.params.sandboxPolicy.type === 'readOnly' && r.params.approvalPolicy === 'never'));
});

test('demo generation, stop, and read-only permission responses do not invoke a model', async t => {
  const service = new CanvasService({ filename: ':memory:', seed: false, demoDelay: 20 }); t.after(() => service.close());
  const tree = service.store.createTree({ title: 'Demo' }), root = service.store.nodes(tree.id)[0];
  await service.execute('submit', { nodeId: root.id, question: 'demo', requestId: 'demo-key' });
  await service.execute('stop', { nodeId: root.id }); assert.equal((await finished(service, root.id)).status, 'interrupted');
  const responses = [], client = new CodexClient(); client.write = msg => responses.push(msg);
  client.rejectServerRequest({ id: 1, method: 'item/commandExecution/requestApproval', params: {} });
  client.rejectServerRequest({ id: 2, method: 'item/permissions/requestApproval', params: {} });
  assert.equal(responses[0].result.decision, 'decline'); assert.deepEqual(responses[1].result.permissions, {});
});

test('HTTP rejects cross-origin writes and requires a per-process CSRF token', async t => {
  const service = new CanvasService({ filename: ':memory:' }), server = createHttpServer(service);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await service.close(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const html = await (await fetch(url)).text(), token = html.match(/name="canvas-token" content="([^"]+)"/)[1];
  const post = headers => fetch(url + '/api/action', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ action: 'state' }) });
  assert.equal((await post({})).status, 403);
  assert.equal((await post({ 'x-canvas-token': token, origin: 'https://example.com' })).status, 403);
  assert.equal((await post({ 'x-canvas-token': token })).status, 200);
  const evilHostStatus = await new Promise((resolve, reject) => {
    const req = httpRequest(url, { headers: { host: 'attacker.example' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(evilHostStatus, 403);
});

test('MCP exposes app entrypoints, an offline UI resource, and UI-only actions', async t => {
  const service = new CanvasService({ filename: ':memory:' }), server = createMcpServer(service);
  const client = new Client({ name: 'test-host', version: '1' }); const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); await service.close(); });
  await server.connect(serverTransport); await client.connect(clientTransport);
  const tools = await client.listTools(), open = tools.tools.find(tool => tool.name === 'canvas_open');
  assert.deepEqual(open._meta['openai/ui'].entrypoints.map(e => e.type), ['global', 'thread']);
  assert.deepEqual(tools.tools.find(tool => tool.name === 'canvas_action')._meta.ui.visibility, ['app']);
  const snapshot = await client.callTool({ name: 'canvas_open', arguments: {} }); assert.equal(snapshot._meta.canvas.nodes.length, 2);
  const resource = await client.readResource({ uri: resourceUri }); assert.match(resource.contents[0].mimeType, /text\/html/);
  assert.match(resource.contents[0].text, /探索路径/); assert.doesNotMatch(resource.contents[0].text, /<script src=/);
});
