/** 事务、探测及2.1.5精确文件身份回归；真实属性与确定性故障注入分开验证。 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture } = require('./helper.cjs');
const { createEncryption } = require('../lib/encryption');
const { fingerprint, payloadFingerprint, fault } = require('../lib/text');

/** 断言MCP成功并返回数据，失败时显示完整诊断。 */
function success(response) { assert.equal(response.structuredContent.ok, true, JSON.stringify(response)); return response.structuredContent.data; }
/** 断言MCP失败码并返回恢复状态。 */
function failure(response, code) { assert.equal(response.structuredContent.ok, false, JSON.stringify(response)); assert.equal(response.structuredContent.code, code); return response.structuredContent.data; }
/** 使用屏障确定调度顺序，避免靠机器速度猜测并发时机。 */
function gate() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
/** 防止测试屏障失败后无限等待。 */
async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('测试屏障超时')), 5000); })]); }
  finally { clearTimeout(timer); }
}
/** 仅让已经安装到最终路径的新内容终验失败，真实暂存/rename/chmod保持不变。 */
function rejectFinal(encryption, file) {
  const verify = encryption.verify;
  encryption.verify = async (target, expected, mode, context) => {
    const result = await verify(target, expected, mode, context);
    if (target === file && expected.hash === payloadFingerprint('NEW').hash) throw fault('DISK_MISMATCH', '仅最终路径校验失败');
    return result;
  };
}

test('T1 真实只读原文件终验失败后恢复原内容和只读属性', async t => {
  const f = await fixture(t);
  const file = await f.sample('readonly.txt', 'OLD');
  await fs.chmod(file, 0o444);
  const mode = (await fs.stat(file)).mode & 0o777;
  rejectFinal(f.encryption, file);
  const data = failure(await f.call('write_file', { path: file, content: 'NEW', writePolicy: 'preserve' }), 'DISK_MISMATCH');
  assert.equal(data.changed, false);
  assert.equal(data.recoveryPath, undefined);
  assert.equal(await fs.readFile(file, 'utf8'), 'OLD');
  assert.equal((await fs.stat(file)).mode & 0o777, mode);
  assert.equal((await fs.readdir(f.root)).some(name => /^\.mcp-(stage|backup)-/.test(name)), false);
});

test('T1 回滚仍遇访问拒绝时保留原备份和真实changed', async t => {
  const f = await fixture(t);
  const file = await f.sample('readonly.txt', 'OLD');
  await fs.chmod(file, 0o444);
  rejectFinal(f.encryption, file);
  const rename = fs.rename;
  fs.rename = async (from, to) => { if (to === file && path.basename(from).startsWith('.mcp-backup-')) throw fault('EBUSY', '备份恢复被占用'); return rename(from, to); };
  let response;
  try { response = await f.call('write_file', { path: file, content: 'NEW', writePolicy: 'preserve' }); }
  finally { fs.rename = rename; }
  const data = failure(response, 'DISK_MISMATCH');
  assert.equal(data.changed, true);
  assert.match(data.rollbackError, /备份恢复被占用/);
  assert.equal(await fs.readFile(data.recoveryPath, 'utf8'), 'OLD');
  assert.equal((await fs.stat(data.recoveryPath)).mode & 0o200, 0);
  assert.equal(await fs.readFile(file, 'utf8'), 'NEW');
});

for (const tool of ['write_file', 'copy_path', 'move_path']) {
  test('T2 ' + tool + '备份清理失败保留已提交内容和清理诊断', async t => {
    const f = await fixture(t);
    const source = await f.sample('source.txt', 'NEW');
    const file = await f.sample('target.txt', 'OLD');
    const rm = fs.rm;
    fs.rm = async (target, options) => { if (path.dirname(target) === f.root && path.basename(target).startsWith('.mcp-backup-')) throw fault('EPERM', '备份删除被占用'); return rm(target, options); };
    let response;
    try { response = await f.call(tool, tool === 'write_file' ? { path: file, content: '+NEW', mode: 'append', writePolicy: 'preserve' } : { source, destination: file, writePolicy: 'preserve' }); }
    finally { fs.rm = rm; }
    const data = success(response);
    assert.equal(data.changed, true);
    assert.equal(await fs.readFile(file, 'utf8'), tool === 'write_file' ? 'OLD+NEW' : 'NEW');
    const backup = data.cleanupErrors.find(item => path.basename(item.path).startsWith('.mcp-backup-'));
    assert.equal(backup.code, 'EPERM');
    assert.equal(await fs.readFile(backup.path, 'utf8'), 'OLD');
    assert.ok(response.structuredContent.warnings.length);
    if (tool === 'move_path') await assert.rejects(fs.access(source), { code: 'ENOENT' });
    else assert.equal(await fs.readFile(source, 'utf8'), 'NEW');
  });
}

