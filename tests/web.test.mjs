import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const root = new URL('../', import.meta.url);
const bundle = (await build({ entryPoints: [fileURLToPath(new URL('web/app.mjs', root))], bundle: true, write: false, format: 'iife', platform: 'browser' })).outputFiles[0].text;
const html = await readFile(new URL('web/index.html', root), 'utf8');
const waitFor = async check => { for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); } assert.fail('UI did not reach the expected state'); };

function fixture({ mode = 'demo', preferences, deep = false, long = false } = {}) {
  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom, calls = [];
  const nodes = [
    { id: 'root', parentId: null, q: 'Shared question', answer: '## Answer\n\n**Shared** context.\n\n```json\n{"ok":true}\n```', status: 'complete' },
    { id: 'other', parentId: 'root', q: 'Existing branch', answer: 'Other reply', status: 'complete' },
    { id: 'draft', parentId: 'root', q: 'Keep my draft', answer: '', status: 'draft' },
  ];
  const tree = { id: 'test-tree', title: 'UI test', mode: 'demo', selectedId: 'root' };
  if (long) {
    let parentId = 'root';
    for (let index = 0; index < 60; index++) {
      const id = 'long-' + index;
      nodes.push({ id, parentId, q: 'Long path '+index, answer: 'Reply', status: 'complete' }); parentId = id;
    }
    tree.selectedId = parentId;
  }
  if (deep) {
    nodes.push({ id: 'leaf', parentId: 'other', q: 'Deep follow-up', answer: 'Leaf reply', status: 'complete' });
    nodes.push({ id: 'tip', parentId: 'leaf', q: 'Deep draft', answer: '', status: 'draft' });
    tree.selectedId = 'leaf';
  }
  tree.mode = mode;
  if (mode === 'codex') nodes[0].threadId = '11111111-1111-4111-8111-111111111111';
  if (preferences) window.localStorage.setItem('branch-canvas-navigation', JSON.stringify(preferences));
  const snapshot = () => structuredClone({ tree, trees: [tree], nodes });
  window.matchMedia = () => ({ matches: false, addEventListener() {} });
  window.ResizeObserver = class { observe() {} };
  const viewport = window.document.querySelector('#viewport');
  Object.defineProperties(viewport, { clientWidth: { value: 680 }, clientHeight: { value: 400 } });
  viewport.getBoundingClientRect = () => ({ width: 680, height: 400, left: 0, top: 0 });
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.setInterval = () => 0;
  window.fetch = async (_url, request) => {
    const { action, args } = JSON.parse(request.body); calls.push({ action, args });
    if (action === 'select_node') tree.selectedId = args.nodeId;
    if (action === 'create_branch') {
      const node = { id: 'new-' + nodes.length, parentId: args.parentId, q: args.question || '', answer: '', status: 'draft' };
      nodes.push(node); tree.selectedId = node.id;
    }
    if (action === 'save_draft') nodes.find(node => node.id === args.nodeId).q = args.question;
    if (action === 'submit') Object.assign(nodes.find(node => node.id === args.nodeId), { q: args.question, answer: '**New** reply', status: 'complete' });
    return { ok: true, json: async () => snapshot() };
  };
  window.eval(bundle);
  return { dom, window, document: window.document, calls, nodes };
}

