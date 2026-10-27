import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
await mkdir(join(root, 'dist'), { recursive: true });
await build({ entryPoints: [join(root, 'web', 'app.mjs')], bundle: true, outfile: join(root, 'dist', 'app.js'), format: 'iife', platform: 'browser', target: 'es2022', minify: true });
const html = await readFile(join(root, 'web', 'index.html'), 'utf8');
const css = await readFile(join(root, 'web', 'style.css'), 'utf8');
const js = await readFile(join(root, 'dist', 'app.js'), 'utf8');
await writeFile(join(root, 'dist', 'index.html'), html);
await writeFile(join(root, 'dist', 'style.css'), css);
await writeFile(join(root, 'dist', 'mcp-app.html'), html
  .replace('<link rel="stylesheet" href="/style.css">', () => `<style>${css}</style>`)
  .replace('<script src="/app.js" defer></script>', () => `<script>${js.replaceAll('</script', '<\\/script')}</script>`));
for (const entry of ['mcp', 'http', 'worker']) await build({
  entryPoints: [join(root, 'src', entry + '.mjs')], bundle: true, outfile: join(root, 'dist', entry + '.mjs'),
  platform: 'node', target: 'node24', format: 'esm', minify: false,
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" }
});
console.log('Built standalone UI and self-contained MCP App.');
