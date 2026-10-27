import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeThreadLink, requestNativeNavigation } from '../web/navigation.mjs';

const node = { threadId: '11111111-1111-4111-8111-111111111111', turnId: '22222222-2222-4222-8222-222222222222' };

test('native navigation only builds canonical existing-thread links, without inventing turn anchors', () => {
  assert.equal(nativeThreadLink(node), 'codex://threads/' + node.threadId);
  for (const threadId of ['', '../new', 'new?prompt=run', 'https://example.com', node.threadId + '?prompt=unexpected']) assert.equal(nativeThreadLink({ threadId }), null);
  assert.equal(nativeThreadLink(null), null);
});

test('native navigation uses the host bridge and reports denial instead of pretending it navigated', async () => {
  const opened = [];
  const host = { openLink: async value => { opened.push(value); return {}; } };
  assert.equal(await requestNativeNavigation(node, host), 'codex://threads/' + node.threadId);
  assert.deepEqual(opened, [{ url: 'codex://threads/' + node.threadId }]);
  await assert.rejects(requestNativeNavigation(node, { openLink: async () => ({ isError: true }) }), /未接受/);
  await assert.rejects(requestNativeNavigation(node, null), /插件标签页/);
  await assert.rejects(requestNativeNavigation({}, host), /没有可打开/);
});