function camera(document) {
  const values = document.querySelector('#world').style.transform.match(/translate\(([-.\d]+)px,([-.\d]+)px\) scale\(([-.\d]+)\)/);
  assert.ok(values); return { x: Number(values[1]), y: Number(values[2]), scale: Number(values[3]) };
}
test('long canvas can pan from cards to old parents, fit every node, and return to root without changing chat or draft', async () => {
  const f=fixture({long:true});
  try {
    await waitFor(()=>f.document.querySelector('[data-node-id="long-59"]'));
    await new Promise(resolve=>f.window.requestAnimationFrame(resolve));
    const before=camera(f.document), card=f.document.querySelector('[data-node-id="long-59"]');
    card.dispatchEvent(new f.window.WheelEvent('wheel',{deltaY:-320,bubbles:true,cancelable:true}));
    const moved=camera(f.document); assert.equal(moved.scale,before.scale);assert.equal(moved.y,before.y+320);
    card.dispatchEvent(new f.window.WheelEvent('wheel',{deltaY:1,deltaMode:1,bubbles:true,cancelable:true}));
    assert.equal(camera(f.document).y,moved.y-16);
    card.dispatchEvent(new f.window.WheelEvent('wheel',{deltaY:100,ctrlKey:true,bubbles:true,cancelable:true}));
    assert(camera(f.document).scale<before.scale);
    f.document.querySelector('#fit').click();
    const fitted=camera(f.document); assert(fitted.scale<.2);
    const world=f.document.querySelector('#world');
    assert(fitted.x>=0&&fitted.y>=0);
    assert(fitted.x+parseFloat(world.style.width)*fitted.scale<=680);
    assert(fitted.y+parseFloat(world.style.height)*fitted.scale<=400);
    f.document.querySelector('#fold-ancestors').click();
    assert.equal(f.document.querySelector('[data-node-id="root"]'),null);
    f.document.querySelector('#locate-root').click();
    const root=f.document.querySelector('[data-node-id="root"]'), top=camera(f.document);
    assert(root); const y=top.y+parseFloat(root.style.top)*top.scale;
    assert(y>=0&&y+154*top.scale<=400);
    assert.equal(f.document.querySelector('#question').dataset.node,'long-59');
    assert.equal(f.nodes.find(n=>n.id==='draft').q,'Keep my draft');
    assert.equal(f.calls.filter(c=>c.action!=='state').length,0);
    const viewport=f.document.querySelector('#viewport');
    viewport.dispatchEvent(new f.window.KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}));
    assert.equal(camera(f.document).y,top.y-80);
  } finally {f.window.close();}
});
test('real trees default to native navigation, and remount keeps tree, view and unsent follow-up', async () => {
  const f = fixture({ mode: 'codex' });
  let reopened;
  try {
    await waitFor(() => f.document.querySelector('.native-answer-card'));
    assert.equal(f.document.querySelector('.answer-text'), null);
    assert.equal(f.document.querySelector('.native-thread-link').getAttribute('href'), 'codex://threads/11111111-1111-4111-8111-111111111111');
    const input = f.document.querySelector('#question'); input.value = 'Keep this before navigating'; input.dispatchEvent(new f.window.Event('input'));
    const prefs = JSON.parse(f.window.localStorage.getItem('branch-canvas-navigation'));
    assert.equal(prefs.treeId, 'test-tree');
    reopened = fixture({ mode: 'codex', preferences: prefs });
    await waitFor(() => reopened.document.querySelector('.native-answer-card'));
    assert.equal(reopened.document.querySelector('#question').value, 'Keep this before navigating');
    const view = reopened.document.querySelector('#answer-view'); view.value = 'preview'; view.dispatchEvent(new reopened.window.Event('change'));
    assert.equal(reopened.document.querySelector('.answer-text strong').textContent, 'Shared');
  } finally { f.window.close(); reopened?.window.close(); }
});

test('folding parents keeps the current node and children, offers a restore pill, and leaves drafts untouched', async () => {
  const f = fixture({ deep: true });
  try {
    await waitFor(() => f.document.querySelector('[data-node-id="leaf"]'));
    f.document.querySelector('#fold-ancestors').click();
    assert.equal(f.document.querySelector('[data-node-id="root"]'), null);
    assert.equal(f.document.querySelector('[data-node-id="other"]'), null);
    assert.ok(f.document.querySelector('[data-node-id="leaf"]'));
    assert.ok(f.document.querySelector('[data-node-id="tip"]'));
    assert.ok(f.document.querySelector('[data-node-id="draft"]'), 'Sibling branch must remain reachable');
    assert.match(f.document.querySelector('.folded-parents').textContent, /2 个父节点/);
    assert.equal(f.document.querySelector('#question').dataset.node, 'leaf');
    assert.equal(f.nodes.find(n => n.id === 'draft').q, 'Keep my draft');
    assert.equal(f.calls.filter(call => call.action !== 'state').length, 0, 'Folding must not write conversation state');
    f.document.querySelector('.folded-parents').click();
    assert.equal(f.document.querySelectorAll('.graph-node').length, 5);
    assert.equal(f.document.querySelector('.folded-parents'), null);
  } finally { f.window.close(); }
});

test('parent folding persists across remount and search temporarily reveals matching ancestors', async () => {
  const f = fixture({ deep: true }); let reopened;
  try {
    await waitFor(() => f.document.querySelector('[data-node-id="leaf"]'));
    f.document.querySelector('#fold-ancestors').click();
    const preferences = JSON.parse(f.window.localStorage.getItem('branch-canvas-navigation'));
    reopened = fixture({ deep: true, preferences });
    await waitFor(() => reopened.document.querySelector('.folded-parents'));
    const search = reopened.document.querySelector('#search'); search.value = 'Shared question'; search.dispatchEvent(new reopened.window.Event('input'));
    assert.ok(reopened.document.querySelector('[data-node-id="root"]'));
    assert.equal(reopened.document.querySelector('.folded-parents'), null);
    assert.equal(reopened.document.querySelector('#fold-ancestors').disabled, true);
    search.value = ''; search.dispatchEvent(new reopened.window.Event('input'));
    assert.ok(reopened.document.querySelector('.folded-parents'));
    reopened.document.querySelector('#expand-all').click();
    assert.equal(reopened.document.querySelectorAll('.graph-node').length, 5);
  } finally { f.window.close(); reopened?.window.close(); }
});

