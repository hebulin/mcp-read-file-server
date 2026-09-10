/** 路径边界、跨实例写锁、可回滚提交和逐文件目录操作。 */
const fs = require('node:fs/promises');
const nativeFs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { fault, fingerprint, payloadFingerprint, checkBudget } = require('./text');
const { createLocker, pathKey, inside } = require('./locks');
const { cleanupFiles, finishCleanup } = require('./cleanup');

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
  const locked = createLocker(encryption.stateDir);
  let realBasePromise;

  /** 在操作前解析路径并执行服务端权限范围检查，删除链接时只解析其父目录。 */
  async function resolve(value, { write = false, leaf = false, destructive = false } = {}) {
    if (typeof value !== 'string' || !value || /[\0\r\n]/.test(value)) throw fault('INVALID_PATH', '必须提供有效路径');
    if (write && readOnly) throw fault('READ_ONLY', '服务以只读模式运行');
    const absolute = path.resolve(baseDir, value);
    const real = leaf ? path.join(await canonical(path.dirname(absolute)), path.basename(absolute)) : await canonical(absolute);
    const roots = await rootsPromise;
    if (roots.length && !roots.some(root => inside(root, real))) throw fault('PATH_OUTSIDE_ROOTS', '路径不在允许的根目录内');
    if (destructive) {
      // 同时保护配置别名和真实工作根；其他链接仍按leaf语义只删除链接本身。
      const realBase = await (realBasePromise ||= canonical(baseDir));
      if ([path.parse(real).root, baseDir, realBase, ...roots].some(root => inside(real, root))) {
        throw fault('PROTECTED_ROOT', '不能删除或移动盘符根、工作目录、配置根目录或包含这些根的祖先目录');
      }
    }
    return real;
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
    let outcome;
    let failure;
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
      outcome = { changed: true, hash: expected.hash, size: expected.size, ...verified, strategy: decision, ...(prepared.via ? { via: prepared.via } : {}), warnings: verified.diskState === 'unknown' ? ['内容已校验，但没有独立读取器证明磁盘为明文'] : [] };
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
      failure = error;
    }
    const cleanupErrors = await cleanupFiles([stage, ...(!retainBackup && backedUp ? [backup] : [])]);
    return finishCleanup(outcome, failure, cleanupErrors);
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
      const removedSourcePaths = [];
      /** 文件和目录仅在真实删除成功后计数，保留有界的源变化清单。 */
      function recordSourceRemoval(file) {
        removedSources++;
        if (removedSourcePaths.length < 100) removedSourcePaths.push(file);
      }
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
            recordSourceRemoval(item.source);
          }
          for (const dir of sourceDirectories.reverse()) {
            checkBudget(settings.signal, settings.deadline);
            await fs.rmdir(dir);
            recordSourceRemoval(dir);
          }
        }
        const cleanupErrors = completed.flatMap(x => x.cleanupErrors || []).slice(0, 100);
        return { changed: move || completed.some(x => x.changed) || createdDirectories.length > 0, source, destination, files: completed.length, moved: move, ...(cleanupErrors.length ? { cleanupErrors } : {}), warnings: completed.flatMap(x => x.warnings || []).slice(0, 10) };
      } catch (error) {
        error.changed = !!error.changed || removedSources > 0 || completed.some(x => x.changed) || createdDirectories.length > 0;
        error.partial = [...new Set([...(error.partial || []), ...completed.map(x => x.destination)])].slice(0, 100);
        error.sourceRetained = removedSources === 0;
        if (move) {
          error.removedSourceCount = removedSources;
          error.removedSourcePaths = removedSourcePaths;
          error.removedSourcePathsTruncated = removedSources > removedSourcePaths.length;
        }
        const cleanupErrors = [...completed.flatMap(x => x.cleanupErrors || []), ...(error.cleanupErrors || [])].slice(0, 100);
        if (cleanupErrors.length) error.cleanupErrors = cleanupErrors;
        throw error;
      }
    }, settings);
  }

  /** 逐项删除并记录实际完成项，部分失败不再报告为未修改。 */
  async function remove(value, settings = {}) {
    if (!allowDelete) throw fault('DELETE_DISABLED', '服务已禁用删除工具');
    const file = await resolve(value, { write: !settings.dryRun, leaf: true, destructive: true });
    return locked([file], async () => {
      const st = await fs.lstat(file);
      if (settings.dryRun) return { changed: false, dryRun: true, path: file, type: st.isDirectory() ? 'directory' : st.isSymbolicLink() ? 'symlink' : 'file' };
      const removed = [];
      let removedCount = 0;
      let visited = 0;
      let failedPath = file;
      /** 不跟随链接，逐层检查预算；只在系统删除成功后计数。 */
      async function erase(target, depth = 0) {
        failedPath = target;
        checkBudget(settings.signal, settings.deadline);
        if (++visited > 10000) throw fault('ITEM_LIMIT', '删除超过一万项预算');
        if (depth > 128) throw fault('DEPTH_LIMIT', '删除目录深度超过128层');
        await resolve(target, { write: true, leaf: true, destructive: true });
        const current = await fs.lstat(target);
        if (current.isDirectory()) {
          if (settings.recursive !== false) {
            const handle = await fs.opendir(target);
            for await (const entry of handle) await erase(path.join(target, entry.name), depth + 1);
          }
          failedPath = target;
          checkBudget(settings.signal, settings.deadline);
          await fs.rmdir(target);
        } else await fs.unlink(target);
        removedCount++;
        if (removed.length < 100) removed.push(target);
      }
      try { await erase(file); }
      catch (error) {
        error.changed = removedCount > 0;
        error.partial = removed;
        error.removedCount = removedCount;
        error.partialTruncated = removedCount > removed.length;
        error.failedPath = failedPath;
        throw error;
      }
      return { changed: true, path: file, removedCount };
    }, settings);
  }

  return { baseDir, readOnly, allowDelete, resolve, locked, previous, write, transfer, remove };
}

module.exports = { createFiles, pathKey, inside, canonical, statMaybe };
