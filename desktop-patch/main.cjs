'use strict';
const { spawn } = require('node:child_process');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { randomUUID } = require('node:crypto');

const channel = 'branch-canvas:native-summary:v1';
const actions = new Set(['state', 'create_tree', 'select_node', 'create_branch', 'save_draft', 'cancel_draft', 'submit', 'stop', 'recover']);
function validate(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || JSON.stringify(payload).length > 100000) throw new Error('Invalid Branch Canvas request.');
  if (!['state', 'action', 'binding_get', 'binding_set'].includes(payload.kind)) throw new Error('Unknown Branch Canvas request.');
  if (payload.kind === 'action' && !actions.has(payload.action)) throw new Error('This action is not available in the summary panel.');
  return payload;
}
function trustedSender(event) {
  return event.senderFrame === event.sender?.mainFrame && /^app:\/\/-\//.test(event.senderFrame?.url || '');
}
function register(electron, configOverride) {
  const config = configOverride || JSON.parse(readFileSync(join(__dirname, 'branch-canvas-native.json'), 'utf8'));
  const statusFile = config.statusFile || join(__dirname, '..', '..', '..', 'branch-canvas-native-status.json');
  const status = { startedAt: new Date().toISOString(), pid: process.pid, executablePath: process.execPath, launchId: process.argv.find(value => value.startsWith('--branch-canvas-launch-id='))?.split('=')[1] || null, userDataPath: electron.app.getPath?.('userData') || null, ipcRegistered: false, windowCount: 0, rendererConnected: false, pluginConnected: false };
  function record(patch) { Object.assign(status, patch); try { writeFileSync(statusFile, JSON.stringify(status, null, 2)); } catch {} }
  electron.app.on?.('browser-window-created', (_event, window) => {
    record({ windowCount: status.windowCount + 1 });
    const mark = title => { const suffix = ' · Branch Canvas 实验版'; const next = String(title || 'Codex'); window.setTitle(next.includes(suffix) ? next : next + suffix); };
    mark(window.getTitle());
    window.once('ready-to-show', () => mark(window.getTitle()));
    window.on('page-title-updated', (event, title) => { event.preventDefault(); mark(title); });
  });
  let child, buffer = '', stopping = false;
  const pending = new Map();
  function failAll(message) { for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error(message)); } pending.clear(); }
  function start() {
    if (child) return child;
    if (stopping) throw new Error('Branch Canvas is shutting down.');
    const rpcFile = join(__dirname, '..', '..', '..', 'branch-canvas-native-rpc.mjs');
    const process = spawn(config.nodeExecutable, [rpcFile, config.pluginRoot], {
      cwd: config.pluginRoot, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
    });
    child = process; buffer = '';
    process.stdout.setEncoding('utf8');
    process.stdout.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 16 * 1024 * 1024) { process.kill(); failAll('Branch Canvas response exceeded the size limit.'); return; }
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let result; try { result = JSON.parse(line); } catch { continue; }
        const waiter = pending.get(result.id); if (!waiter) continue;
        pending.delete(result.id); clearTimeout(waiter.timer);
        if (!result.error && !status.pluginConnected) record({ pluginConnected: true });
        result.error ? waiter.reject(new Error(result.error)) : waiter.resolve(result.result);
      }
    });
    // Do not forward model or account diagnostics into the renderer.
    process.stderr.on('data', () => {});
    process.once('error', () => { if (child === process) child = null; failAll('Unable to start Branch Canvas. Check the Node.js and plugin paths.'); });
    process.once('exit', () => { if (child === process) child = null; failAll('Branch Canvas disconnected. Try the action again.'); });
    return process;
  }
  const handle = async (event, payload) => {
    if (!trustedSender(event)) throw new Error('Branch Canvas accepts requests only from the local desktop renderer.');
    validate(payload);
    if (payload.kind === 'binding_get') record({ rendererConnected: true, rendererConnectedAt: new Date().toISOString() });
    if (pending.size >= 64) throw new Error('Too many Branch Canvas requests.');
    const process = start(), id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Branch Canvas timed out. Check its state before retrying a submission.')); }, 30000);
      pending.set(id, { resolve, reject, timer });
      process.stdin.write(JSON.stringify({ id, payload }) + '\n', error => { if (error) { pending.delete(id); clearTimeout(timer); reject(new Error('Branch Canvas disconnected.')); } });
    });
  };
  electron.ipcMain.handle(channel, handle);
  record({ ipcRegistered: true });
  handle.close = () => { stopping = true; child?.kill(); failAll('Branch Canvas is shutting down.'); };
  electron.app.once('before-quit', handle.close);
  return handle;
}
async function selfTest(electron) {
  const output = join(__dirname, '..', '..', '..', 'branch-canvas-native-self-test.json');
  let handler;
  try {
    await electron.app.whenReady(); handler = register(electron);
    const frame = { url: 'app://-/index.html' };
    const state = await handler({ senderFrame: frame, sender: { mainFrame: frame } }, { kind: 'state' });
    const report = { checkedAt: new Date().toISOString(), launchId: process.argv.find(value => value.startsWith('--branch-canvas-launch-id='))?.split('=')[1] || null, nativeRuntimeLoaded: true, nativeIpcHandlerRegistered: true, installedPluginConnected: true, nodeCount: state.nodes.length, modelRequests: 0, rendererUiVerified: false };
    handler.close(); writeFileSync(output, JSON.stringify(report, null, 2)); electron.app.exit(0);
  } catch (error) { handler?.close(); writeFileSync(output, JSON.stringify({ checkedAt: new Date().toISOString(), nativeRuntimeLoaded: true, error: error.message, rendererUiVerified: false }, null, 2)); electron.app.exit(1); }
}
module.exports = { register, selfTest, validate, trustedSender, channel };
