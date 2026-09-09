/** 路径边界、跨实例写锁、可回滚提交和逐文件目录操作。 */
const fs = require('node:fs/promises');
const nativeFs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { setTimeout: delay } = require('node:timers/promises');
const { performance } = require('node:perf_hooks');
const { fault, fingerprint, payloadFingerprint, checkBudget } = require('./text');

/** 对 Windows 文件路径统一大小写，用于同一路径和锁键比较。 */
function pathKey(file) { return process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file); }

/** 判定 candidate 是否等于 base 或位于其子树，避免字符串前缀误判。 */
function inside(base, candidate) {
  const rel = path.relative(pathKey(base), pathKey(candidate));
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}

/** 从最近存在的祖先解析真实路径，识别目录符号链接和 junction 越界。 */
async function canonical(file) {
  try { return await fs.realpath(file); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = path.dirname(file);
    if (parent === file) throw error;
    return path.join(await canonical(parent), path.basename(file));
  }
}

/** 获取可不存在的路径状态，其他访问错误保持为错误。 */
async function statMaybe(file) {
  try { return await fs.lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

/** 创建带可选根目录和只读模式的文件操作服务。 */
function createFiles(encryption, options = {}) {
  const baseDir = path.resolve(options.baseDir || process.env.MCP_BASE_DIR || process.cwd());
  const readOnly = options.readOnly ?? process.env.MCP_READ_ONLY === '1';
  const allowDelete = options.allowDelete ?? process.env.MCP_DISABLE_DELETE !== '1';
  const configuredRoots = options.allowedRoots ?? (process.env.MCP_ALLOWED_ROOTS ? JSON.parse(process.env.MCP_ALLOWED_ROOTS) : []);
  if (!Array.isArray(configuredRoots) || !configuredRoots.every(x => typeof x === 'string' && path.isAbsolute(x))) throw fault('INVALID_CONFIG', 'MCP_ALLOWED_ROOTS 必须是绝对路径 JSON 数组');
  const rootsPromise = Promise.all(configuredRoots.map(canonical));

  /** 在操作前解析路径并执行服务端权限范围检查，删除链接时只解析其父目录。 */
  async function resolve(value, { write = false, leaf = false, destructive = false } = {}) {
    if (typeof value !== 'string' || !value || /[\0\r\n]/.test(value)) throw fault('INVALID_PATH', '必须提供有效路径');
    if (write && readOnly) throw fault('READ_ONLY', '服务以只读模式运行');
    const absolute = path.resolve(baseDir, value);
    const real = leaf ? path.join(await canonical(path.dirname(absolute)), path.basename(absolute)) : await canonical(absolute);
    const roots = await rootsPromise;
    if (roots.length && !roots.some(root => inside(root, real))) throw fault('PATH_OUTSIDE_ROOTS', '路径不在允许的根目录内');
    if (destructive && (pathKey(real) === pathKey(path.parse(real).root) || pathKey(real) === pathKey(baseDir) || roots.some(root => pathKey(root) === pathKey(real)))) {
      throw fault('PROTECTED_ROOT', '不能删除或移动盘符根、工作目录或配置根目录本身');
    }
    return real;
  }

  /** 为多个路径按稳定顺序获取独占锁，避免多实例覆盖和死锁。 */
  async function locked(files, action, context = {}) {
    const dir = path.join(encryption.stateDir, '.mcp-file-locks');
    await fs.mkdir(dir, { recursive: true });
    const held = [];
    const deadline = Math.min(context.deadline ?? Infinity, performance.now() + 5000);
    try {
      for (const file of [...new Set(files.map(pathKey))].sort()) {
        const lock = path.join(dir, crypto.createHash('sha256').update(file).digest('hex') + '.lock');
        while (true) {
          checkBudget(context.signal, context.deadline);
          try {
            const handle = await fs.open(lock, 'wx', 0o600);
            held.push(lock);
            try { await handle.writeFile(JSON.stringify({ pid: process.pid, file, createdAt: new Date().toISOString() })); }
            finally { await handle.close(); }
            break;
          } catch (error) {
            if (error.code !== 'EEXIST') throw error;
            if (performance.now() > deadline) throw fault('FILE_BUSY', '文件正被其他操作占用；若进程异常退出，请核对锁文件: ' + lock);
            await delay(30);
          }
        }
      }
      return await action();
    } finally { for (const lock of held.reverse()) await fs.rm(lock, { force: true }); }
  }

  /** 取得文件修改前指纹，不把目录或特殊设备当作普通文件写入。 */
  async function previous(file, context) {
    const stat = await statMaybe(file);
    if (!stat) return null;
    if (!stat.isFile()) throw fault('NOT_FILE', '目标不是普通文件');
    return { ...(await fingerprint(file, context)), mode: stat.mode };
  }

  /** 比较读取时版本和当前文件，避免基于过期内容提交。 */
  async function assertUnchanged(file, before, context) {
    const current = await previous(file, context);
    if (current?.hash !== before?.hash) throw fault('CONFLICT', '文件在操作期间已改变，未覆盖新内容');
  }

  /** 暂存、校验、备份、提交、再校验；异常时恢复原目标或保留可恢复备份。 */
  async function commit(file, writer, expected, options = {}) {
    const before = await previous(file, options);
    if (options.expectedHash !== undefined && options.expectedHash !== (before?.hash ?? null)) throw fault('CONFLICT', 'expectedHash 与当前文件不一致');
    if (before && options.overwrite === false) throw fault('ALREADY_EXISTS', '目标已存在，overwrite=false');
    await fs.mkdir(path.dirname(file), { recursive: true });
    const decision = await encryption.strategy(file, options.writePolicy, options);
    if (before?.hash === expected.hash) {
      try {
        const verified = await encryption.verify(file, expected, decision.mode, options);
        return { changed: false, hash: expected.hash, ...verified };
      } catch (error) { if (error.code !== 'DISK_MISMATCH') throw error; }
    }
    const suffix = path.extname(file);
    const token = crypto.randomUUID();
    const stage = path.join(path.dirname(file), '.mcp-stage-' + token + suffix);
    const backup = path.join(path.dirname(file), '.mcp-backup-' + token + suffix);
    let backedUp = false;
    let installed = false;
    let retainBackup = false;
    try {
      const prepared = await encryption.prepare(stage, writer, expected, decision, options);
      // Windows FlushFileBuffers需要可写句柄，刷盘后再恢复原权限。
      const stageHandle = await fs.open(stage, 'r+');
      try { await stageHandle.sync(); } finally { await stageHandle.close(); }
      if (before) await fs.chmod(stage, before.mode);
      checkBudget(options.signal, options.deadline);
      await assertUnchanged(file, before, options);
      if (before) { await fs.rename(file, backup); backedUp = true; }
      await fs.rename(stage, file);
      installed = true;
      const verified = await encryption.verify(file, expected, prepared.via ? 'plaintext' : decision.mode, options);
      if (backedUp) { await fs.rm(backup); backedUp = false; }
      return { changed: true, hash: expected.hash, size: expected.size, ...verified, strategy: decision, ...(prepared.via ? { via: prepared.via } : {}), warnings: verified.diskState === 'unknown' ? ['内容已校验，但没有独立读取器证明磁盘为明文'] : [] };
    } catch (error) {
      // 回滚不受已取消的请求预算影响，优先恢复原始文件。
      try {
        if (backedUp) { await fs.rename(backup, file); backedUp = false; installed = false; }
        else if (installed) { await fs.rm(file, { force: true }); installed = false; }
        error.changed = false;
      } catch (rollbackError) {
        retainBackup = backedUp;
        // 即使新文件尚未安装，原目标已经移入备份也属于状态改变。
        error.changed = installed || backedUp;
        error.recoveryPath = backedUp ? backup : null;
        error.rollbackError = rollbackError.message;
      }
      throw error;
    } finally {
      await fs.rm(stage, { force: true });
      if (!retainBackup && backedUp) await fs.rm(backup, { force: true });
    }
  }

  /** 提交文本载荷，写入者使用独占创建防止临时名冲突。 */
  async function write(file, payload, settings = {}) {
    if (typeof payload === 'string' && payload.isWellFormed && !payload.isWellFormed()) throw fault('INVALID_UNICODE', '写入内容含孤立代理项，已拒绝替换成乱码');
    const expected = payloadFingerprint(payload);
    return commit(file, destination => fs.writeFile(destination, payload, { flag: 'wx', mode: 0o600 }), expected, settings);
  }

  /** 流式复制时保持源明文字节，使用事先取得的独立指纹验证。 */
  async function copyOne(source, destination, settings = {}) {
    const sourceStat = await fs.lstat(source);
    const targetStat = await statMaybe(destination);
    if (pathKey(source) === pathKey(destination) || (targetStat && sourceStat.dev === targetStat.dev && sourceStat.ino === targetStat.ino)) return { changed: false, sameFile: true };
    const expected = await fingerprint(source, settings);
    const result = await commit(destination, target => pipeline(nativeFs.createReadStream(source), nativeFs.createWriteStream(target, { flags: 'wx', mode: sourceStat.mode }), { signal: settings.signal }), expected, settings);
    return { ...result, sourceHash: expected.hash };
  }

  /** 对目录逐文件执行相同写入策略；任何失败保留源树并报告部分目标。 */
  async function transfer(sourceValue, destinationValue, move, settings = {}) {
    const source = await resolve(sourceValue, { write: move, leaf: true, destructive: move });
    let destination = await resolve(destinationValue, { write: true });
    const sourceStat = await fs.lstat(source);
    const destinationStat = await statMaybe(destination);
    if (destinationStat?.isDirectory()) destination = path.join(destination, path.basename(source));
    destination = await resolve(destination, { write: true });
    if (pathKey(source) === pathKey(destination)) return { changed: false, sameFile: true, source, destination };
    if (sourceStat.isDirectory() && inside(source, destination)) throw fault('RECURSIVE_TARGET', '目标不能位于源目录内部');
    if (sourceStat.isDirectory() && inside(destination, source)) throw fault('OVERLAPPING_PATHS', '最终目标不能是源目录的祖先；请先复制到独立目录');
    return locked([source, destination], async () => {
      const completed = [];
      const createdDirectories = [];
      const sourceDirectories = [];
      let removedSources = 0;
      /** 逐项遍历，不跟随符号链接，避免跨根和意外递归。 */
      async function visit(src, dst) {
        checkBudget(settings.signal, settings.deadline);
        if (completed.length + createdDirectories.length >= 10000) throw fault('ITEM_LIMIT', '目录操作超过一万项预算');
        await resolve(src, { leaf: true });
        await resolve(dst, { write: true });
        const st = await fs.lstat(src);
        if (st.isSymbolicLink()) throw fault('SYMLINK_COPY_UNSUPPORTED', '目录复制/移动暂不自动处理符号链接，请单独处理: ' + src);
        if (st.isDirectory()) {
          sourceDirectories.push(src);
          const old = await statMaybe(dst);
          if (old && !old.isDirectory()) throw fault('TYPE_CONFLICT', '目录目标类型冲突');
          if (!old) { await fs.mkdir(dst, { recursive: true }); createdDirectories.push(dst); }
          for (const entry of await fs.readdir(src)) await visit(path.join(src, entry), path.join(dst, entry));
        } else if (st.isFile()) {
          let result;
          try { result = await copyOne(src, dst, settings); }
          catch (error) {
            // 当前失败文件尚未加入completed；保留它的恢复状态和实际目标路径。
            if (error.changed || error.recoveryPath) error.partial = [...(error.partial || []), dst];
            throw error;
          }
          if (move && result.sameFile) throw fault('SAME_FILE_ALIAS', '源与目标为同一文件的别名，拒绝删源');
          completed.push({ source: src, destination: dst, ...result });
        } else throw fault('SPECIAL_FILE', '不支持复制特殊设备文件');
      }
      try {
        await visit(source, destination);
        if (move) {
          // 删除源前再次比较独立指纹，避免复制期间源内容改变后被删除。
          for (const item of completed) {
            if ((await fingerprint(item.source, settings)).hash !== item.sourceHash) throw fault('CONFLICT', '源在复制期间被修改，已保留源文件');
            if ((await fingerprint(item.destination, settings)).hash !== item.sourceHash) throw fault('CONTENT_MISMATCH', '目标在复制后被修改，已保留源文件');
          }
          // 只删除本次已经复制且验证的文件；后来新增的源文件绝不递归删掉。
          for (const item of completed) {
            if ((await fingerprint(item.source, settings)).hash !== item.sourceHash) throw fault('CONFLICT', '源文件在删源前被修改，已保留');
            await fs.unlink(item.source);
            removedSources++;
          }
          for (const dir of sourceDirectories.reverse()) await fs.rmdir(dir);
        }
        return { changed: move || completed.some(x => x.changed) || createdDirectories.length > 0, source, destination, files: completed.length, moved: move, warnings: completed.flatMap(x => x.warnings || []).slice(0, 10) };
      } catch (error) {
        error.changed = !!error.changed || removedSources > 0 || completed.some(x => x.changed) || createdDirectories.length > 0;
        error.partial = [...new Set([...(error.partial || []), ...completed.map(x => x.destination)])].slice(0, 100);
        error.sourceRetained = removedSources === 0;
        throw error;
      }
    }, settings);
  }

  /** 删除单个文件、链接或目录；空目录非递归删除使用 rmdir。 */
  async function remove(value, settings = {}) {
    if (!allowDelete) throw fault('DELETE_DISABLED', '服务已禁用删除工具');
    const file = await resolve(value, { write: !settings.dryRun, leaf: true, destructive: true });
    return locked([file], async () => {
      const st = await fs.lstat(file);
      if (settings.dryRun) return { changed: false, dryRun: true, path: file, type: st.isDirectory() ? 'directory' : st.isSymbolicLink() ? 'symlink' : 'file' };
      if (st.isDirectory() && settings.recursive === false) await fs.rmdir(file);
      else await fs.rm(file, { recursive: st.isDirectory(), force: false });
      return { changed: true, path: file };
    }, settings);
  }

  return { baseDir, readOnly, allowDelete, resolve, locked, previous, write, transfer, remove };
}

module.exports = { createFiles, pathKey, inside, canonical, statMaybe };
