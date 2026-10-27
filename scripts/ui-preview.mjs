import { CanvasService } from '../src/service.mjs';
import { createHttpServer } from '../src/http.mjs';

// A separate in-memory demo for appearance/interaction checks. Never connects
// to the installed database or a model; closing this process discards the demo.
const service = new CanvasService({ filename: ':memory:', seed: false });
const tree = service.store.createTree({ title: '对话树 · 设计与探索', mode: 'demo' });
const root = service.store.nodes(tree.id)[0];
service.store.updateNode(root.id, { q: '让每一种思路，都有自己的探索路径', answer: '从共同问题出发，分别探索交互设计、上下文隔离与原生聊天显示。所有方向都保留在同一棵树中。', status: 'complete' });
function answer(parent, q, text) {
  const draft = service.store.createDraft(tree.id, parent.id, q);
  return service.store.updateNode(draft.id, { status: 'complete', answer: text });
}
const a = answer(root, '如何让连续追问保持流畅？', '沿当前路径继续追问时复用同一聊天，在历史回答上另开方向时建立新分支。');
const a2 = answer(a, '收起上游历史，专注眼前的思路', '父节点可以暂时收起。当前回答和下游仍然可见，收起区域会保留数量与展开入口。');
answer(a2, '选中节点后，从这里继续追问', '画布下方是输入框，下面保留回答区。折叠只影响显示，问题与回答仍然完整保存。');
const b = answer(root, '原生聊天如何与树形导航配合？', '选中节点可以打开对应的原生聊天，使用文档、可视化和原生消息操作。');
answer(b, '每个分支保留独立的上下文', '兄弟分支共享共同历史，各自的后续追问和私有内容保持隔离。');
service.store.select(tree.id, a2.id);
const server = createHttpServer(service);
server.listen(47836, '127.0.0.1', () => console.log('Isolated UI preview ready at http://127.0.0.1:47836/'));
const shutdown = async () => { server.closeAllConnections(); server.close(); await service.close(); process.exit(0); };
process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
