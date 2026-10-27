import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createMarkdownRenderer } from '../web/markdown.mjs';

function render(source) {
  const dom = new JSDOM('<!doctype html>');
  dom.window.document.body.append(createMarkdownRenderer(dom.window)(source));
  return dom.window.document.body;
}

test('answers render semantic Markdown, tables and literal fenced code', () => {
  const body = render('# Result\n\n**Strong** and `inline`\n\n- one\n- two\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n```javascript\nconst html = "<img onerror=alert(1)>";\n```');
  assert.equal(body.querySelector('h1').textContent, 'Result');
  assert.equal(body.querySelector('strong').textContent, 'Strong');
  assert.equal(body.querySelectorAll('li').length, 2);
  assert.equal(body.querySelectorAll('.table-scroll table td').length, 2);
  assert.equal(body.querySelector('pre code').textContent, 'const html = "<img onerror=alert(1)>";\n');
  assert.equal(body.querySelector('button').textContent, '复制代码');
  assert.equal(body.querySelector('img'), null);
});

test('model HTML and unsafe links cannot add active content or remote images', () => {
  const body = render('<script>alert(1)</script>\n\n<img src="https://tracker.invalid" onerror="alert(1)">\n\n[bad](javascript:alert%281%29) [file](file:///C:/secrets) [safe](https://example.com)\n\n![alt](https://tracker.invalid/image.png)');
  assert.equal(body.querySelector('script,img,iframe,style'), null);
  for (const element of body.querySelectorAll('*')) for (const attribute of element.attributes) assert.ok(!/^on|^style$/i.test(attribute.name));
  assert.equal(body.querySelector('a').hasAttribute('href'), false);
  assert.equal(body.querySelectorAll('a')[1].hasAttribute('href'), false);
  const safe = body.querySelector('a[href="https://example.com"]');
  assert.equal(safe.rel, 'noopener noreferrer');
  assert.equal(safe.target, '_blank');
});

test('task lists stay inert and code copy retains the original text', async () => {
  const dom = new JSDOM('<!doctype html>');
  let copied;
  Object.defineProperty(dom.window.navigator, 'clipboard', { value: { writeText: async value => { copied = value; } } });
  dom.window.document.body.append(createMarkdownRenderer(dom.window)('- [x] done\n\n```json\n{"a":1}\n```'));
  assert.equal(dom.window.document.querySelector('input').disabled, true);
  dom.window.document.querySelector('button').click();
  await Promise.resolve();
  assert.equal(copied, '{"a":1}\n');
  dom.window.close();
});
