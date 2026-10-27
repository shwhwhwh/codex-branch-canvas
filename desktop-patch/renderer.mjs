// This component uses the desktop's own React instance and native summary Section.
// Its only transport is the small, dedicated preload bridge; no iframe or HTTP UI.
export function createNativeSummarySection(React, Section) {
  const h = React.createElement;
  const labels = { draft: '草稿', queued: '等待连接', running: '正在回复', complete: '已完成', interrupted: '已停止', failed: '未完成', uncertain: '待确认' };
  const css = `.bc-native{font-size:12px;line-height:1.5;min-width:0}.bc-native *{box-sizing:border-box}.bc-native button,.bc-native select,.bc-native input,.bc-native textarea{font:inherit;color:inherit;background:transparent;border:1px solid color-mix(in srgb,currentColor 18%,transparent);border-radius:7px;padding:5px 7px;min-width:0}.bc-native button{cursor:pointer}.bc-native button:disabled{opacity:.45;cursor:default}.bc-native button:focus-visible,.bc-native select:focus-visible,.bc-native textarea:focus-visible{outline:2px solid #9b8ac2;outline-offset:2px}.bc-native .bc-picker{display:flex;gap:5px;margin-bottom:8px}.bc-native select{width:100%;text-overflow:ellipsis}.bc-native .bc-tree{max-height:260px;overflow:auto;display:flex;flex-direction:column;gap:3px}.bc-native .bc-row{display:flex;gap:4px;align-items:center;padding:4px;border-radius:7px;margin-left:calc(var(--depth)*10px)}.bc-native .bc-row[aria-current=true]{background:color-mix(in srgb,#9b8ac2 20%,transparent)}.bc-native .bc-node{flex:1;text-align:left;border:0;overflow:hidden}.bc-native .bc-node span{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}.bc-native .bc-node small,.bc-native .bc-muted{opacity:.65;font-size:10px}.bc-native .bc-plus{font-size:16px;min-width:28px;padding:1px 5px}.bc-native .bc-fold{min-width:24px;padding:2px}.bc-native .bc-detail{border-top:1px solid color-mix(in srgb,currentColor 14%,transparent);margin-top:10px;padding-top:10px}.bc-native .bc-answer{max-height:240px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;margin:7px 0}.bc-native textarea{display:block;width:100%;min-height:86px;resize:vertical;margin-top:7px}.bc-native .bc-actions{display:flex;gap:5px;justify-content:flex-end;flex-wrap:wrap;margin-top:7px}.bc-native .bc-error{color:#d77e7e;overflow-wrap:anywhere;margin:7px 0}.bc-native .bc-new{display:grid;gap:6px;margin:7px 0}.bc-native .bc-new input{width:100%}.bc-native .bc-status{margin-top:7px;font-size:10px;opacity:.65}`;

  return function NativeSummaryTree({ conversationId, hostId }) {
    const [state, setState] = React.useState(null), [catalog, setCatalog] = React.useState(null);
    const [error, setError] = React.useState(''), [busy, setBusy] = React.useState(false);
    const [question, setQuestion] = React.useState(''), [folded, setFolded] = React.useState(new Set());
    const [newTree, setNewTree] = React.useState(false), [title, setTitle] = React.useState('新的探索');
    const [mode, setMode] = React.useState('codex');
    const stateRef = React.useRef(null), draft = React.useRef({ id: null, value: '', dirty: false });
    const queue = React.useRef(Promise.resolve()), timer = React.useRef(null), textArea = React.useRef(null);
    const active = React.useRef(true), busyRef = React.useRef(false), keys = React.useRef(new Map());
    const identity = { hostId, conversationId };
    const bridge = payload => {
      if (!window.branchCanvasNative?.request) return Promise.reject(new Error('桌面内部通信桥未加载，请用实验副本的启动入口打开。'));
      return window.branchCanvasNative.request(payload);
    };
    function fail(reason) { if (active.current) setError(reason.message || String(reason)); }
    function apply(next) {
      if (!next?.nodes || !active.current) return;
      const node = next.nodes.find(item => item.id === next.tree.selectedId) || next.nodes[0];
      if (draft.current.id !== node?.id) {
        draft.current = { id: node?.id, value: node?.status === 'draft' ? node.q : '', dirty: false };
        setQuestion(draft.current.value);
      }
      stateRef.current = next; setState(next);
    }
    function flush() {
      clearTimeout(timer.current);
      if (!draft.current.dirty) return queue.current;
      const pending = { ...draft.current }; draft.current.dirty = false;
      const promise = queue.current.catch(() => {}).then(() => bridge({ kind: 'action', action: 'save_draft', args: { nodeId: pending.id, question: pending.value } }));
      queue.current = promise.catch(reason => { if (draft.current.id === pending.id) draft.current.dirty = true; fail(reason); throw reason; });
      return queue.current;
    }
    async function action(name, args = {}) {
      if (busyRef.current) return;
      busyRef.current = true; setBusy(true); setError('');
      try { await flush(); const next = await bridge({ kind: 'action', action: name, args }); apply(next); return next; }
      catch (reason) { fail(reason); }
      finally { busyRef.current = false; if (active.current) setBusy(false); }
    }
    async function bind(treeId) {
      if (!treeId || busyRef.current) return;
      busyRef.current = true; setBusy(true); setError('');
      try { await flush(); const next = await bridge({ kind: 'binding_set', ...identity, treeId }); apply(next); setCatalog({ trees: next.trees, boundTreeId: treeId }); setFolded(new Set()); }
      catch (reason) { fail(reason); }
      finally { busyRef.current = false; if (active.current) setBusy(false); }
    }
    React.useEffect(() => {
      active.current = true; let cancelled = false, polling = false;
      stateRef.current = null; setState(null); setCatalog(null); setError('');
      bridge({ kind: 'binding_get', ...identity }).then(async result => {
        if (cancelled) return; setCatalog(result);
        if (result.boundTreeId) { const next = await bridge({ kind: 'state', treeId: result.boundTreeId }); if (!cancelled) apply(next); }
      }).catch(fail);
      const interval = setInterval(async () => {
        if (cancelled || polling || document.hidden || busyRef.current || draft.current.dirty || !stateRef.current?.tree) return;
        polling = true;
        try { const next = await bridge({ kind: 'state', treeId: stateRef.current.tree.id }); if (!cancelled) apply(next); }
        catch (reason) { if (!cancelled) fail(reason); }
        finally { polling = false; }
      }, 1000);
      return () => { cancelled = true; active.current = false; clearInterval(interval); clearTimeout(timer.current); flush().catch(() => {}); };
    }, [hostId, conversationId]);
    const node = state?.nodes.find(item => item.id === state.tree.selectedId) || state?.nodes[0];
    React.useEffect(() => { if (node?.status === 'draft') textArea.current?.focus(); }, [node?.id]);
    const rows = [];
    if (state) {
      const children = new Map(); for (const item of state.nodes) { const siblings = children.get(item.parentId) || []; siblings.push(item); children.set(item.parentId, siblings); }
      const seen = new Set();
      const visit = (item, depth) => { if (seen.has(item.id)) return; seen.add(item.id); const kids = children.get(item.id) || []; rows.push({ item, depth, kids }); if (!folded.has(item.id)) kids.forEach(child => visit(child, depth + 1)); };
      (children.get(null) || []).forEach(root => visit(root, 0));
    }
    const treePicker = h('div', { className: 'bc-picker' },
      h('select', { 'aria-label': '绑定到当前聊天的对话树', value: state?.tree.id || '', disabled: busy || !catalog, onChange: event => bind(event.target.value) },
        h('option', { value: '', disabled: true }, catalog ? '选择一棵树绑定此聊天…' : '正在连接对话树…'),
        ...(catalog?.trees || []).map(tree => h('option', { key: tree.id, value: tree.id }, tree.title))),
      h('button', { type: 'button', onClick: () => setNewTree(!newTree), disabled: busy, title: '新建对话树' }, '新建'));
    const newForm = newTree && h('form', { className: 'bc-new', onSubmit: async event => {
      event.preventDefault(); const next = await action('create_tree', { title, mode });
      if (next?.tree) { setCatalog({ trees: next.trees }); await bind(next.tree.id); setNewTree(false); }
    } }, h('input', { value: title, maxLength: 120, required: true, 'aria-label': '新对话树名称', onChange: event => setTitle(event.target.value) }),
    h('select', { value: mode, 'aria-label': '对话树模式', onChange: event => setMode(event.target.value) }, h('option', { value: 'codex' }, '真实 Codex · 只读讨论'), h('option', { value: 'demo' }, '演示 · 不调用模型')),
    h('button', { type: 'submit', disabled: busy }, '建立并绑定此聊天'));
    const treeRows = h('div', { className: 'bc-tree', 'aria-label': '摘要中的对话树' }, rows.map(({ item, depth, kids }) =>
      h('div', { key: item.id, className: 'bc-row', 'aria-current': item.id === node?.id ? 'true' : undefined, style: { '--depth': Math.min(depth, 4) } },
        kids.length > 0 && h('button', { className: 'bc-fold', type: 'button', title: folded.has(item.id) ? '展开子分支' : '折叠子分支', 'aria-expanded': !folded.has(item.id), onClick: () => setFolded(previous => { const next = new Set(previous); next.has(item.id) ? next.delete(item.id) : next.add(item.id); return next; }) }, folded.has(item.id) ? '›' : '⌄'),
        h('button', { className: 'bc-node', type: 'button', disabled: busy, onClick: () => action('select_node', { nodeId: item.id }) }, h('span', null, item.q || '新追问 · 草稿'), h('small', null, labels[item.status] || item.status)),
        item.status === 'complete' && h('button', { className: 'bc-plus', type: 'button', disabled: busy, title: '从这个回答创建分支追问', 'aria-label': `从回答创建分支：${item.q}`, onClick: () => action('create_branch', { parentId: item.id }) }, '＋'))));
    const detail = node && h('div', { className: 'bc-detail' },
      h('div', { className: 'bc-muted' }, state.tree.mode === 'codex' ? '真实 Codex · 只读讨论' : '演示模式 · 不调用模型'),
      node.status !== 'draft' && h('div', { className: 'bc-answer' }, node.answer || '正在组织回复…'),
      node.error && h('div', { className: 'bc-error', role: 'alert' }, node.error),
      node.status === 'draft' && h('form', { onSubmit: event => {
        event.preventDefault(); const value = question.trim(); if (!value) return;
        const previous = keys.current.get(node.id), key = previous?.value === value ? previous.id : crypto.randomUUID(); keys.current.set(node.id, { id: key, value });
        action('submit', { nodeId: node.id, question: value, requestId: key });
      } }, h('textarea', { ref: textArea, value: question, maxLength: 20000, 'aria-label': '分支追问', placeholder: '在这个分支继续追问…', disabled: busy, onChange: event => {
        const value = event.target.value; setQuestion(value); draft.current = { id: node.id, value, dirty: true }; clearTimeout(timer.current); timer.current = setTimeout(() => flush().catch(() => {}), 350);
      } }), h('div', { className: 'bc-actions' }, node.parentId && h('button', { type: 'button', disabled: busy, onClick: () => action('cancel_draft', { nodeId: node.id }) }, '取消草稿'), h('button', { type: 'submit', disabled: busy || !question.trim() }, '发送'))),
      ['queued', 'running'].includes(node.status) && h('div', { className: 'bc-actions' }, h('button', { type: 'button', disabled: busy, onClick: () => action('stop', { nodeId: node.id }) }, '停止')),
      node.status === 'uncertain' && h('div', { className: 'bc-actions' }, h('button', { type: 'button', disabled: busy, onClick: () => action('recover', { nodeId: node.id }) }, '检查运行状态')));
    return h(Section, { sectionKey: 'branch-canvas-native', title: '对话树', mode: 'accordion', defaultCollapsed: false },
      h('div', { className: 'bc-native', 'data-branch-canvas-native': 'true' }, h('style', null, css), treePicker, newForm,
        error && h('div', { className: 'bc-error', role: 'alert' }, error),
        !state && catalog && h('p', { className: 'bc-muted' }, '选择或新建一棵树，与当前聊天关联。现有聊天记录不会自动导入。'),
        treeRows, detail, state && h('div', { className: 'bc-status' }, `${state.nodes.length} 个节点 · 历史保存在本机`)));
  };
}