for (const policy of ['auto', 'preserve', 'plaintext']) {
  test('T3 只读源文件以' + policy + '复制成功且新目标保留只读属性', async t => {
    const f = await fixture(t);
    const source = await f.sample('readonly.txt', 'COPY');
    const destination = path.join(f.root, 'copied.txt');
    await fs.chmod(source, 0o444);
    success(await f.call('copy_path', { source, destination, writePolicy: policy }));
    assert.equal(await fs.readFile(destination, 'utf8'), 'COPY');
    assert.equal(await fs.readFile(source, 'utf8'), 'COPY');
    assert.equal((await fs.stat(destination)).mode & 0o200, 0);
    const writable = await f.sample('writable.txt', 'OLD');
    const overwritten = success(await f.call('copy_path', { source, destination: writable, writePolicy: policy }));
    assert.equal(overwritten.changed, true, '不同内容的目标必须真正覆盖，不能误报同一文件');
    assert.equal(await fs.readFile(writable, 'utf8'), 'COPY');
    assert.notEqual((await fs.stat(writable)).mode & 0o200, 0);
  });
}

test('T4 服务级单进程预算传到读取和安全中转并显示在profile', async t => {
  const budgets = [];
  const f = await fixture(t, {
    options: { processTimeoutMs: 30000 },
    reader: async ({ proc, file, context }) => { budgets.push(context.processTimeoutMs); return proc ? fingerprint(file, context) : null; },
    copier: async ({ source, destination, context }) => { budgets.push(context.processTimeoutMs); await fs.copyFile(source, destination); },
  });
  const file = await f.sample('budget.txt', 'OLD');
  success(await f.call('write_file', { path: file, content: 'NEW', writePolicy: 'plaintext' }));
  assert.ok(budgets.length >= 3);
  assert.ok(budgets.every(value => value === 30000));
  assert.equal(success(await f.call('encryption_profile', {})).processTimeoutMs, 30000);
});

/** 模拟两个不同64位身份在Number中舍入碰撞，保留真实文件内容与stat其他元数据。 */
function collideNumericIdentity(source, destination, field = 'ino') {
  const lstat = fs.lstat;
  const first = 2n ** 56n;
  const second = first + 1n;
  assert.notEqual(first, second);
  assert.equal(Number(first), Number(second));
  fs.lstat = async (file, options) => {
    const stat = await lstat(file, options);
    if (file === source || file === destination) {
      const identity = file === source ? first : second;
      const shared = 123n;
      stat.ino = options?.bigint ? (field === 'ino' ? identity : shared) : Number(field === 'ino' ? identity : shared);
      stat.dev = options?.bigint ? (field === 'dev' ? identity : shared) : Number(field === 'dev' ? identity : shared);
    }
    return stat;
  };
  return () => { fs.lstat = lstat; };
}

for (const policy of ['auto', 'preserve', 'plaintext']) {
  test('T10 ' + policy + '复制不能因64位inode舍入相等而跳过覆盖', async t => {
    const f = await fixture(t);
    const source = await f.sample('identity-source.txt', 'COPY');
    const target = await f.sample('identity-target.txt', 'OLD');
    await fs.chmod(source, 0o444);
    const restore = collideNumericIdentity(source, target);
    let response;
    try { response = await f.call('copy_path', { source, destination: target, writePolicy: policy }); }
    finally { restore(); }
    const data = success(response);
    assert.equal(data.changed, true);
    assert.equal(await fs.readFile(target, 'utf8'), 'COPY');
    assert.equal(await fs.readFile(source, 'utf8'), 'COPY');
    assert.equal((await fs.stat(source)).mode & 0o200, 0);
    assert.notEqual((await fs.stat(target)).mode & 0o200, 0);
  });
}

test('T10 64位设备号舍入碰撞也不能把不同文件当成同一文件', async t => {
  const f = await fixture(t);
  const source = await f.sample('source.txt', 'COPY');
  const target = await f.sample('target.txt', 'OLD');
  const restore = collideNumericIdentity(source, target, 'dev');
  let response;
  try { response = await f.call('copy_path', { source, destination: target, writePolicy: 'preserve' }); }
  finally { restore(); }
  assert.equal(success(response).changed, true);
  assert.equal(await fs.readFile(target, 'utf8'), 'COPY');
});

