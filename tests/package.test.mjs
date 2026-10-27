import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CanvasService } from '../src/service.mjs';

test('a second backend cannot reset live work in the same database', async t => {
  const filename = join(mkdtempSync(join(tmpdir(), 'canvas-lock-test-')), 'tree.sqlite');
  const service = new CanvasService({ filename }); t.after(() => service.close());
  const tree = service.store.list()[0], root = service.store.nodes(tree.id)[0];
  const draft = service.store.createDraft(tree.id, root.id);
  service.store.queue('manual-queued', draft.id, 'not sent');
  assert.throws(() => new CanvasService({ filename }), /另一个工作区/);
  assert.equal(service.store.node(draft.id).status, 'queued');
});

test('bundled plugin runs from a clean folder without source files or node_modules', async t => {
  const folder = mkdtempSync(join(tmpdir(), 'canvas-package-test-'));
  mkdirSync(join(folder, 'dist'));
  cpSync('dist/mcp.mjs', join(folder, 'dist', 'mcp.mjs'));
  cpSync('dist/worker.mjs', join(folder, 'dist', 'worker.mjs'));
  cpSync('dist/mcp-app.html', join(folder, 'dist', 'mcp-app.html'));
  const client = new Client({ name: 'packaged-test', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(folder, 'dist', 'mcp.mjs')],
    env: { ...process.env, BRANCH_CANVAS_DB: join(folder, 'data', 'canvas.sqlite') }, stderr: 'pipe' });
  t.after(() => client.close());
  await client.connect(transport);
  const result = await client.callTool({ name: 'canvas_open', arguments: {} });
  assert.equal(result._meta.canvas.nodes.length, 2);
  const second = new Client({ name: 'second-desktop-view', version: '1' });
  const secondTransport = new StdioClientTransport({ command: process.execPath, args: [join(folder, 'dist', 'mcp.mjs')],
    env: { ...process.env, BRANCH_CANVAS_DB: join(folder, 'data', 'canvas.sqlite') }, stderr: 'pipe' });
  t.after(() => second.close()); await second.connect(secondTransport);
  const secondView = await second.callTool({ name: 'canvas_open', arguments: {} });
  assert.equal(secondView._meta.canvas.tree.id, result._meta.canvas.tree.id);
  const resource = await client.readResource({ uri: 'ui://branch-canvas/workspace.html' });
  assert.match(resource.contents[0].text, /Branch Canvas/);
});
