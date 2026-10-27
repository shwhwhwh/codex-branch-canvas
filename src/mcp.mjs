import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CanvasService } from './service.mjs';
import { sharedRuntime } from './runtime.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
export const resourceUri = 'ui://branch-canvas/workspace.html';
export function hostThreadId(extra) {
  const value = extra?._meta?.thread_id || extra?._meta?.threadId;
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value) ? value : undefined;
}
export function createMcpServer(service) {
  const server = new McpServer({ name: 'codex-branch-canvas', version: '0.1.3' });
  const reply = data => ({ content: [{ type: 'text', text: 'Branch Canvas workspace updated.' }],
    structuredContent: { treeId: data.tree?.id || null, nodeCount: data.nodes?.length || 0 }, _meta: { canvas: data } });
  registerAppTool(server, 'canvas_open', {
    title: '对话树', description: 'Open Branch Canvas and automatically synchronize the current Codex conversation when host thread metadata is available.',
    inputSchema: { treeId: z.string().optional() },
    annotations: { readOnlyHint: true, openWorldHint: false },
    _meta: { ui: { resourceUri }, 'openai/ui': { entrypoints: [{ type: 'global' }, { type: 'thread' }] } }
  }, async ({ treeId }, extra) => reply(await service.execute('state', { treeId, followCurrent: !treeId, sourceThreadId: hostThreadId(extra) })));
  registerAppTool(server, 'canvas_action', {
    title: '操作对话树', description: 'Perform a user-selected Branch Canvas action from the conversation tree UI.',
    inputSchema: { action: z.enum(['state', 'create_tree', 'select_node', 'create_branch', 'save_draft', 'cancel_draft', 'submit', 'stop', 'recover', 'doctor', 'export_tree', 'node_items']), args: z.record(z.string(), z.unknown()).optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    _meta: { ui: { resourceUri, visibility: ['app'] } }
  }, async ({ action, args }, extra) => {
    try { return reply(await service.execute(action, { ...args, sourceThreadId: hostThreadId(extra) })); }
    catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
  });
  registerAppResource(server, 'Branch Canvas', resourceUri, { mimeType: RESOURCE_MIME_TYPE }, async () => ({ contents: [{ uri: resourceUri, mimeType: RESOURCE_MIME_TYPE,
    text: await readFile(join(root, 'dist', 'mcp-app.html'), 'utf8'),
    _meta: { ui: { prefersBorder: false, csp: { connectDomains: [], resourceDomains: [] } } } }] }));
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const service = await sharedRuntime({ filename: process.env.BRANCH_CANVAS_DB || join(root, 'data', 'canvas.sqlite'), cwd: process.env.BRANCH_CANVAS_CWD || process.cwd() });
  const server = createMcpServer(service);
  const transport = new StdioServerTransport();
  transport.onclose = () => service.close();
  await server.connect(transport);
  process.stdin.once('end', async () => { await service.close(); });
}
