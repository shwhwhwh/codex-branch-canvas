import { cp, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, transform } from 'esbuild';
import { patchAsar, readAsar, sha256 } from './asar.mjs';
import { syncExecutableIntegrity } from './integrity.mjs';

export const expected = {
  '.vite/build/early-bootstrap.js': 'a9bcc31c89a0ff39848ba5252e7e446c20966a028035342ec327c0a9e0649ecc',
  '.vite/build/preload.js': 'a3e622f8d80a83e58fb3cfcc640fa7e14e6461cccdae9ef7d7b0c821dde256b7',
  'webview/assets/local-conversation-summary-panel-artifacts-section-d8157b10ca72.js': '31ba43d577b7e1d504fa9bbc8847e336bd7d4f256feedc9a78a72c041033ec26'
};
export function rendererPatch(original) {
  const anchor = 'zi as t';
  if (original.split(anchor).length !== 2 || original.includes('__branchCanvasWrappedArtifacts')) throw new Error('The summary component does not match this patch version.');
  const imports = 'import {FBt as __branchCanvasGetReact} from "./app-shared-2feb3d4c6fcc.js";\nimport {createNativeSummarySection as __branchCanvasFactory} from "./branch-canvas-native.mjs";\n';
  const wrapper = `\nlet __branchCanvasSection;\nfunction __branchCanvasWrappedArtifacts(props) {\n  na();\n  const route = r(Qe).value, host = te(Xe);\n  const original = $.jsx(zi, props);\n  if (route.routeKind !== "local-thread" || host.kind !== "local" || (props.presentation && !["summary","profile"].includes(props.presentation))) return original;\n  __branchCanvasSection ||= __branchCanvasFactory(__branchCanvasGetReact(), Y.Section);\n  return $.jsxs($.Fragment, {children: [$.jsx(__branchCanvasSection, {conversationId: route.conversationId, hostId: host.id}, host.id + ":" + route.conversationId), original]});\n}\n`;
  return imports + original.replace(anchor, '__branchCanvasWrappedArtifacts as t') + wrapper;
}

export async function createReplacements(sourceFiles, { nodeExecutable, pluginRoot }) {
  const here = dirname(fileURLToPath(import.meta.url));
  const replacements = {
    '.vite/build/early-bootstrap.js': 'if (process.argv.includes("--branch-canvas-native-self-test")) { require("./branch-canvas-native-main.cjs").selfTest(require("electron")); } else {\n' + sourceFiles['.vite/build/early-bootstrap.js'] + '\n;require("./branch-canvas-native-main.cjs").register(require("electron"));\n}\n',
    '.vite/build/preload.js': sourceFiles['.vite/build/preload.js'] + '\n;require("electron").contextBridge.exposeInMainWorld("branchCanvasNative", { request: payload => require("electron").ipcRenderer.invoke("branch-canvas:native-summary:v1", payload) });\n',
    'webview/assets/local-conversation-summary-panel-artifacts-section-d8157b10ca72.js': rendererPatch(sourceFiles['webview/assets/local-conversation-summary-panel-artifacts-section-d8157b10ca72.js']),
    '.vite/build/branch-canvas-native-main.cjs': await readFile(join(here, 'main.cjs'), 'utf8'),
    '.vite/build/branch-canvas-native.json': JSON.stringify({ nodeExecutable, pluginRoot }),
    'webview/assets/branch-canvas-native.mjs': await readFile(join(here, 'renderer.mjs'), 'utf8')
  };
  for (const [name, source] of Object.entries(replacements)) if (/\.(?:mjs|cjs|js)$/.test(name)) await transform(source, { loader: 'js', format: name.endsWith('.cjs') || name.startsWith('.vite/') ? 'cjs' : 'esm' });
  return replacements;
}