test('T10 64位inode碰撞时移动仍提交目标并只删除已验证源', async t => {
  const f = await fixture(t);
  const source = await f.sample('source.txt', 'MOVE');
  const target = await f.sample('target.txt', 'OLD');
  const restore = collideNumericIdentity(source, target);
  let response;
  try { response = await f.call('move_path', { source, destination: target, writePolicy: 'auto' }); }
  finally { restore(); }
  assert.equal(success(response).changed, true);
  assert.equal(await fs.readFile(target, 'utf8'), 'MOVE');
  await assert.rejects(fs.access(source), { code: 'ENOENT' });
});

test('T10 真实硬链接仍按同一文件处理，移动拒绝删源', async t => {
  const f = await fixture(t);
  const source = await f.sample('source.txt', 'LINKED');
  const target = path.join(f.root, 'hardlink.txt');
  await fs.link(source, target);
  const sourceStat = await fs.lstat(source, { bigint: true });
  const targetStat = await fs.lstat(target, { bigint: true });
  assert.equal(sourceStat.ino, targetStat.ino);
  assert.equal(sourceStat.dev, targetStat.dev);
  assert.equal(success(await f.call('copy_path', { source, destination: target })).changed, false);
  failure(await f.call('move_path', { source, destination: target }), 'SAME_FILE_ALIAS');
  assert.equal(await fs.readFile(source, 'utf8'), 'LINKED');
  assert.equal(await fs.readFile(target, 'utf8'), 'LINKED');
  assert.equal((await fs.lstat(source, { bigint: true })).ino, sourceStat.ino);
});

test('T4 环境变量预算生效，非法预算在启动时拒绝', async t => {
  const f = await fixture(t);
  const previous = process.env.MCP_PROCESS_TIMEOUT_MS;
  try {
    process.env.MCP_PROCESS_TIMEOUT_MS = '24000';
    const encryption = createEncryption({ ...f.opts, processTimeoutMs: undefined });
    assert.equal((await encryption.summary()).processTimeoutMs, 24000);
    for (const value of ['', '0', '60001', 'oops', '1.5']) {
      process.env.MCP_PROCESS_TIMEOUT_MS = value;
      assert.throws(() => createEncryption({ stateDir: f.stateDir }), { code: 'INVALID_PROCESS_TIMEOUT' });
    }
  } finally { if (previous === undefined) delete process.env.MCP_PROCESS_TIMEOUT_MS; else process.env.MCP_PROCESS_TIMEOUT_MS = previous; }
});

for (const firstEnds of ['cancel', 'timeout']) {
  test('T5 共享探测中首个请求' + firstEnds + '不影响其他等待者或缓存完成', async t => {
    const f = await fixture(t);
    const reached = gate(), release = gate();
    const readFile = fs.readFile;
    let cacheReads = 0;
    fs.readFile = async (file, ...args) => {
      if (file === f.encryption.cachePath && ++cacheReads === 2) { reached.resolve(); await release.promise; }
      return readFile(file, ...args);
    };
    const controller = new AbortController();
    let first, second, secondSettled = false;
    try {
      first = f.handlers.encryption_profile({ timeoutMs: firstEnds === 'timeout' ? 100 : 15000 }, { signal: controller.signal });
      await bounded(reached.promise);
      second = f.call('encryption_profile', {}).then(value => { secondSettled = true; return value; });
      if (firstEnds === 'cancel') controller.abort();
      const data = failure(await bounded(first), firstEnds === 'cancel' ? 'CANCELLED' : 'TIMEOUT');
      assert.equal(data.probeStatus, 'running');
      assert.equal(secondSettled, false);
      release.resolve();
      success(await bounded(second));
      success(await f.call('encryption_profile', {}));
      assert.equal(cacheReads, 2, '迁移读取一次、加载缓存一次，后续请求复用完成结果');
      assert.equal(JSON.parse(await readFile(f.encryption.cachePath, 'utf8')).version, 3);
    } finally {
      release.resolve();
      if (first) await first;
      if (second) await second;
      fs.readFile = readFile;
    }
  });
}

test('T5 后加入的等待者可独立取消，首个请求继续完成', async t => {
  const f = await fixture(t);
  const reached = gate(), release = gate();
  const readFile = fs.readFile;
  let reads = 0;
  fs.readFile = async (file, ...args) => { if (file === f.encryption.cachePath && ++reads === 2) { reached.resolve(); await release.promise; } return readFile(file, ...args); };
  let first;
  try {
    first = f.call('encryption_profile', {});
    await bounded(reached.promise);
    const controller = new AbortController();
    const second = f.handlers.encryption_profile({}, { signal: controller.signal });
    controller.abort();
    failure(await bounded(second), 'CANCELLED');
    release.resolve();
    success(await bounded(first));
  } finally { release.resolve(); if (first) await first; fs.readFile = readFile; }
});

