import { Marked } from 'marked';
import createDOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import json from 'highlight.js/lib/languages/json';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';

for (const [name, language] of Object.entries({ javascript, typescript, python, json, bash, css, xml })) hljs.registerLanguage(name, language);
const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

// A separate renderer keeps chat content out of the app's own HTML and controls.
export function createMarkdownRenderer(window) {
  const purify = createDOMPurify(window);
  const marked = new Marked({ gfm: true, breaks: false, renderer: {
    html: ({ text }) => escape(text),
    image: ({ href, text }) => `<a href="${escape(href)}">${escape(text || '图片')}</a>`,
  } });
  return markdown => {
    const fragment = purify.sanitize(marked.parse(markdown || ''), {
      RETURN_DOM_FRAGMENT: true,
      ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'del', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'hr', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'input'],
      ALLOWED_ATTR: ['href', 'title', 'class', 'start', 'align', 'type', 'checked', 'disabled'],
    });
    for (const link of fragment.querySelectorAll('a')) {
      const href = link.getAttribute('href');
      // No file, data or custom-protocol navigation from untrusted model output.
      if (!href || !/^(https?:\/\/|mailto:|#)/i.test(href)) link.removeAttribute('href');
      else { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
    }
    for (const input of fragment.querySelectorAll('input')) {
      if (input.type !== 'checkbox') input.remove();
      else { input.disabled = true; input.tabIndex = -1; }
    }
    for (const code of fragment.querySelectorAll('pre > code')) {
      const source = code.textContent;
      const language = [...code.classList].find(name => name.startsWith('language-'))?.slice(9) || '';
      if (source.length < 50000 && language && hljs.getLanguage(language)) code.innerHTML = hljs.highlight(source, { language }).value;
      const pre = code.parentElement, block = window.document.createElement('div'), header = window.document.createElement('div');
      block.className = 'code-block'; header.className = 'code-header';
      const label = window.document.createElement('span'), copy = window.document.createElement('button');
      label.textContent = language || '代码'; copy.type = 'button'; copy.className = 'copy-code'; copy.textContent = '复制代码';
      copy.setAttribute('aria-label', `复制${language ? ' ' + language : ''}代码`);
      copy.addEventListener('click', async () => {
        try { await window.navigator.clipboard.writeText(source); copy.textContent = '已复制'; }
        catch { copy.textContent = '复制失败，请选择代码复制'; }
        window.setTimeout(() => { copy.textContent = '复制代码'; }, 1800);
      });
      header.append(label, copy); pre.replaceWith(block); block.append(header, pre);
    }
    for (const table of fragment.querySelectorAll('table')) {
      const wrapper = window.document.createElement('div'); wrapper.className = 'table-scroll'; table.replaceWith(wrapper); wrapper.append(table);
    }
    return fragment;
  };
}
