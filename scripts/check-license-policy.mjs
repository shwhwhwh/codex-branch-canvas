import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const args = process.argv.slice(2), option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const root = option('--root', '.'), trusted = option('--trusted', root);
const norm = text => text.replace(/\r\n/g, '\n').trim();
const hash = text => createHash('sha256').update(norm(text)).digest('hex');
const insist = (condition, message) => { if (!condition) throw Error(message); };
const safePath = value => { insist(typeof value === 'string' && /^[A-Za-z0-9_./-]+$/.test(value) && !value.startsWith('/') && !value.split('/').some(p => !p || p === '.' || p === '..'), 'Unsafe policy file path'); return value; };
try {
  const manifest = JSON.parse(await readFile(`${root}/LICENSING.json`, 'utf8'));
  const anchor = JSON.parse(await readFile(`${trusted}/LICENSING.json`, 'utf8'));
  const license = await readFile(`${root}/LICENSE`, 'utf8');
  insist(manifest.policyId === 'LicenseRef-Prototype-Plan-Personal-Noncommercial-1.0', 'Unexpected owner policy');
  insist(manifest.projectId === anchor.projectId && manifest.repository === anchor.repository && manifest.rightsHolder === anchor.rightsHolder, 'Owner/repository identity changed');
  insist(hash(license) === anchor.licenseSha256 && manifest.licenseSha256 === anchor.licenseSha256, 'Canonical license was changed');
  insist(JSON.stringify(manifest.historical) === JSON.stringify(anchor.historical), 'Historical licensing boundary changed');
  insist(license.includes('All rights reserved') && license.includes('Commercial permission is separate'), 'Missing reservation or commercial boundary');
  for (const path of ['COMMERCIAL_LICENSE.md', 'CONTRIBUTOR_AGREEMENT.md']) insist(hash(await readFile(`${root}/${path}`, 'utf8')) === hash(await readFile(`${trusted}/${path}`, 'utf8')), 'Commercial/contribution terms changed: ' + path);
  for (const entry of manifest.historical || []) insist(hash(await readFile(`${root}/${safePath(entry.licenseFile)}`, 'utf8')) === entry.licenseSha256, 'Historical license archive changed');
  const packageFile = await readFile(`${root}/package.json`, 'utf8').catch(() => null);
  if (packageFile) insist(JSON.parse(packageFile).license === 'SEE LICENSE IN LICENSE', 'Package must refer to the actual custom license');
  if (process.env.GITHUB_EVENT_NAME === 'pull_request') {
    const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
    if (event.pull_request.user.login !== 'shwhwhwh') insist(/^CLA-ACCEPTED: PP-CLA-1\.0\s*$/m.test(event.pull_request.body || ''), 'Read contribution terms and expressly attest PP-CLA-1.0, or request separate terms');
  }
  console.log('Passed: owner identity, limited free/commercial boundary, contribution terms, archived prior grants and PR attestation.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
