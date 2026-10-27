// Folding is a view operation. Native turns and stored parent links stay intact.
export function ancestorIds(nodes, id) {
  const byId = new Map(nodes.map(node => [node.id, node])), result = [], seen = new Set([id]);
  let parent = byId.get(id)?.parentId;
  while (parent && byId.has(parent) && !seen.has(parent)) {
    seen.add(parent); result.unshift(parent); parent = byId.get(parent).parentId;
  }
  return result;
}

export function displayForest(nodes, { collapsed = new Set(), ancestorAnchorId = null, query = '' } = {}) {
  const byId = new Map(nodes.map(node => [node.id, node])), kids = new Map();
  for (const node of nodes) {
    const siblings = kids.get(node.parentId) || []; siblings.push(node); kids.set(node.parentId, siblings);
  }
  const search = query.trim().toLowerCase(), keep = new Set();
  if (search) for (const node of nodes) if ((node.q + '\n' + node.answer).toLowerCase().includes(search)) {
    keep.add(node.id); ancestorIds(nodes, node.id).forEach(id => keep.add(id));
  }
  const included = node => !search || keep.has(node.id);
  const hiddenAncestors = new Set(search ? [] : ancestorIds(nodes, ancestorAnchorId));
  const descendants = (node, seen = new Set()) => {
    if (seen.has(node.id)) return [];
    seen.add(node.id);
    return (kids.get(node.id) || []).flatMap(child => [child.id, ...descendants(child, seen)]);
  };
  const visited = new Set();
  function visit(node) {
    if (!included(node) || visited.has(node.id)) return null;
    visited.add(node.id);
    if (hiddenAncestors.has(node.id)) {
      const hiddenIds = [], boundary = [];
      function absorb(current) {
        hiddenIds.push(current.id);
        for (const child of kids.get(current.id) || []) {
          if (hiddenAncestors.has(child.id) && !visited.has(child.id)) { visited.add(child.id); absorb(child); }
          else { const displayed = visit(child); if (displayed) boundary.push(displayed); }
        }
      }
      absorb(node);
      return { kind: 'ancestors', id: 'ancestors:' + node.id, anchorId: ancestorAnchorId, hiddenIds, children: boundary };
    }
    const hiddenIds = descendants(node);
    const children = !search && collapsed.has(node.id) && hiddenIds.length
      ? [{ kind: 'descendants', id: 'descendants:' + node.id, anchorId: node.id, hiddenIds, children: [] }]
      : (kids.get(node.id) || []).map(visit).filter(Boolean);
    return { kind: 'node', id: node.id, node, descendantCount: hiddenIds.length, children };
  }
  const forest = nodes.filter(node => !node.parentId || !byId.has(node.parentId)).map(visit).filter(Boolean);
  return { forest, hiddenAncestors };
}

export const CARD_WIDTH = 264, CARD_HEIGHT = 154;
export function layoutForest(forest) {
  const positions = new Map(), sizes = new Map(); let sequence = 0, maxBottom = CARD_HEIGHT + 28;
  const width = item => {
    const value = Math.max(CARD_WIDTH, item.children.reduce((sum, child) => sum + width(child), 0) + Math.max(0, item.children.length - 1) * 32);
    sizes.set(item.id, value); return value;
  };
  forest.forEach(width);
  function place(item, left, depth, top) {
    const span = sizes.get(item.id), height = item.kind === 'node' ? CARD_HEIGHT : 52;
    positions.set(item.id, { x: left + (span - CARD_WIDTH) / 2, y: top, width: CARD_WIDTH, height, depth, order: sequence++, item });
    maxBottom = Math.max(maxBottom, top + height);
    let childLeft = left;
    for (const child of item.children) { place(child, childLeft, depth + 1, top + height + 66); childLeft += sizes.get(child.id) + 32; }
  }
  let left = 28;
  for (const item of forest) { place(item, left, 0, 28); left += sizes.get(item.id) + 48; }
  return { positions, width: Math.max(CARD_WIDTH + 56, left - 20), height: maxBottom + 28 };
}