test('child folding shows a summary; creating a new draft reveals its hidden parent path', async () => {
  const f = fixture({ deep: true });
  try {
    await waitFor(() => f.document.querySelector('[data-node-id="leaf"]'));
    f.document.querySelector('[data-node-id="root"] .collapse').click();
    assert.equal(f.document.querySelectorAll('.graph-node').length, 1);
    assert.match(f.document.querySelector('.folded-children').textContent, /4 个子节点/);
    f.document.querySelector('#locate-current').click();
    assert.ok(f.document.querySelector('[data-node-id="leaf"]'));
    f.document.querySelector('[data-node-id="root"] .collapse').click();
    f.document.querySelector('[data-node-id="root"] .add-branch').click();
    await waitFor(() => f.document.querySelector('[data-node-id="new-5"]'));
    assert.equal(f.document.querySelector('.folded-children'), null);
    assert.equal(f.document.querySelector('#question').dataset.node, 'new-5');
    assert.equal(f.nodes.find(n => n.id === 'tip').q, 'Deep draft');
  } finally { f.window.close(); }
});

test('parent folding also works in the compact panel layout and never navigates to another chat', async () => {
  const f = fixture({ mode: 'codex', deep: true, preferences: { layoutChoice: 'panel', navigateOnSelect: false } });
  try {
    await waitFor(() => f.document.querySelector('[data-node-id="leaf"]'));
    assert.equal(f.document.documentElement.classList.contains('panel-layout'), true);
    f.document.querySelector('[data-node-id="leaf"] .collapse-parents').click();
    assert.ok(f.document.querySelector('.folded-parents'));
    assert.equal(f.document.querySelector('#fold-ancestors').textContent, '展开父节点');
    f.document.querySelector('#fold-ancestors').click();
    assert.equal(f.document.querySelectorAll('.graph-node').length, 5);
    assert.equal(f.calls.filter(call => call.action !== 'state').length, 0);
  } finally { f.window.close(); }
});

test('selected completed answer accepts a follow-up and double submit creates one child', async () => {
  const f = fixture();
  try {
    const { document, window, calls, nodes } = f;
    await waitFor(() => document.querySelector('.answer-text strong'));
    assert.equal(document.querySelector('#only-current').checked, true);
    assert.equal(document.querySelector('#question').disabled, false);
    assert.ok(document.querySelector('.map-panel').compareDocumentPosition(document.querySelector('#composer')) & window.Node.DOCUMENT_POSITION_FOLLOWING);
    assert.ok(document.querySelector('#composer').compareDocumentPosition(document.querySelector('.response-panel')) & window.Node.DOCUMENT_POSITION_FOLLOWING);
    const input = document.querySelector('#question'); input.value = 'A new direction'; input.dispatchEvent(new window.Event('input'));
    const form = document.querySelector('#composer');
    form.dispatchEvent(new window.Event('submit', { cancelable: true }));
    form.dispatchEvent(new window.Event('submit', { cancelable: true }));
    await waitFor(() => calls.some(call => call.action === 'submit') && !document.querySelector('#send').disabled);
    assert.equal(calls.filter(call => call.action === 'create_branch').length, 1);
    assert.equal(calls.filter(call => call.action === 'submit').length, 1);
    assert.equal(nodes.at(-1).parentId, 'root');
    assert.equal(nodes.at(-1).q, 'A new direction');
    assert.equal(nodes.find(node => node.id === 'draft').q, 'Keep my draft');
    assert.equal(document.querySelector('.answer-text strong').textContent, 'New');
  } finally { f.dom.window.close(); }
});

test('switching branches retains their separate inputs and an existing draft', async () => {
  const f = fixture();
  try {
    const { document, window } = f;
    await waitFor(() => document.querySelector('.answer-text strong'));
    const input = document.querySelector('#question'); input.value = 'Unsent follow-up'; input.dispatchEvent(new window.Event('input'));
    document.querySelector('[data-node-id="draft"] .select-node').click();
    await waitFor(() => input.dataset.node === 'draft');
    assert.equal(input.value, 'Keep my draft');
    assert.equal(document.querySelector('.answer-text strong').textContent, 'Shared');
    document.querySelector('[data-node-id="root"] .select-node').click();
    await waitFor(() => input.dataset.node === 'root');
    assert.equal(input.value, 'Unsent follow-up');
  } finally { f.dom.window.close(); }
});
