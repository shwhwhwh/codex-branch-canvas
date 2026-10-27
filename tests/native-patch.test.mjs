import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { patchAsar, readAsar, sha256 } from '../desktop-patch/asar.mjs';
import { updateIntegrityResource } from '../desktop-patch/integrity.mjs';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { rendererPatch } from '../desktop-patch/prepare.mjs';
const require = createRequire(import.meta.url);
const { register, validate, trustedSender } = require('../desktop-patch/main.cjs');

async function fixture(path) {
  const preserved = Buffer.from('Existing desktop module — keep exactly.');
  const original = Buffer.from('old target');
  const header = { files: { preserved: { size: preserved.length, offset: '0' }, target: { size: original.length, offset: String(preserved.length) } } };
  const json = Buffer.from(JSON.stringify(header)), head = Buffer.alloc(8 + Math.ceil(json.length / 4) * 4);
  head.writeUInt32LE(head.length - 4, 0); head.writeUInt32LE(json.length, 4); json.copy(head, 8);
  const size = Buffer.alloc(8); size.writeUInt32LE(4, 0); size.writeUInt32LE(head.length, 4);
  await writeFile(path, Buffer.concat([size, head, preserved, original])); return preserved;
}
test('native archive patch preserves existing files and source; appended files pass whole-file and block integrity', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'branch-native-asar-')), source = join(folder, 'original.asar'), output = join(folder, 'patched.asar');
  const preserved = await fixture(source), sourceHash = sha256(await readFile(source));
  const replacement = Buffer.alloc(4 * 1024 * 1024 + 19, 37);
  await patchAsar(source, output, { target: replacement, 'nested/addon.mjs': 'export const mounted = true;' });
  const archive = await readAsar(output);
  try {
    assert.deepEqual(await archive.read('preserved'), preserved);
    assert.deepEqual(await archive.read('target'), replacement);
    assert.equal((await archive.read('nested/addon.mjs')).toString(), 'export const mounted = true;');
    const meta = archive.entry('target').integrity;
    assert.equal(meta.hash, sha256(replacement)); assert.equal(meta.blocks.length, 2);
    for (let index = 0; index < meta.blocks.length; index++) assert.equal(meta.blocks[index], sha256(replacement.subarray(index * meta.blockSize, (index + 1) * meta.blockSize)));
    assert.equal(sha256(await readFile(source)), sourceHash);
    await assert.rejects(patchAsar(source, source, {}), /cannot be overwritten/);
  } finally { await archive.close(); }
});
test('native patch refuses unsafe archive paths and does not remove a pre-existing partial file', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'branch-native-partial-')), source = join(folder, 'original.asar'), output = join(folder, 'patched.asar');
  await fixture(source); await writeFile(output + '.partial', 'previous work');
  await assert.rejects(patchAsar(source, output, { target: 'new' }), /EEXIST/);
  assert.equal(await readFile(output + '.partial', 'utf8'), 'previous work');
  await assert.rejects(patchAsar(source, join(folder, 'unsafe.asar'), { '../outside': 'x' }), /Invalid archive path/);
});
test('native IPC rejects untrusted frames, unknown operations, and oversized requests before starting any helper', async () => {
  assert.throws(() => validate({ kind: 'action', action: 'run_shell', args: {} }), /not available/);
  assert.throws(() => validate({ kind: 'open_url' }), /Unknown/);
  assert.throws(() => validate({ kind: 'state', extra: 'x'.repeat(100001) }), /Invalid/);
  const frame = { url: 'app://-/index.html' }, sender = { mainFrame: frame };
  assert.equal(trustedSender({ sender, senderFrame: frame }), true);
  assert.equal(trustedSender({ sender, senderFrame: { url: 'https://example.com' } }), false);
  assert.equal(trustedSender({ sender: { mainFrame: { url: 'app://-/index.html' } }, senderFrame: frame }), false);
  let handler;
  register({ ipcMain: { handle(_channel, callback) { handler = callback; } }, app: { once() {} } }, { nodeExecutable: 'not-executed', pluginRoot: 'not-executed' });
  await assert.rejects(handler({ sender, senderFrame: { url: 'https://example.com' } }, { kind: 'state' }), /local desktop renderer/);
});
test('executable repack updates only the matching archive digest and rejects absent or ambiguous metadata', () => {
  const before = 'a'.repeat(64), after = 'b'.repeat(64);
  const resource = Buffer.from(JSON.stringify([{ file: 'resources\\app.asar', alg: 'SHA256', value: before }]));
  const exe = Buffer.concat([Buffer.from('PE fixture prefix'), resource, Buffer.from('unchanged tail')]);
  const change = updateIntegrityResource(exe, before, after);
  assert.equal(change.bytes.length, exe.length);
  assert.deepEqual(change.bytes.subarray(0, change.digestOffset), exe.subarray(0, change.digestOffset));
  assert.deepEqual(change.bytes.subarray(change.digestOffset + 64), exe.subarray(change.digestOffset + 64));
  assert.equal(change.bytes.subarray(change.digestOffset, change.digestOffset + 64).toString(), after);
  assert.throws(() => updateIntegrityResource(Buffer.from('unrelated binary'), before, after), /uniquely match/);
  assert.throws(() => updateIntegrityResource(Buffer.concat([resource, resource]), before, after), /uniquely match/);
});

test('experiment marks new windows and preserves the marker when their page title changes', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'branch-native-status-'));
  const app = new EventEmitter(); app.getPath = () => folder;
  const window = new EventEmitter(); let title = 'Codex';
  window.getTitle = () => title; window.setTitle = next => { title = next; };
  const handle = register({ app, ipcMain: { handle() {} } }, { nodeExecutable: 'not-executed', pluginRoot: 'not-executed', statusFile: join(folder, 'status.json') });
  app.emit('browser-window-created', {}, window);
  assert.equal(title, 'Codex · Branch Canvas 实验版');
  let prevented = false;
  window.emit('page-title-updated', { preventDefault() { prevented = true; } }, '另一个聊天');
  assert.equal(prevented, true);
  assert.equal(title, '另一个聊天 · Branch Canvas 实验版');
  const status = JSON.parse(await readFile(join(folder, 'status.json'), 'utf8'));
  assert.equal(status.ipcRegistered, true); assert.equal(status.windowCount, 1);
  assert.equal(status.rendererConnected, false); assert.equal(status.pluginConnected, false);
  handle.close();
});

test('summary tree renders even when the artifacts lazy-fetch visibility hint is false', () => {
  const patched = rendererPatch('export {zi as t};');
  const wrapper = patched.slice(patched.indexOf('\nlet __branchCanvasSection;'));
  const originalType = {}, nativeType = {};
  const context = { na() {}, r: () => ({ value: { routeKind: 'local-thread', conversationId: 'chat' } }), te: () => ({ kind: 'local', id: 'local' }), Qe: {}, Xe: {}, zi: originalType, Y: { Section: {} }, __branchCanvasGetReact: () => ({}), __branchCanvasFactory: () => nativeType, $: { Fragment: 'fragment', jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) } };
  vm.createContext(context);
  const result = vm.runInContext(wrapper + '\n__branchCanvasWrappedArtifacts({presentation:"summary",isVisible:false})', context);
  assert.equal(result.type, 'fragment'); assert.equal(result.props.children[0].type, nativeType);
  assert.equal(result.props.children[1].type, originalType);
  assert.equal(vm.runInContext('__branchCanvasWrappedArtifacts({presentation:"card"})', context).type, originalType);
});
