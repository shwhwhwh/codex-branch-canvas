import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
for (const folder of ['src', 'web', 'scripts', 'tests', 'desktop-patch']) for (const file of await readdir(folder)) {
  if (!/\.(mjs|cjs)$/.test(file)) continue;
  const result = spawnSync(process.execPath, ['--check', resolve(join(folder, file))], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log('Syntax checks passed.');
