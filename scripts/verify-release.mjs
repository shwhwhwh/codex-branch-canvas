import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFile, mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const {version}=JSON.parse(await readFile('plugin.json','utf8'));
const zip=resolve(process.argv[2]||`artifacts/releases/v${version}/codex-branch-canvas-v${version}-windows.zip`);
await mkdir('artifacts/release-tests',{recursive:true});
const testRoot=await mkdtemp(resolve('artifacts/release-tests/test-'));
execFileSync('powershell.exe',['-NoProfile','-Command','Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory($env:BRANCH_CANVAS_TEST_ZIP,$env:BRANCH_CANVAS_TEST_ROOT)'],{windowsHide:true,env:{...process.env,BRANCH_CANVAS_TEST_ZIP:zip,BRANCH_CANVAS_TEST_ROOT:testRoot}});
const root=join(testRoot,'codex-branch-canvas');
assert((await readdir(root)).includes('.agents'));
assert(!(await readdir(root)).includes('node_modules'));
assert(!(await readdir(root)).includes('data'));
const sha=x=>createHash('sha256').update(x).digest('hex');
const manifest=JSON.parse(await readFile(join(root,'RELEASE-MANIFEST.json'),'utf8'));
assert.equal(manifest.version,version);
assert.equal(manifest.policyId,'LicenseRef-Prototype-Plan-Personal-Noncommercial-1.1');
assert.equal(manifest.licenseScope,'all-owner-controlled-material-in-official-distribution');
for(const file of manifest.files){
  assert(!/(?:^|\/)(?:data|node_modules|\.git)(?:\/|$)/.test(file.path));
  assert.equal(sha(await readFile(join(root,file.path))),file.sha256,file.path);
}
for(const file of ['LICENSE','LICENSING.json','LICENSE_HISTORY.md','COMMERCIAL_LICENSE.md','CONTRIBUTOR_AGREEMENT.md','CONTRIBUTING.md','NOTICE','LICENSES/branch-canvas-legacy-reserved.txt'])assert.equal(sha(await readFile(file)),sha(await readFile(join(root,file))));
assert.equal(JSON.parse(await readFile(join(root,'plugin.json'),'utf8')).version,version);
const policy=JSON.parse(await readFile(join(root,'LICENSING.json'),'utf8'));
assert.equal(policy.policyId,'LicenseRef-Prototype-Plan-Personal-Noncommercial-1.1');
const client=new Client({name:'release-verification',version:'1'});
try{
  await client.connect(new StdioClientTransport({command:process.execPath,args:[join(root,'dist/mcp.mjs')],stderr:'pipe'}));
  const response=await client.callTool({name:'canvas_open',arguments:{}});assert(!response.isError);assert.equal(response._meta.canvas.nodes.length,2);assert.equal(response._meta.canvas.runtime.version,version);
  const ui=await client.readResource({uri:'ui://branch-canvas/workspace.html'});assert(ui.contents[0].text.includes('locate-root'));assert(ui.contents[0].text.includes('follow-current'));
}finally{await client.close();}
const cli=process.env.BRANCH_CANVAS_TEST_CODEX;
let installed=false;
if(cli){
  const env={...process.env,CODEX_HOME:join(testRoot,'isolated-codex-home')};
  await mkdir(env.CODEX_HOME,{recursive:true});
  for(const args of [['plugin','marketplace','add',root,'--json'],['plugin','add','codex-branch-canvas@branch-canvas-local','--json']]){
    const output=execFileSync(cli,args,{env,encoding:'utf8',windowsHide:true});
    assert(output);console.log(output.trim());
  }
  installed=true;
}
await writeFile('artifacts/release-verification.json',JSON.stringify({version,sourceCommit:manifest.sourceCommit,zip,sha256:sha(await readFile(zip)),filesVerified:manifest.files.length,runtimeSmokePassed:true,isolatedCliInstallPassed:installed,copyrightPreserved:true,modelCalls:0,testRoot},null,2));
console.log(JSON.stringify({runtimeSmokePassed:true,isolatedCliInstallPassed:installed,copyrightPreserved:true,modelCalls:0}));
