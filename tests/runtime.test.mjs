import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sharedRuntime } from '../src/runtime.mjs';

test('a stale endpoint after desktop shutdown restarts the backend without crashing and both clients share it', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'canvas-runtime-restart-'));
  const filename = join(folder, 'canvas.sqlite'), metadata = filename + '.runtime.json';
  const staleAddress = process.platform === 'win32' ? `\\\\.\\pipe\\missing-canvas-${randomUUID()}` : join(folder, 'missing.sock');
  await writeFile(metadata, JSON.stringify({ version: 1, pid: 0, address: staleAddress, token: 'expired' }));
  let first, second, owner;
  try {
    first = await sharedRuntime({ filename, cwd: folder });
    owner = JSON.parse(await readFile(metadata, 'utf8')).pid;
    assert.ok(owner > 0); assert.notEqual(owner, process.pid);
    const before = await first.snapshot();
    second = await sharedRuntime({ filename, cwd: folder });
    const after = await second.snapshot();
    assert.equal(after.tree.id, before.tree.id);
    assert.equal(JSON.parse(await readFile(metadata, 'utf8')).pid, owner);
  } finally {
    await first?.close(); await second?.close();
    // This PID came from the worker this test just started for its unique DB.
    if (owner) try { process.kill(owner, 'SIGTERM'); } catch {}
  }
});
