import { readFile, writeFile } from 'node:fs/promises';
import { sha256 } from './asar.mjs';

// Electron checks this resource against SHA-256 of the ASAR header JSON.
// Keep verification enabled and replace only the expected digest for the new bundle.
export function updateIntegrityResource(executable, before, after) {
  if (!/^[a-f0-9]{64}$/.test(before) || !/^[a-f0-9]{64}$/.test(after) || before === after) throw new Error('Invalid archive digest change.');
  const metadata = Buffer.from(JSON.stringify([{ file: 'resources\\app.asar', alg: 'SHA256', value: before }]));
  const start = executable.indexOf(metadata);
  if (start < 0 || executable.indexOf(metadata, start + 1) >= 0) throw new Error('The executable integrity resource does not uniquely match the original archive.');
  const offset = start + metadata.indexOf(before), result = Buffer.from(executable);
  result.write(after, offset, 64, 'ascii');
  return { bytes: result, digestOffset: offset, originalExecutableSha256: sha256(executable), patchedExecutableSha256: sha256(result) };
}
export async function syncExecutableIntegrity(path, before, after) {
  const change = updateIntegrityResource(await readFile(path), before, after);
  await writeFile(path, change.bytes);
  if (sha256(await readFile(path)) !== change.patchedExecutableSha256) throw new Error('Executable integrity resource readback failed.');
  const { bytes, ...report } = change;
  return { ...report, expectedArchiveHeaderSha256: after, originalPublisherSignaturePreserved: false };
}
