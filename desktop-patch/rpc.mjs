import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createInterface } from 'node:readline';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const pluginRoot = resolve(process.argv[2]);
const client = new Client({ name: 'branch-canvas-native-summary', version: '0.1.0' });
const ready = client.connect(new StdioClientTransport({ command: process.execPath, args: [join(pluginRoot, 'dist', 'mcp.mjs')], env: { ...process.env }, stderr: 'pipe' }));
ready.catch(() => {});
const actions = new Set(['state', 'create_tree', 'select_node', 'create_branch', 'save_draft', 'cancel_draft', 'submit', 'stop', 'recover']);
const bindingPath = join(pluginRoot, 'data', 'native-summary-bindings.json');
let bindingQueue = Promise.resolve();
async function bindings() { try { return JSON.parse(await readFile(bindingPath, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return {}; throw new Error('The saved summary bindings could not be read.'); } }
function bindingKey(value) {
  if (typeof value.hostId !== 'string' || typeof value.conversationId !== 'string' || !value.hostId || !value.conversationId || value.hostId.length > 200 || value.conversationId.length > 200) throw new Error('Missing local conversation identity.');
  return JSON.stringify([value.hostId, value.conversationId]);
}
async function snapshot(treeId) {
  const result = await client.callTool({ name: 'canvas_open', arguments: treeId ? { treeId } : {} });
  if (result.isError) throw new Error(result.content?.find(item => item.type === 'text')?.text || 'Unable to open the tree.');
  return result._meta.canvas;
}
async function request(payload) {
  await ready;
  if (payload.kind === 'state') return snapshot(payload.treeId);
  if (payload.kind === 'action') {
    if (!actions.has(payload.action)) throw new Error('Action unavailable in the summary panel.');
    const result = await client.callTool({ name: 'canvas_action', arguments: { action: payload.action, args: payload.args || {} } });
    if (result.isError) throw new Error(result.content?.find(item => item.type === 'text')?.text || 'Branch Canvas action failed.');
    return result._meta.canvas;
  }
  if (payload.kind === 'binding_get') {
    const key = bindingKey(payload), state = await snapshot();
    const treeId = (await bindings())[key];
    return { trees: state.trees, boundTreeId: state.trees.some(tree => tree.id === treeId) ? treeId : null };
  }
  if (payload.kind === 'binding_set') {
    const key = bindingKey(payload), state = await snapshot(payload.treeId);
    if (state.tree.id !== payload.treeId) throw new Error('The selected tree does not exist.');
    const save = bindingQueue.catch(() => {}).then(async () => {
      const values = await bindings(); values[key] = state.tree.id;
      await mkdir(join(pluginRoot, 'data'), { recursive: true });
      const temp = bindingPath + '.tmp'; await writeFile(temp, JSON.stringify(values, null, 2), { mode: 0o600 }); await rename(temp, bindingPath);
    });
    bindingQueue = save; await save; return state;
  }
  throw new Error('Unknown native summary request.');
}
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  if (line.length > 100000) continue;
  let value; try { value = JSON.parse(line); } catch { continue; }
  try { const result = await request(value.payload); process.stdout.write(JSON.stringify({ id: value.id, result }) + '\n'); }
  catch (error) { process.stdout.write(JSON.stringify({ id: value.id, error: error.message }) + '\n'); }
}
await client.close();
