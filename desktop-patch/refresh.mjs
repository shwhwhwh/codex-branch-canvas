import { readFile, writeFile, copyFile, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { expected, createReplacements } from './prepare.mjs';
import { patchAsar, readAsar, sha256 } from './asar.mjs';
import { syncExecutableIntegrity } from './integrity.mjs';

// Refresh only an existing, stopped experiment copy. Never writes to sourceApp.
export async function refresh(outputRoot) {
  const here = dirname(fileURLToPath(import.meta.url));
  outputRoot = resolve(outputRoot);
  const belowArtifacts = relative(resolve(here, '..', 'artifacts'), outputRoot);
  if (!belowArtifacts || belowArtifacts === '..' || belowArtifacts.startsWith('..' + sep) || resolve(belowArtifacts) === belowArtifacts) throw new Error('Expected an experiment folder under project artifacts.');
  const reportPath = join(outputRoot, 'patch-report.json');
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  const outputApp = join(outputRoot, 'app'), exePath = join(outputApp, 'ChatGPT.exe');
  if (resolve(report.outputApp) !== outputApp || resolve(report.sourceApp) === outputApp) throw new Error('Experiment paths do not match the report.');
  const processCheck = `$ErrorActionPreference='Stop'; @(Get-Process -Name ChatGPT -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq '${exePath.replaceAll("'", "''")}' } | ForEach-Object { $_.Id }) | ConvertTo-Json -Compress`;
  const running = execFileSync('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(processCheck, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true }).trim();
  if (running) throw new Error('Close the experiment copy before refreshing it. The original desktop may stay open.');
  const originalPath = join(report.sourceApp, 'resources', 'app.asar');
  const original = await readAsar(originalPath), sourceFiles = {};
  let originalDigest;
  try {
    originalDigest = original.headerJsonSha256;
    for (const [name, hash] of Object.entries(expected)) {
      const bytes = await original.read(name);
      if (sha256(bytes) !== hash) throw new Error('Original desktop version changed: ' + name);
      sourceFiles[name] = bytes.toString();
    }
  } finally { await original.close(); }
  const originalExe = await readFile(join(report.sourceApp, 'ChatGPT.exe'));
  if (sha256(originalExe) !== report.executableIntegrity.originalExecutableSha256) throw new Error('Original executable has changed.');
  const replacements = await createReplacements(sourceFiles, report);
  const asarPath = join(outputApp, 'resources', 'app.asar');
  const stagedAsar = asarPath + '.updated', stagedExe = exePath + '.updated';
  await patchAsar(originalPath, stagedAsar, replacements);
  const check = await readAsar(stagedAsar), hashes = {};
  const nextDigest = check.headerJsonSha256;
  try {
    for (const [name, value] of Object.entries(replacements)) {
      const bytes = await check.read(name), hash = sha256(bytes);
      if (hash !== sha256(Buffer.from(value)) || check.entry(name).integrity.hash !== hash) throw new Error('Readback failed: ' + name);
      hashes[name] = hash;
    }
  } finally { await check.close(); }
  await writeFile(stagedExe, originalExe, { flag: 'wx' });
  const executableIntegrity = await syncExecutableIntegrity(stagedExe, originalDigest, nextDigest);
  // Retain one previous pair. If a file is in use, Windows refuses the rename.
  await rm(asarPath + '.previous', { force: true });
  await rm(exePath + '.previous', { force: true });
  await rename(asarPath, asarPath + '.previous');
  try { await rename(exePath, exePath + '.previous'); }
  catch (error) { await rename(asarPath + '.previous', asarPath); throw error; }
  try { await rename(stagedAsar, asarPath); await rename(stagedExe, exePath); }
  catch (error) {
    await rm(asarPath, { force: true }); await rm(exePath, { force: true });
    await rename(asarPath + '.previous', asarPath); await rename(exePath + '.previous', exePath); throw error;
  }
  const iniPath = join(outputApp, 'resources', 'owl-app.ini');
  const ini = await readFile(iniPath, 'utf8');
  if (!/^UserDataDirectoryName=(Codex|CodexBranchCanvas)\r?$/m.test(ini)) throw new Error('Unexpected desktop profile configuration.');
  await writeFile(iniPath, ini.replace(/^UserDataDirectoryName=(Codex|CodexBranchCanvas)\r?$/m, 'UserDataDirectoryName=CodexBranchCanvas'));
  const launch = (await readFile(join(here, 'launch.ps1'), 'utf8')).replace('__ORIGINAL_APP__', report.sourceApp.replaceAll("'", "''"));
  await writeFile(join(outputRoot, 'launch.ps1'), '\ufeff' + launch);
  await copyFile(join(here, 'README.md'), join(outputRoot, 'README.md'));
  const nextReport = { ...report, refreshedAt: new Date().toISOString(), modifiedFiles: hashes, executableIntegrity, isolatedDesktopProfile: true, launcherVerifiesNativePatch: true, desktopLaunchVerified: false, nativeHeadlessStartupPassed: false, nativeSummaryUiVerified: false };
  delete nextReport.headlessSelfTest; delete nextReport.finalTests;
  await writeFile(reportPath, JSON.stringify(nextReport, null, 2) + '\n');
  return { outputRoot, modifiedFiles: Object.keys(hashes).length, originalFilesUnchanged: true, isolatedDesktopProfile: true };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await refresh(process.argv[2])));
