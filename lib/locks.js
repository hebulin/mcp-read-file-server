/** 跨进程登记路径占用；祖先与后代互斥，无关路径可并行。 */
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { performance } = require('node:perf_hooks');
const { fault, checkBudget } = require('./text');
const { cleanupFiles, finishCleanup } = require('./cleanup');

/** 对Windows路径统一大小写，供路径关系和占用记录比较。 */
function pathKey(file) { return process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file); }

/** 按路径段判断同路径或后代，避免相似前缀误判。 */
function inside(base, candidate) {
  const rel = path.relative(pathKey(base), pathKey(candidate));
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}

/** 创建使用同一状态目录的跨实例锁管理器。 */
function createLocker(stateDir) {
  const dir = path.join(stateDir, '.mcp-file-locks');
  const guard = path.join(dir, '.registry-guard');

  /** 在短临界区内检查并原子登记整组路径，等待期间不持有其他路径锁。 */
  async function locked(files, action, context = {}) {
    await fs.mkdir(dir, { recursive: true });
    const wanted = [...new Set(files.map(pathKey))].sort();
    const deadline = Math.min(context.deadline ?? Infinity, performance.now() + 5000);
    let lease = null;
    let value;
    let failure;
    try {
      while (!lease) {
        checkBudget(context.signal, context.deadline);
        if (performance.now() > deadline) throw fault('FILE_BUSY', '路径或其子树正被其他操作占用；异常退出后请核对锁目录: ' + dir);
        let guarding = false;
        let attemptError;
        try {
          const handle = await fs.open(guard, 'wx', 0o600);
          guarding = true;
          try { await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })); }
          finally { await handle.close(); }
          let conflict = false;
          for (const entry of await fs.readdir(dir)) {
            checkBudget(context.signal, context.deadline);
            if (!entry.endsWith('.lock')) continue;
            let record;
            try { record = JSON.parse(await fs.readFile(path.join(dir, entry), 'utf8')); }
            catch (error) {
              // 持有者可在临界区外释放记录；已删除的记录不再冲突。
              if (error.code === 'ENOENT') continue;
              throw fault('FILE_BUSY', '锁记录不可读取，请核对后处理: ' + path.join(dir, entry));
            }
            const occupied = record?.files || (record?.file ? [record.file] : null);
            if (!Array.isArray(occupied) || !occupied.length || !occupied.every(x => typeof x === 'string' && path.isAbsolute(x))) throw fault('FILE_BUSY', '锁记录无效，请核对: ' + path.join(dir, entry));
            if (wanted.some(a => occupied.some(b => inside(a, b) || inside(b, a)))) { conflict = true; break; }
          }
          if (!conflict) {
            const candidate = path.join(dir, crypto.randomUUID() + '.lock');
            const handle = await fs.open(candidate, 'wx', 0o600);
            lease = candidate;
            try { await handle.writeFile(JSON.stringify({ pid: process.pid, files: wanted, createdAt: new Date().toISOString() })); }
            finally { await handle.close(); }
          }
        } catch (error) {
          if (guarding || error.code !== 'EEXIST') attemptError = error;
        } finally {
          if (guarding) {
            try { await fs.rm(guard, { force: true }); }
            catch (error) {
              const diagnostic = { path: guard, code: error.code, message: error.message };
              if (!attemptError) attemptError = fault('LOCK_CLEANUP_FAILED', '锁登记临界区无法释放，请核对: ' + guard);
              attemptError.cleanupErrors = [...(attemptError.cleanupErrors || []), diagnostic];
            }
          }
        }
        if (attemptError) throw attemptError;
        if (!lease) await delay(30);
      }
      checkBudget(context.signal, context.deadline);
      value = await action();
    } catch (error) { failure = error; }
    return finishCleanup(value, failure, await cleanupFiles(lease ? [lease] : []));
  }
  return locked;
}

module.exports = { createLocker, pathKey, inside };
