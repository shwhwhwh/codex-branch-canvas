import { cp, mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const root=fileURLToPath(new URL('../',import.meta.url));
const {version}=JSON.parse(await readFile(join(root,'plugin.json'),'utf8'));
const output=join(root,'artifacts','releases','v'+version), folder=join(output,'codex-branch-canvas');
if(await stat(output).catch(()=>null))throw new Error('Release output already exists: '+output);
await mkdir(join(folder,'dist'),{recursive:true});
for(const file of ['mcp.mjs','worker.mjs','http.mjs','mcp-app.html','app.js','style.css','index.html'])await cp(join(root,'dist',file),join(folder,'dist',file));
for(const file of ['plugin.json','mcp.json','README.md','LICENSE','LICENSING.json','LICENSE_HISTORY.md','LICENSES','COMMERCIAL_LICENSE.md','CONTRIBUTOR_AGREEMENT.md','CONTRIBUTING.md','NOTICE','THIRD_PARTY_NOTICES.md','CHANGELOG.md','start.cmd','stop.cmd','.agents'])await cp(join(root,file),join(folder,file),{recursive:true});
await mkdir(join(folder,'scripts'),{recursive:true});
for(const file of ['start.ps1','stop.ps1','install-plugin.ps1'])await cp(join(root,'scripts',file),join(folder,'scripts',file));
const noticeDir=join(folder,'third-party-licenses');await mkdir(noticeDir);
const packages=[];
async function collectPackage(path){
  let pkg;try{pkg=JSON.parse(await readFile(join(path,'package.json'),'utf8'));}catch{return;}
  const files=(await readdir(path)).filter(name=>/^(licen[sc]e|notice|copying)([._-].*)?$/i.test(name));
  const safe=pkg.name.replaceAll('/','__');
  if(files.length){await mkdir(join(noticeDir,safe));for(const name of files)if((await stat(join(path,name))).isFile())await cp(join(path,name),join(noticeDir,safe,name));}
  packages.push({name:pkg.name,version:pkg.version,license:pkg.license||null,files});
}
for(const entry of await readdir(join(root,'node_modules'),{withFileTypes:true})){
  if(!entry.isDirectory()||entry.name.startsWith('.'))continue;
  const path=join(root,'node_modules',entry.name);
  if(entry.name.startsWith('@'))for(const child of await readdir(path))await collectPackage(join(path,child));else await collectPackage(path);
}
await writeFile(join(noticeDir,'manifest.json'),JSON.stringify(packages,null,2)+'\n');
const zip=join(output,`codex-branch-canvas-v${version}-windows.zip`);
execFileSync('powershell.exe',['-NoProfile','-Command','Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory($env:BRANCH_CANVAS_PACKAGE_DIRECTORY, $env:BRANCH_CANVAS_ARCHIVE_PATH, [System.IO.Compression.CompressionLevel]::Optimal, $true)'],{stdio:'inherit',windowsHide:true,env:{...process.env,BRANCH_CANVAS_PACKAGE_DIRECTORY:folder,BRANCH_CANVAS_ARCHIVE_PATH:zip}});
const sha=createHash('sha256').update(await readFile(zip)).digest('hex');
await writeFile(join(output,'SHA256SUMS.txt'),`${sha}  codex-branch-canvas-v${version}-windows.zip\n`);
console.log(JSON.stringify({folder,zip,sha256:sha,thirdPartyPackages:packages.length}));
