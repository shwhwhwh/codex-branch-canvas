import { openSync, writeFileSync, readFileSync, closeSync, unlinkSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

export function acquireDatabaseLock(filename) {
  if (filename === ':memory:') return () => {};
  const lockPath = resolve(filename) + '.lock'; mkdirSync(dirname(lockPath), { recursive: true });
  function claim() { const fd = openSync(lockPath, 'wx'); writeFileSync(fd, String(process.pid)); closeSync(fd); }
  try { claim(); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(readFileSync(lockPath, 'utf8'));
    let alive = true;
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('数据库锁无法识别。请先确认没有工作区正在运行。');
    try { process.kill(pid, 0); } catch (check) { alive = check.code !== 'ESRCH'; }
    if (alive) throw new Error('这份对话树已由另一个工作区使用。请先关闭独立工作区，再从插件打开。');
    unlinkSync(lockPath); claim();
  }
  let released = false;
  return () => { if (released) return; released = true; try { if (readFileSync(lockPath, 'utf8') === String(process.pid)) unlinkSync(lockPath); } catch {} };
}