export async function prepare({ sourceApp, outputRoot, pluginRoot, nodeExecutable = process.execPath }) {
  sourceApp = resolve(sourceApp); outputRoot = resolve(outputRoot); pluginRoot = resolve(pluginRoot);
  const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const outputRelative = relative(join(project, 'artifacts'), outputRoot);
  if (!outputRelative || outputRelative.startsWith('..' + sep) || outputRelative === '..' || resolve(sourceApp) === outputRoot) throw new Error('Output must be a new subdirectory of this project artifacts folder.');
  if (await stat(outputRoot).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error))) throw new Error('Output already exists; use a fresh directory.');
  await stat(join(sourceApp, 'ChatGPT.exe')); await stat(join(pluginRoot, 'dist', 'mcp.mjs')); await stat(nodeExecutable);
  const originalPath = join(sourceApp, 'resources', 'app.asar'), archive = await readAsar(originalPath);
  const sourceFiles = {};
  let manifest, originalHeaderDigest;
  try {
    manifest = JSON.parse((await archive.read('package.json')).toString());
    originalHeaderDigest = archive.headerJsonSha256;
    if (manifest.version !== '26.1016.62342' || manifest.main !== '.vite/build/early-bootstrap.js') throw new Error('Desktop build is not supported by this patch.');
    for (const [name, hash] of Object.entries(expected)) {
      const bytes = await archive.read(name);
      if (sha256(bytes) !== hash) throw new Error(`Desktop file has changed: ${name}`);
      sourceFiles[name] = bytes.toString();
    }
  } finally { await archive.close(); }
  const here = dirname(fileURLToPath(import.meta.url));
  const replacements = await createReplacements(sourceFiles, { nodeExecutable, pluginRoot });
  await mkdir(outputRoot, { recursive: false });
  const outputApp = join(outputRoot, 'app');
  console.log('Copying the installed desktop runtime into an independent experiment folder.');
  await cp(sourceApp, outputApp, { recursive: true, dereference: true, force: false, errorOnExist: true, filter: path => resolve(path) !== resolve(originalPath) });
  const iniPath = join(outputApp, 'resources', 'owl-app.ini');
  const ini = await readFile(iniPath, 'utf8');
  if (!/^UserDataDirectoryName=Codex\r?$/m.test(ini)) throw new Error('Unexpected desktop profile configuration.');
  await writeFile(iniPath, ini.replace(/^UserDataDirectoryName=Codex\r?$/m, 'UserDataDirectoryName=CodexBranchCanvas'));
  console.log('Creating a patched archive; the original installation is not changed.');
  const patchedArchive = join(outputApp, 'resources', 'app.asar');
  await patchAsar(originalPath, patchedArchive, replacements);
  await build({ entryPoints: [join(here, 'rpc.mjs')], outfile: join(outputApp, 'resources', 'branch-canvas-native-rpc.mjs'), bundle: true, platform: 'node', target: 'node24', format: 'esm', banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" } });
  const check = await readAsar(patchedArchive), verification = {};
  const patchedHeaderDigest = check.headerJsonSha256;
  try {
    for (const [name, source] of Object.entries(replacements)) {
      const bytes = await check.read(name), hash = sha256(bytes);
      if (hash !== sha256(Buffer.from(source)) || hash !== check.entry(name).integrity.hash) throw new Error(`Patch verification failed: ${name}`);
      verification[name] = hash;
    }
    const unchanged = await readAsar(originalPath);
    try { for (const [name, hash] of Object.entries(expected)) if (sha256(await unchanged.read(name)) !== hash) throw new Error('The original desktop was changed.'); }
    finally { await unchanged.close(); }
  } finally { await check.close(); }
  const executableIntegrity = await syncExecutableIntegrity(join(outputApp, 'ChatGPT.exe'), originalHeaderDigest, patchedHeaderDigest);
  const launch = (await readFile(join(here, 'launch.ps1'), 'utf8')).replace('__ORIGINAL_APP__', sourceApp.replaceAll("'", "''"));
  await writeFile(join(outputRoot, 'launch.ps1'), '\ufeff' + launch);
  await writeFile(join(outputRoot, 'Launch Branch Canvas.cmd'), '@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0launch.ps1"\r\nif errorlevel 1 pause\r\n');
  await cp(join(here, 'README.md'), join(outputRoot, 'README.md'));
  const report = { createdAt: new Date().toISOString(), desktopVersion: manifest.version, sourceApp, outputApp, pluginRoot, nodeExecutable, originalFilesUnchanged: true, modifiedArchiveReadbackPassed: true, usesNativeReactSummarySection: true, transport: 'Dedicated Electron IPC to the installed plugin MCP server', addedNetworkPermissions: false, archiveIntegrityVerificationEnabled: true, executableIntegrity, desktopLaunchVerified: false, modifiedFiles: verification };
  await writeFile(join(outputRoot, 'patch-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ outputRoot, originalFilesUnchanged: true, modifiedArchiveReadbackPassed: true, desktopLaunchVerified: false }));
  return report;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = Object.fromEntries(process.argv.slice(2).reduce((result, value, i, values) => value.startsWith('--') ? [...result, [value.slice(2), values[i + 1]]] : result, []));
  await prepare({ sourceApp: args['source-app'], outputRoot: args.output, pluginRoot: args['plugin-root'], nodeExecutable: args.node || process.execPath });
}
