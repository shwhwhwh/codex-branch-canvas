import { open, mkdir, rename, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export async function readAsar(filename) {
  const handle = await open(filename, 'r');
  try {
    const pre = Buffer.alloc(16); await handle.read(pre, 0, 16, 0);
    if (pre.readUInt32LE(0) !== 4 || pre.readUInt32LE(12) > 64 * 1024 * 1024) throw new Error('Unsupported ASAR header.');
    const bytes = Buffer.alloc(pre.readUInt32LE(12)); await handle.read(bytes, 0, bytes.length, 16);
    const header = JSON.parse(bytes.toString('utf8')), base = 8 + pre.readUInt32LE(4);
    const size = (await handle.stat()).size;
    const entry = path => path.split('/').reduce((node, name) => node?.files?.[name], header);
    const read = async path => {
      const file = entry(path);
      if (!file || file.files || file.unpacked || file.link) throw new Error(`Not a packed file: ${path}`);
      const start = base + Number(file.offset), length = Number(file.size);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < base || start + length > size) throw new Error(`Invalid ASAR range: ${path}`);
      const value = Buffer.alloc(length); const result = await handle.read(value, 0, length, start);
      if (result.bytesRead !== length) throw new Error(`Truncated ASAR file: ${path}`);
      return value;
    };
    return { handle, header, headerJsonSha256: sha256(bytes), base, size, entry, read, close: () => handle.close() };
  } catch (error) { await handle.close(); throw error; }
}

function integrity(bytes, blockSize = 4 * 1024 * 1024) {
  const blocks = [];
  for (let at = 0; at < bytes.length; at += blockSize) blocks.push(sha256(bytes.subarray(at, at + blockSize)));
  return { algorithm: 'SHA256', hash: sha256(bytes), blockSize, blocks };
}
export async function patchAsar(input, output, replacements) {
  if (resolve(input) === resolve(output)) throw new Error('The source archive cannot be overwritten.');
  const archive = await readAsar(input), temp = output + '.partial';
  let target, created = false;
  try {
    const payloads = []; let offset = archive.size - archive.base;
    for (const [path, value] of Object.entries(replacements)) {
      if (path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid archive path.');
      const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
      const parts = path.split('/'); let parent = archive.header;
      for (const part of parts.slice(0, -1)) { parent.files ||= {}; parent.files[part] ||= { files: {} }; parent = parent.files[part]; }
      parent.files ||= {};
      parent.files[parts.at(-1)] = { size: bytes.length, offset: String(offset), integrity: integrity(bytes) };
      payloads.push(bytes); offset += bytes.length;
    }
    const json = Buffer.from(JSON.stringify(archive.header)), padding = (4 - json.length % 4) % 4;
    const header = Buffer.alloc(8 + json.length + padding);
    header.writeUInt32LE(header.length - 4, 0); header.writeUInt32LE(json.length, 4); json.copy(header, 8);
    const prefix = Buffer.alloc(8); prefix.writeUInt32LE(4, 0); prefix.writeUInt32LE(header.length, 4);
    await mkdir(dirname(output), { recursive: true }); target = await open(temp, 'wx'); created = true;
    await target.writeFile(prefix); await target.writeFile(header);
    const chunk = Buffer.alloc(8 * 1024 * 1024);
    for (let at = archive.base; at < archive.size;) {
      const { bytesRead } = await archive.handle.read(chunk, 0, Math.min(chunk.length, archive.size - at), at);
      if (!bytesRead) throw new Error('Source archive ended unexpectedly.');
      await target.writeFile(chunk.subarray(0, bytesRead)); at += bytesRead;
    }
    for (const bytes of payloads) await target.writeFile(bytes);
    await target.sync(); await target.close(); target = null;
    await rename(temp, output);
  } catch (error) { await target?.close(); if (created) await rm(temp, { force: true }); throw error; }
  finally { await archive.close(); }
}
