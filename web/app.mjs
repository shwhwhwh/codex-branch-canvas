import { App, applyDocumentTheme, applyHostStyleVariables, applyHostFonts } from '@modelcontextprotocol/ext-apps';
import { createMarkdownRenderer } from './markdown.mjs';
import { nativeThreadLink, requestNativeNavigation } from './navigation.mjs';
import { ancestorIds, displayForest, layoutForest, CARD_WIDTH, CARD_HEIGHT } from './tree-view.mjs';

const $ = selector => document.querySelector(selector);
const create = (tag, cls, content) => { const el = document.createElement(tag); if (cls) el.className = cls; if (content !== undefined) el.textContent = content; return el; };
const statusLabels = { draft: '草稿', queued: '等待连接', running: '正在回复', complete: '已完成', failed: '未完成', interrupted: '已停止', uncertain: '待确认' };
const pageOptions = new URLSearchParams(location.search), narrowPanel = matchMedia('(max-width:620px)');
function readPreferences() { try { return JSON.parse(localStorage.getItem('branch-canvas-navigation') || '{}'); } catch { return {}; } }
const preferences = readPreferences();
let requestedTreeId = pageOptions.get('treeId') || preferences.treeId || undefined;
let followCurrent = preferences.followCurrent !== false;
let answerView = preferences.answerView === 'preview' ? 'preview' : 'native';
let navigateOnSelect = preferences.navigateOnSelect !== false, navigationBusy = false, autoOpenNodeId = null;
let layoutChoice = pageOptions.get('view') || preferences.layoutChoice, panelLayout = false, filterTouched = false;
let data = null, api, selectedId, draftTimer, polling = false, mutationEpoch = 0, mutationChain = Promise.resolve();
let modelClient, graphSignature = '', chatSignature = '', positions = new Map(), collapsed = new Set(), scale = 1, pan = { x: 20, y: 20 }, drag = null;
let ancestorAnchorId = null, graphWidth = 0, graphHeight = 0;
const treeViews = new Map(Object.entries(preferences.treeViews && typeof preferences.treeViews === 'object' && !Array.isArray(preferences.treeViews) ? preferences.treeViews : {}));
const requestIds = new Map();
const followups = new Map(Array.isArray(preferences.followups) ? preferences.followups.filter(entry => Array.isArray(entry) && entry.length === 2 && entry.every(value => typeof value === 'string')) : []), markdown = createMarkdownRenderer(window);
let submitting = false;
let pendingDraft = null, draftQueue = Promise.resolve();
const getNode = id => data?.nodes.find(n => n.id === id);
function persistPreferences() {
  try { localStorage.setItem('branch-canvas-navigation', JSON.stringify({ treeId: data?.tree?.id || requestedTreeId, followCurrent, answerView, navigateOnSelect, followups: [...followups], layoutChoice, treeViews: Object.fromEntries(treeViews) })); } catch {}
}
function saveTreeView() {
  if (data?.tree) treeViews.set(data.tree.id, { collapsed: [...collapsed], ancestorAnchorId });
  persistPreferences();
}
function revealNode(id) {
  let changed = false;
  for (const parentId of ancestorIds(data.nodes, id)) if (collapsed.delete(parentId)) changed = true;
  if (ancestorIds(data.nodes, ancestorAnchorId).includes(id)) { ancestorAnchorId = null; changed = true; }
  if (changed) { saveTreeView(); graphSignature = ''; }
  return changed;
}
function refreshGraph() { saveTreeView(); graphSignature = ''; render(); requestAnimationFrame(frameGraph); }
function foldParents(id) {
  if ($('#search').value.trim()) { notice('清除搜索后即可折叠节点。'); return; }
  if (!ancestorIds(data.nodes, id).length) return;
  ancestorAnchorId = ancestorAnchorId === id ? null : id; refreshGraph();
}
function foldChildren(id) {
  if ($('#search').value.trim()) { notice('清除搜索后即可折叠节点。'); return; }
  collapsed.has(id) ? collapsed.delete(id) : collapsed.add(id); refreshGraph();
}
function ancestors(id) { const path = [], seen = new Set(); let node = getNode(id); while (node && !seen.has(node.id)) { seen.add(node.id); path.unshift(node); node = getNode(node.parentId); } return path; }
function notice(message, error = false) { $('#notice').textContent = message; $('#notice').style.color = error ? 'var(--error)' : ''; }
function showError(error) { notice(error.message || String(error), true); }
function apply(snapshot) {
  if (!snapshot?.nodes) return;
  const previous = getNode(selectedId);
  const changedTree = data?.tree?.id !== snapshot.tree?.id;
  data = snapshot; selectedId = data.tree?.selectedId || data.nodes[0]?.id;
  if (!modelClient && data.tree && location.protocol.startsWith('http')) {
    const url = new URL(location.href); url.searchParams.set('treeId', data.tree.id); history.replaceState(null, '', url);
  }
  if (changedTree) {
    const view = treeViews.get(data.tree?.id);
    collapsed = new Set(Array.isArray(view?.collapsed) ? view.collapsed.filter(id => typeof id === 'string' && getNode(id)) : []);
    ancestorAnchorId = typeof view?.ancestorAnchorId === 'string' && getNode(view.ancestorAnchorId) ? view.ancestorAnchorId : null;
    graphSignature = ''; chatSignature = '';
  } else if (previous?.id !== selectedId) revealNode(selectedId);
  persistPreferences();
  render(); if (changedTree) requestAnimationFrame(frameGraph);
  if (previous?.id === selectedId && ['running', 'queued'].includes(previous.status) && getNode(selectedId)?.status === 'complete') notice('回复已保存。可以从任何已完成回答继续创建追问。');
  if (autoOpenNodeId === selectedId && getNode(selectedId)?.status === 'complete') {
    autoOpenNodeId = null;
    if (answerView === 'native' && navigateOnSelect && data.tree?.mode === 'codex' && nativeThreadLink(getNode(selectedId))) openNative(getNode(selectedId)).catch(showError);
  }
}
function act(action, args = {}) {
  mutationEpoch++;
  const promise = mutationChain.catch(() => {}).then(() => api(action, args));
  mutationChain = promise;
  return promise.then(result => { if (result?.nodes) apply(result); return result; });
}
function savePendingDraft() {
  clearTimeout(draftTimer);
  if (!pendingDraft) return draftQueue;
  const pending = pendingDraft; pendingDraft = null;
  draftQueue = draftQueue.catch(() => {}).then(() => act('save_draft', { nodeId: pending.id, question: pending.q }))
    .then(() => { if (selectedId === pending.id) $('#draft-state').textContent = '草稿已保存'; })
    .catch(error => { pendingDraft ||= pending; showError(error); throw error; });
  return draftQueue;
}
async function branch(parentId) {
  try { await savePendingDraft(); await act('create_branch', { parentId }); notice('新分支已建立。输入追问后发送。'); $('#question').focus(); requestAnimationFrame(() => { if (panelLayout) $('#composer').scrollIntoView({ block: 'nearest' }); else focusNode(selectedId); }); }
  catch (error) { showError(error); }
}
async function openNative(node) {
  if (navigationBusy) return;
  navigationBusy = true;
  try { await savePendingDraft(); persistPreferences(); notice('正在请求 Codex 打开对应聊天…'); await requestNativeNavigation(node, modelClient); notice('已请求打开原生聊天。旧回答可使用聊天内查找定位。'); }
  finally { navigationBusy = false; }
}
async function selectNode(nodeId) {
  try {
    autoOpenNodeId = null; await savePendingDraft(); await act('select_node', { nodeId });
    if (revealNode(nodeId)) { render(); requestAnimationFrame(frameGraph); }
    const node = getNode(nodeId);
    if (answerView === 'native' && navigateOnSelect && node?.status === 'complete' && nativeThreadLink(node)) await openNative(node);
  } catch (error) { showError(error); }
}
function button(label, cls, handler, ariaLabel) {
  const b = create('button', cls, label); b.type = 'button'; if (ariaLabel) b.setAttribute('aria-label', ariaLabel); b.onclick = handler; return b;
}
function render() {
  const picker = $('#tree-picker'); picker.replaceChildren(...data.trees.map(tree => { const opt = create('option', '', tree.title); opt.value = tree.id; return opt; })); picker.value = data.tree?.id || '';
  $('#mode-badge').textContent = data.tree?.mode === 'codex' ? '真实 Codex · 只读讨论' : '演示模式 · 不调用模型';
  $('#chat-title').textContent = answerView === 'native' && data.tree?.mode === 'codex' ? '原生聊天' : '回答预览';
  $('#answer-view').value = data.tree?.mode === 'demo' ? 'preview' : answerView; $('#navigate-on-select').checked = navigateOnSelect;
  $('#answer-view option[value="native"]').disabled = data.tree?.mode === 'demo';
  $('#navigate-on-select').disabled = answerView !== 'native' || data.tree?.mode === 'demo';
  $('#map-hint').textContent = answerView === 'native' && data.tree?.mode === 'codex' ? '点击节点打开原生聊天 · ＋ 创建追问' : '点击节点查看 · ＋ 创建追问';
  const searching = Boolean($('#search').value.trim()), hasParents = ancestorIds(data.nodes, selectedId).length > 0;
  const parentFold = $('#fold-ancestors'); parentFold.disabled = searching || !hasParents;
  parentFold.textContent = ancestorAnchorId === selectedId ? '展开父节点' : '收起父节点';
  parentFold.setAttribute('aria-expanded', String(ancestorAnchorId !== selectedId));
  const childFold = $('#fold-descendants'); childFold.disabled = searching || !data.nodes.some(n => n.parentId === selectedId);
  childFold.textContent = collapsed.has(selectedId) ? '展开子节点' : '收起子节点';
  childFold.setAttribute('aria-expanded', String(!collapsed.has(selectedId)));
  $('#expand-all').disabled = !collapsed.size && !ancestorAnchorId;
  const signature = JSON.stringify([selectedId, $('#search').value, [...collapsed], ancestorAnchorId, data.nodes.map(n => [n.id, n.parentId, n.q, n.status])]);
  if (signature !== graphSignature) { graphSignature = signature; renderGraph(); }
  const shown = [...positions.values()].filter(p => p.item.kind === 'node').length;
  $('#node-count').textContent = `${shown === data.nodes.length ? shown : `${shown} / ${data.nodes.length}`} 个节点`;
  renderChat();
}
function renderGraph() {
  const query = $('#search').value.trim();
  const { forest } = displayForest(data.nodes, { collapsed, ancestorAnchorId, query });
  const layout = layoutForest(forest); positions = layout.positions; graphWidth = layout.width; graphHeight = layout.height;
  const container = $('#graph-nodes'), svg = $('#edges'); container.replaceChildren(); svg.replaceChildren();
  $('#world').style.width = `${graphWidth}px`; $('#world').style.height = `${graphHeight}px`;
  svg.setAttribute('width', graphWidth); svg.setAttribute('height', graphHeight);
  const active = new Set(ancestors(selectedId).map(n => n.id));
  const isActive = item => item.kind === 'node' ? active.has(item.id) : item.hiddenIds.some(id => active.has(id));
  for (const [id, p] of positions) {
    const item = p.item;
    for (const child of item.children) {
      const b = positions.get(child.id), path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      const fromX = p.x + CARD_WIDTH / 2, toX = b.x + CARD_WIDTH / 2, fromY = p.y + p.height, bend = (fromY + b.y) / 2;
      path.setAttribute('d', `M${fromX},${fromY} C${fromX},${bend} ${toX},${bend} ${toX},${b.y}`);
      if (isActive(child) && isActive(item)) path.classList.add('active');
      if (item.kind !== 'node' || child.kind !== 'node') path.classList.add('folded-edge'); svg.append(path);
    }
    if (item.kind !== 'node') {
      const parents = item.kind === 'ancestors';
      const pill = button('', `folded-region ${parents ? 'folded-parents' : 'folded-children'}${item.hiddenIds.includes(selectedId) ? ' contains-current' : ''}`, () => {
        if (parents) ancestorAnchorId = null; else collapsed.delete(item.anchorId); refreshGraph();
      }, `展开 ${item.hiddenIds.length} 个${parents ? '父' : '子'}节点`);
      pill.style.left = `${p.x}px`; pill.style.top = `${p.y}px`; pill.style.setProperty('--order', p.order); pill.style.setProperty('--depth', Math.min(p.depth, 6));
      pill.setAttribute('aria-expanded', 'false'); pill.dataset.foldKind = item.kind;
      pill.append(create('span', 'folded-icon', '⋯'), create('span', '', `已收起 ${item.hiddenIds.length} 个${parents ? '父' : '子'}节点`), create('span', 'folded-restore', '展开'));
      container.append(pill); continue;
    }
    const node = item.node;
    const card = create('article', `graph-node${node.id === selectedId ? ' selected' : ''}${active.has(node.id) ? ' on-path' : ''}`); card.style.left = `${p.x}px`; card.style.top = `${p.y}px`; card.dataset.nodeId = node.id;
    card.style.setProperty('--depth', Math.min(p.depth, 6)); card.style.setProperty('--order', p.order);
    const meta = create('div', 'node-meta'), number = data.nodes.findIndex(n => n.id === node.id) + 1;
    meta.append(create('span', 'node-code', `N${String(number).padStart(2, '0')}`), create('span', `node-status ${node.status}`, statusLabels[node.status] || node.status)); card.append(meta);
    const select = button('', 'select-node', () => selectNode(node.id), `${node.q || '新问题'}，${statusLabels[node.status]}`);
    select.setAttribute('aria-pressed', String(node.id === selectedId)); select.append(create('span', 'node-question', node.q || '新问题 · 草稿'));
    select.append(create('span', 'node-preview', node.answer ? node.answer.replace(/\s+/g, ' ').slice(0, 120) : node.status === 'draft' ? '尚未发送 · 在下方继续编辑' : '等待回答…'));
    card.append(select);
    const bottom = create('div', 'node-bottom'), controls = create('div', 'node-controls');
    if (node.parentId) {
      const up = button('↑ 上游', 'collapse-parents', () => foldParents(node.id), `${ancestorAnchorId === node.id ? '展开' : '折叠'}父节点：${node.q}`);
      up.setAttribute('aria-expanded', String(ancestorAnchorId !== node.id)); up.disabled = Boolean(query); controls.append(up);
    }
    if (item.descendantCount) {
      const down = button(`↓ ${item.descendantCount}`, 'collapse', () => foldChildren(node.id), `${collapsed.has(node.id) ? '展开' : '折叠'}子节点：${node.q}`);
      down.setAttribute('aria-expanded', String(!collapsed.has(node.id))); down.disabled = Boolean(query); controls.append(down);
    }
    if (node.status === 'complete') controls.append(button('＋ 追问', 'add-branch', () => branch(node.id), `从回答创建分支：${node.q}`));
    bottom.append(controls); card.append(bottom); container.append(card);
  }
  const shown = [...positions.values()].filter(p => p.item.kind === 'node').length;
  $('#node-count').textContent = `${shown === data.nodes.length ? shown : `${shown} / ${data.nodes.length}`} 个节点`;
  $('#empty-map').hidden = Boolean(positions.size); transform();
}
function renderChat() {
  const node = getNode(selectedId); if (!node) return;
  const path = ancestors(node.id);
  const breadcrumbs = $('#breadcrumbs'); breadcrumbs.replaceChildren();
  path.forEach((item, i) => { if (i) breadcrumbs.append(create('span', '', '›')); breadcrumbs.append(button(i === 0 ? '起点' : item.q.slice(0, 30) || '草稿', '', () => selectNode(item.id))); });
  const shown = $('#only-current').checked ? [node.status === 'draft' ? path.filter(n => n.status === 'complete').at(-1) : node].filter(Boolean) : path;
  const signature = JSON.stringify([answerView, ...shown.map(n => [n.id, n.q, n.answer, n.status, n.threadId])]);
  if (signature !== chatSignature) {
    chatSignature = signature; const transcript = $('#transcript'); transcript.replaceChildren();
    for (const item of shown.filter(n => n.status !== 'draft')) {
      if (answerView === 'native' && data.tree.mode === 'codex') {
        const card = create('article', 'native-answer-card');
        card.append(create('h3', '', item.q), create('p', 'secondary', `Codex · ${statusLabels[item.status]}`));
        const url = nativeThreadLink(item);
        if (url) {
          const sharedThread = data.nodes.filter(n => n.threadId === item.threadId).length > 1;
          card.append(create('p', '', sharedThread ? '在原生聊天中查看回答和执行过程。此聊天包含多轮记录，旧回答可通过聊天内查找定位。' : '回答由 Codex 原生聊天显示，可使用该消息的原生操作。'));
          const actions = create('div', 'native-answer-actions');
          card.append(create('p', 'secondary', '若跳转后对话树被收起，请从目标聊天右侧的“＋”重新打开“对话树”。节点和草稿仍保存在本机。'));
          actions.append(button('打开原生聊天', 'primary', () => openNative(item).catch(showError), `打开原生聊天：${item.q}`));
          actions.append(button('复制聊天链接', '', async () => { try { await navigator.clipboard.writeText(url); notice('聊天链接已复制。'); } catch { notice(url, true); } }));
          actions.append(button('复制定位文字', '', async () => { try { await navigator.clipboard.writeText(item.q.slice(0, 160)); notice('已复制问题文字。在原生聊天中使用查找即可定位。'); } catch { notice('请复制上方问题，在聊天内查找。', true); } }));
          card.append(actions);
          const link = create('a', 'native-thread-link', url); link.href = url;
          link.onclick = event => { event.preventDefault(); openNative(item).catch(showError); }; card.append(link);
        } else card.append(create('p', '', ['queued', 'running'].includes(item.status) ? '正在建立原生分支。生成完成后可打开。' : '此节点尚无可打开的原生聊天。'));
        transcript.append(card); continue;
      }
      const turn = create('article', 'turn'), answer = create('div', 'answer-text');
      answer.append(markdown(item.answer));
      if (!item.answer) answer.append(create('p', 'answer-status', ['running', 'queued'].includes(item.status) ? '正在组织回复…' : '此节点尚无回答。'));
      turn.append(create('h3', 'question-text', item.q), answer);
      const footer = create('div', 'answer-footer'), actions = create('div');
      footer.append(create('span', '', data.tree.mode === 'demo' ? '演示回复 · 本地规则生成' : `Codex · ${statusLabels[item.status]}`));
      if (item.answer) actions.append(button('复制回答', '', async () => {
        try { await navigator.clipboard.writeText(item.answer); notice('回答已复制。'); } catch { notice('无法访问剪贴板，请选择回答文本复制。', true); }
      }));
      if (item.status === 'complete') actions.append(button('＋ 分支追问', 'branch-action', () => branch(item.id)));
      if (data.tree.mode === 'codex') actions.append(button('工具记录', '', async () => {
        try { const result = await act('node_items', { nodeId: item.id }); let details = turn.querySelector('details');
          if (details) { details.open = !details.open; return; }
          details = create('details', 'item-records'); details.open = true; details.append(create('summary', '', `${result.items.length} 条可见记录`), create('pre', '', JSON.stringify(result.items, null, 2))); turn.append(details);
        } catch (error) { showError(error); }
      }));
      footer.append(actions); turn.append(footer); transcript.append(turn);
    }
    $('#empty-answer').hidden = Boolean(transcript.children.length);
  }
  const draft = node.status === 'draft', complete = node.status === 'complete', editable = draft || complete, running = ['running', 'queued'].includes(node.status);
  $('#composer-label').textContent = draft ? node.parentId ? '这个分支的追问' : '起点问题' : running ? '正在生成回复，可停止当前执行' : complete ? '从选中的回答继续追问' : '执行尚未完成，可检查状态或回到父回答';
  if (document.activeElement !== $('#question') || $('#question').dataset.node !== node.id) $('#question').value = draft ? pendingDraft?.id === node.id ? pendingDraft.q : node.q : followups.get(node.id) || '';
  $('#question').dataset.node = node.id; $('#question').disabled = !editable || submitting; $('#send').disabled = !editable || submitting; $('#send').hidden = !editable;
  $('#cancel-draft').hidden = !draft || !node.parentId; $('#stop').hidden = !running;
  $('#recover').hidden = node.status !== 'uncertain' || !node.threadId || !node.turnId;
  $('#node-error').hidden = !node.error; $('#node-error').textContent = node.error || '';
  if (!pendingDraft) $('#draft-state').textContent = draft ? '草稿自动保存在本机' : complete ? '发送后创建子分支' : statusLabels[node.status];
}
function updateLayout() {
  panelLayout = layoutChoice === 'panel' || layoutChoice !== 'canvas' && narrowPanel.matches;
  document.documentElement.classList.toggle('panel-layout', panelLayout);
  $('#view-title').textContent = panelLayout ? '对话树' : 'Branch Canvas';
  $('#chat-title').textContent = answerView === 'native' ? '原生聊天' : '回答预览';
  $('#layout-toggle').textContent = panelLayout ? '画布视图' : '树状列表';
  $('#layout-toggle').setAttribute('aria-pressed', String(panelLayout));
  if (!filterTouched) $('#only-current').checked = true;
  graphSignature = ''; chatSignature = '';
  if (data) { render(); requestAnimationFrame(frameGraph); }
}
function transform() { $('#world').style.transform = panelLayout ? '' : `translate(${pan.x}px,${pan.y}px) scale(${scale})`; $('#zoom-level').textContent = `${Math.round(scale * 100)}%`; }
function frameGraph() {
  if (panelLayout) { transform(); return; }
  const selected = positions.get(selectedId) || positions.values().next().value;
  if (!selected) return;
  // Fit-to-all is an explicit control. Opening a deep tree should keep node
  // text readable, rather than shrinking the entire history to a thumbnail.
  scale = .9;
  pan = { x: $('#viewport').clientWidth / 2 - (selected.x + CARD_WIDTH / 2) * scale,
    y: (selected.y + selected.height) * scale + 20 <= $('#viewport').clientHeight ? 20 : $('#viewport').clientHeight / 2 - (selected.y + selected.height / 2) * scale };
  transform();
}
function fit() {
  if (panelLayout) { transform(); return; }
  if (!positions.size) return;
  const width = graphWidth, height = graphHeight;
  scale = Math.min(1, Math.min(Math.max(1, $('#viewport').clientWidth - 35) / width, Math.max(1, $('#viewport').clientHeight - 35) / height));
  pan = { x: ($('#viewport').clientWidth - width * scale) / 2, y: ($('#viewport').clientHeight - height * scale) / 2 }; transform();
}
function focusNode(id) { const p = positions.get(id); if (!p) return; if (panelLayout) { [...document.querySelectorAll('[data-node-id]')].find(el => el.dataset.nodeId === id)?.scrollIntoView({ block: 'nearest' }); return; } scale = Math.max(.7, scale); pan = { x: $('#viewport').clientWidth / 2 - (p.x + CARD_WIDTH / 2) * scale, y: $('#viewport').clientHeight / 2 - (p.y + CARD_HEIGHT / 2) * scale }; transform(); }
function zoom(factor) { const rect = $('#viewport').getBoundingClientRect(), old = scale; scale = Math.min(1.6, Math.max(Math.min(.02, old), scale * factor)); pan.x = rect.width / 2 - (rect.width / 2 - pan.x) * scale / old; pan.y = rect.height / 2 - (rect.height / 2 - pan.y) * scale / old; transform(); }
function locateRoot() {
  // Reveal the current path's root without changing selection or opening a chat.
  ancestorAnchorId = null; graphSignature = ''; render();
  const root = ancestors(selectedId)[0] || getNode(selectedId);
  if (root) focusNode(root.id);
  saveTreeView();
}
$('#layout-toggle').onclick = () => { layoutChoice = panelLayout ? 'canvas' : 'panel'; persistPreferences(); updateLayout(); };
$('#fold-ancestors').onclick = () => foldParents(selectedId);
$('#fold-descendants').onclick = () => foldChildren(selectedId);
$('#expand-all').onclick = () => { collapsed.clear(); ancestorAnchorId = null; refreshGraph(); };
$('#locate-current').onclick = () => { revealNode(selectedId); graphSignature = ''; render(); requestAnimationFrame(() => focusNode(selectedId)); };
$('#locate-root').onclick = locateRoot;
narrowPanel.addEventListener('change', updateLayout);
new ResizeObserver(() => { if (!panelLayout && data) frameGraph(); }).observe($('#viewport'));
function endDrag() { if (drag) { try { $('#viewport').releasePointerCapture(drag.pointerId); } catch {} } drag = null; $('#viewport').classList.remove('dragging'); }
$('#viewport').addEventListener('pointerdown', event => { if (panelLayout || event.button !== 0 || event.target.closest('.graph-node,.folded-region')) return; drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, ...{ px: pan.x, py: pan.y } }; $('#viewport').setPointerCapture(event.pointerId); $('#viewport').classList.add('dragging'); });
$('#viewport').addEventListener('pointermove', event => { if (!drag || event.pointerId !== drag.pointerId) return; if (!event.buttons) { endDrag(); return; } pan.x = drag.px + event.clientX - drag.x; pan.y = drag.py + event.clientY - drag.y; transform(); });
for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) $('#viewport').addEventListener(event, endDrag);
window.addEventListener('blur', endDrag);
$('#viewport').addEventListener('wheel', event => {
  if (panelLayout) return;
  event.preventDefault();
  if (event.ctrlKey || event.metaKey) { if (event.deltaY) zoom(Math.exp(-event.deltaY * .002)); return; }
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? $('#viewport').clientHeight : 1;
  pan.x -= (event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX) * unit;
  pan.y -= (event.shiftKey && !event.deltaX ? 0 : event.deltaY) * unit;
  transform();
}, { passive: false });
$('#viewport').addEventListener('keydown', event => {
  if (panelLayout || event.target !== $('#viewport')) return;
  const moves = { ArrowUp: [0, 80], ArrowDown: [0, -80], ArrowLeft: [80, 0], ArrowRight: [-80, 0] };
  if (moves[event.key]) { event.preventDefault(); pan.x += moves[event.key][0]; pan.y += moves[event.key][1]; transform(); }
  else if (event.key === 'Home') { event.preventDefault(); locateRoot(); }
  else if (event.key === 'End') { event.preventDefault(); focusNode(selectedId); }
});
$('#zoom-in').onclick = () => zoom(1.2); $('#zoom-out').onclick = () => zoom(1 / 1.2); $('#fit').onclick = fit;
$('#search').oninput = () => { graphSignature = ''; render(); fit(); };
$('#only-current').onchange = () => { filterTouched = true; renderChat(); };
$('#answer-view').onchange = () => { answerView = $('#answer-view').value; persistPreferences(); updateLayout(); };
$('#navigate-on-select').onchange = () => { navigateOnSelect = $('#navigate-on-select').checked; persistPreferences(); };
$('#question').addEventListener('input', () => {
  const node = getNode(selectedId);
  if (node?.status === 'complete') { followups.set(node.id, $('#question').value); persistPreferences(); return; }
  if (node?.status !== 'draft') return;
  pendingDraft = { id: node.id, q: $('#question').value }; $('#draft-state').textContent = '正在保存草稿…'; clearTimeout(draftTimer); draftTimer = setTimeout(() => savePendingDraft().catch(() => {}), 400);
});
$('#composer').addEventListener('submit', async event => {
  event.preventDefault(); let node = getNode(selectedId); if (submitting || !node || !['draft', 'complete'].includes(node.status)) return;
  const question = $('#question').value.trim(); if (!question) { notice('请先输入问题。', true); return; }
  submitting = true; renderChat();
  try { await savePendingDraft();
    if (node.status === 'complete') {
      const parentId = node.id, snapshot = await act('create_branch', { parentId, question });
      node = snapshot.nodes.find(n => n.id === snapshot.tree.selectedId);
      followups.delete(parentId);
      persistPreferences();
    }
    const prior = requestIds.get(node.id), requestId = prior?.question === question ? prior.id : crypto.randomUUID(); requestIds.set(node.id, { id: requestId, question });
    autoOpenNodeId = node.id;
    await act('submit', { nodeId: node.id, question, requestId }); notice(data.tree.mode === 'demo' ? '正在生成演示回复，没有调用模型。' : answerView === 'native' && navigateOnSelect ? '正在生成分支回答，完成后打开原生聊天。' : '正在向 Codex 提问。');
  } catch (error) { showError(error); }
  finally { submitting = false; renderChat(); }
});
$('#cancel-draft').onclick = async () => { try { clearTimeout(draftTimer); pendingDraft = null; await draftQueue.catch(() => {}); await act('cancel_draft', { nodeId: selectedId }); notice('草稿已取消。'); } catch (error) { showError(error); } };
$('#stop').onclick = async () => { try { await act('stop', { nodeId: selectedId }); notice('已请求停止。'); } catch (error) { showError(error); } };
$('#recover').onclick = async () => { try { await act('recover', { nodeId: selectedId }); notice('已读取 Codex 的运行状态。'); } catch (error) { showError(error); } };
$('#tree-picker').onchange = async () => { const treeId = $('#tree-picker').value; mutationEpoch++; try { await savePendingDraft(); followCurrent = false; $('#follow-current').checked = false; apply(await api('state', { treeId })); } catch (error) { showError(error); } };
$('#follow-current').onchange = async () => {
  mutationEpoch++;
  try { await savePendingDraft(); followCurrent = $('#follow-current').checked; apply(await readCurrentState()); }
  catch (error) { showError(error); }
};
async function readCurrentState() {
  const snapshot = await api('state', { treeId: data?.tree?.id || requestedTreeId, followCurrent: Boolean(modelClient && followCurrent) });
  $('#sync-state').textContent = modelClient && followCurrent ? (snapshot.sourceSync?.available ? '已同步当前聊天' : '宿主未提供聊天标识') : '手动浏览';
  return snapshot;
}
$('#new-tree').onclick = () => { $('#create-dialog').showModal(); $('#create-form input[name="title"]').select(); };
$('#close-dialog').onclick = () => $('#create-dialog').close();
$('#create-form').onsubmit = async event => { event.preventDefault(); const values = Object.fromEntries(new FormData(event.target));
  try { await savePendingDraft(); followCurrent = false; $('#follow-current').checked = false; await act('create_tree', values); $('#create-dialog').close(); notice(values.mode === 'demo' ? '演示模式，不会调用模型。' : '真实 Codex 模式。输入问题后发送。'); $('#question').focus(); } catch (error) { showError(error); }
};
$('#doctor').onclick = async () => { $('#doctor').disabled = true; notice('正在检查本机 Codex；不会发送模型生成请求。');
  try { const result = await api('doctor'); const model = result.models.find(m => m.isDefault); notice(result.signedIn ? `Codex 已连接，支持精确回合分支。${model ? '默认模型：' + model.label : ''}` : 'Codex 可连接，但尚未登录。请先在本机完成 codex login。'); } catch (error) { showError(error); } finally { $('#doctor').disabled = false; }
};
$('#export').onclick = async () => { if (!data?.tree) return; try {
  await savePendingDraft(); const exported = await api('export_tree', { treeId: data.tree.id }); const json = JSON.stringify(exported, null, 2);
  const filename = 'branch-canvas-' + data.tree.id + '.json';
  if (modelClient) {
    try { const result = await modelClient.downloadFile({ contents: [{ type: 'resource', resource: { uri: 'file:///' + filename, mimeType: 'application/json', text: json } }] }); if (result.isError) throw new Error('Download unavailable'); }
    catch { $('#export-text').value = json; $('#export-dialog').showModal(); $('#export-text').select(); }
  } else {
    const blob = new Blob([json], { type: 'application/json' }), url = URL.createObjectURL(blob), link = create('a'); link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
  notice('导出包含完整可见问答及父子关系。');
} catch (error) { showError(error); } };
$('#close-export').onclick = () => $('#export-dialog').close();

function applyHostContext(ctx) {
  if (ctx?.theme) applyDocumentTheme(ctx.theme);
  if (ctx?.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  if (ctx?.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
}
async function init() {
  if (window.parent !== window) {
    modelClient = new App({ name: 'Branch Canvas', version: '0.1.0' });
    modelClient.onhostcontextchanged = applyHostContext;
    modelClient.ontoolinput = params => { if (typeof params.arguments?.treeId === 'string') requestedTreeId = params.arguments.treeId; };
    modelClient.ontoolresult = result => { if (!data && result._meta?.canvas && (!requestedTreeId || result._meta.canvas.tree?.id === requestedTreeId)) apply(result._meta.canvas); };
    await modelClient.connect();
    applyHostContext(modelClient.getHostContext());
    api = async (action, args = {}) => { const result = await modelClient.callServerTool({ name: 'canvas_action', arguments: { action, args } }); if (result.isError) throw new Error(result.content?.find(c => c.type === 'text')?.text || '插件操作失败。'); return result._meta?.canvas || result.structuredContent; };
    $('#surface-label').textContent = 'Codex 插件面板';
  } else {
    const token = $('meta[name="canvas-token"]').content;
    api = async (action, args = {}) => {
      const response = await fetch('/api/action', { method: 'POST', headers: { 'content-type': 'application/json', 'x-canvas-token': token }, body: JSON.stringify({ action, args }) });
      const result = await response.json(); if (!response.ok) throw new Error(result.error || '本地服务请求失败。'); return result;
    };
  }
  updateLayout();
  $('#follow-current').checked = followCurrent;
  apply(await readCurrentState()); notice(data.tree?.mode === 'codex' ? '真实 Codex 工作区。' : '演示树已打开。点击回答旁的 ＋，探索另一条路径。');
  setInterval(async () => {
    if (polling || !data?.tree || document.hidden) return;
    const epoch = mutationEpoch; polling = true;
    try { const snapshot = await readCurrentState(); if (epoch === mutationEpoch) apply(snapshot); $('#connection-error').hidden = true; }
    catch (error) { $('#connection-error').hidden = false; $('#connection-error').textContent = '连接中断：' + error.message + '。历史已保存在本机，恢复服务后会重新连接。'; }
    finally { polling = false; }
  }, 700);
}
init().catch(error => { $('#connection-error').hidden = false; $('#connection-error').textContent = error.message; notice('工作区尚未连接。', true); });
