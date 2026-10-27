const threadIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

export function nativeThreadLink(node) {
  // Thread IDs come from stored Codex records. Never forward model-provided URLs.
  return typeof node?.threadId === 'string' && threadIdPattern.test(node.threadId)
    ? `codex://threads/${node.threadId}` : null;
}

export async function requestNativeNavigation(node, host) {
  const url = nativeThreadLink(node);
  if (!url) throw new Error('这个节点还没有可打开的原生聊天。');
  if (!host?.openLink) throw new Error('请在 Codex 插件标签页中打开，或复制聊天链接。');
  const result = await host.openLink({ url });
  if (result?.isError) throw new Error('Codex 未接受聊天跳转，请使用下方的聊天链接。');
  return url;
}