test('T6 探测失败短暂冷却，refresh可在修复环境后立即重试', async t => {
  const f = await fixture(t);
  const writeFile = fs.writeFile;
  let attempts = 0;
  fs.writeFile = async (file, ...args) => { if (String(file).startsWith(f.encryption.cachePath + '.')) { attempts++; throw fault('ENOSPC', '探测缓存写满'); } return writeFile(file, ...args); };
  try {
    failure(await f.call('encryption_profile', {}), 'ENOSPC');
    const second = failure(await f.call('encryption_profile', {}), 'ENOSPC');
    assert.equal(second.probeStatus, 'failed');
    assert.ok(second.retryAfterMs > 0);
    assert.equal(attempts, 1);
  } finally { fs.writeFile = writeFile; }
  success(await f.call('refresh_profile', {}));
  success(await f.call('encryption_profile', {}));
});

test('T7 无读取器时严格拒绝plaintext，诊断保留预算；unsafe可清除', async t => {
  const f = await fixture(t, { profile: { byteReader: null, probeErrors: [{ process: 'powershell', code: 'PROCESS_TIMEOUT', message: 'slow', elapsedMs: 5001, effectiveTimeoutMs: 5000 }] } });
  const file = await f.sample('policy.txt', 'OLD');
  success(await f.call('mark_extension', { extension: '.txt', category: 'unsafe' }));
  const data = failure(await f.call('write_file', { path: file, content: 'NEW' }), 'DISK_UNVERIFIED');
  assert.equal(data.readerDiagnostics[0].code, 'PROCESS_TIMEOUT');
  assert.equal(data.processTimeoutMs, 5000);
  assert.equal(await fs.readFile(file, 'utf8'), 'OLD');
  success(await f.call('mark_extension', { extension: '.txt', category: 'clear' }));
  assert.equal(await f.encryption.getOverride('.txt'), null);
});

test('T6 Windows无读取器的缓存只有效30秒，正常配置保持30天', async t => {
  const f = await fixture(t, { profile: { byteReader: null } });
  const profile = await f.encryption.getProfile();
  const stale = { ...profile, detectedAt: new Date(Date.now() - 31000).toISOString() };
  await fs.writeFile(f.encryption.cachePath, JSON.stringify(stale));
  const loaded = await f.encryption.loadCache();
  assert.equal(loaded === null, process.platform === 'win32');
  await fs.writeFile(f.encryption.cachePath, JSON.stringify({ ...stale, byteReader: 'powershell' }));
  assert.ok(await f.encryption.loadCache());
});

test('T6 refresh与缓存加载重叠时必须重探，不把旧缓存当成刷新结果', async t => {
  const f = await fixture(t);
  const profile = await f.encryption.getProfile();
  await fs.writeFile(f.encryption.cachePath, JSON.stringify({ ...profile, safeExtensions: ['.cached'] }));
  const encryption = createEncryption(f.opts);
  const reached = gate(), release = gate();
  const readFile = fs.readFile;
  let blocked = false;
  fs.readFile = async (file, ...args) => { if (file === encryption.cachePath && !blocked) { blocked = true; reached.resolve(); await release.promise; } return readFile(file, ...args); };
  let loading, refreshing;
  try {
    loading = encryption.getProfile();
    await bounded(reached.promise);
    refreshing = encryption.refresh();
    release.resolve();
    assert.deepEqual((await loading).safeExtensions, ['.cached']);
    assert.deepEqual((await refreshing).safeExtensions, ['.tmp']);
  } finally { release.resolve(); if (loading) await loading; if (refreshing) await refreshing; fs.readFile = readFile; }
});

test('T8 preserve明确标记未观察外部保护状态，同时保持旧diskState字段', async t => {
  const f = await fixture(t);
  const file = await f.sample('policy.txt', 'OLD');
  const data = success(await f.call('write_file', { path: file, content: 'NEW', writePolicy: 'preserve' }));
  assert.equal(data.verificationScope, 'node');
  assert.equal(data.protectionObserved, false);
  assert.equal(data.diskState, 'preserved');
  assert.equal(data.diskVerified, false);
});

test('T9 禁删配置遵守只禁remove_path的既有契约，包含dryRun', async t => {
  const f = await fixture(t, { options: { allowDelete: false } });
  const source = await f.sample('source.txt', 'CONTENT');
  failure(await f.call('remove_path', { path: source, dryRun: true }), 'DELETE_DISABLED');
  const destination = path.join(f.root, 'moved.txt');
  success(await f.call('move_path', { source, destination, writePolicy: 'preserve' }));
  assert.equal(await fs.readFile(destination, 'utf8'), 'CONTENT');
  await assert.rejects(fs.access(source), { code: 'ENOENT' });
});
