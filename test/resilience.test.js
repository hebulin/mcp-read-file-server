/** N1—N4的正确行为回归：目录互斥、清理诊断、部分删除与字面量预算。 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { fixture, cachedProfile } = require('./helper.cjs');
const { createServer } = require('../lib/server');
const { fault } = require('../lib/text');
const { runRegex, runLiteral, stop } = require('../lib/regex');
after(() => stop());

/** 创建确定性调度屏障，不改变文件操作本身。 */
function gate() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
/** 给测试自己的屏障设置上限，失败也不会无限挂起。 */
async function bounded(promise, ms = 5000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('测试屏障超时')), ms); })]); }
  finally { clearTimeout(timer); }
}
/** 取得协议成功结果并保留失败内容用于诊断。 */
function success(response) { assert.equal(response.structuredContent.ok, true, JSON.stringify(response)); return response.structuredContent.data; }
/** 断言错误码后返回状态字段。 */
function failure(response, code) { assert.equal(response.structuredContent.ok, false); assert.equal(response.structuredContent.code, code); return response.structuredContent.data; }

test('N1 目录移动与另一个实例写源子文件互斥，已确认的新内容不会丢失', async t => {
  const f = await fixture(t);
  const other = createServer({ ...f.opts, encryption: f.encryption });
  const source = await f.sample('src/a.txt', 'OLD');
  const destination = path.join(f.root, 'dst');
  const reached = gate(), release = gate();
  const realUnlink = fs.unlink;
  // 暂停在最后一次源hash校验后、真实删除前。
  fs.unlink = async file => { if (file === source) { reached.resolve(); await release.promise; } return realUnlink(file); };
  const moving = f.call('move_path', { source: path.dirname(source), destination, writePolicy: 'preserve' });
  let writing;
  let settled = false;
  try {
    await bounded(reached.promise);
    writing = other.handlers.write_file({ path: source, content: 'ACKNOWLEDGED-NEW', writePolicy: 'preserve' }).then(value => { settled = true; return value; });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(settled, false, '子文件写入应等待目录移动完成');
    // 无关路径不因目录操作而被串行阻塞。
    success(await bounded(other.handlers.write_file({ path: path.join(f.root, 'independent.txt'), content: 'PARALLEL', writePolicy: 'preserve' }), 1500));
    release.resolve();
    success(await moving);
    success(await writing);
    assert.equal(await fs.readFile(source, 'utf8'), 'ACKNOWLEDGED-NEW');
    assert.equal(await fs.readFile(path.join(destination, 'a.txt'), 'utf8'), 'OLD');
  } finally { release.resolve(); await moving; if (writing) await writing; fs.unlink = realUnlink; }
});

test('N1 目录占用期间，删除目录和创建子目录都必须等待', async t => {
  const f = await fixture(t);
  const file = await f.sample('tree/a.txt', 'KEEP');
  const reached = gate(), release = gate();
  const holding = f.files.locked([path.dirname(file)], async () => { reached.resolve(); await release.promise; return { changed: false }; });
  try {
    await bounded(reached.promise);
    for (const [name, args] of [['remove_path', { path: path.dirname(file) }], ['create_directory', { path: path.join(path.dirname(file), 'child') }]]) {
      failure(await f.handlers[name](args, { signal: AbortSignal.timeout(100) }), 'CANCELLED');
    }
    assert.equal(await fs.readFile(file, 'utf8'), 'KEEP');
  } finally { release.resolve(); await holding; }
});

test('N1 跨进程的子文件锁阻止父目录操作，反向路径组不会死锁', async t => {
  const f = await fixture(t);
  const file = await f.sample('tree/a.txt', 'KEEP');
  const code = "const locked=require(process.argv[1]).createLocker(process.argv[2]);locked([process.argv[3]],async()=>{process.stdout.write('READY\\n');for await(const chunk of process.stdin){break;}return {changed:false};}).catch(e=>{console.error(e);process.exitCode=1;});";
  const child = spawn(process.execPath, ['-e', code, path.resolve(__dirname, '../lib/locks.js'), f.stateDir, file], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const ready = gate(), closed = gate();
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; if (output.includes('READY')) ready.resolve(); });
  child.on('error', error => ready.resolve(error));
  child.on('close', () => closed.resolve());
  try {
    await bounded(ready.promise);
    failure(await f.handlers.remove_path({ path: path.dirname(file) }, { signal: AbortSignal.timeout(120) }), 'CANCELLED');
  } finally { child.stdin.end('\n'); try { await bounded(closed.promise); } catch { child.kill(); await bounded(closed.promise); } }
  const a = path.join(f.root, 'a'), b = path.join(f.root, 'b');
  const values = await bounded(Promise.all([f.files.locked([a, b], async () => ({ changed: false, value: 1 })), f.files.locked([b, a], async () => ({ changed: false, value: 2 }))]));
  assert.deepEqual(values.map(x => x.value), [1, 2]);
  assert.equal(await fs.readFile(file, 'utf8'), 'KEEP');
});

test('N2 成功写入后锁清理失败，仍报告成功改变并附清理告警', async t => {
  const f = await fixture(t);
  const file = await f.sample('target.txt', 'OLD');
  const realRm = fs.rm;
  // 只让本案例租约文件清理失败，不影响登记临界区。
  fs.rm = async (target, options) => { if (String(target).startsWith(f.root) && String(target).endsWith('.lock')) throw fault('EBUSY', '模拟锁清理失败'); return realRm(target, options); };
  let response;
  try { response = await f.call('write_file', { path: file, content: 'NEW', writePolicy: 'preserve' }); }
  finally { fs.rm = realRm; }
  const data = success(response);
  assert.equal(data.changed, true);
  assert.equal(response.structuredContent.changed, true);
  assert.equal(data.cleanupErrors[0].code, 'EBUSY');
  assert.ok(response.structuredContent.warnings.length);
  assert.equal(await fs.readFile(file, 'utf8'), 'NEW');
});

test('N2 安装、回滚和两项清理连续失败仍保留原错误与恢复备份', async t => {
  const f = await fixture(t);
  const file = await f.sample('target.txt', 'ORIGINAL');
  const realRename = fs.rename, realRm = fs.rm;
  // 故障均精确限制到当前样本及其暂存/锁文件。
  fs.rename = async (from, to) => {
    if (to === file && path.basename(from).startsWith('.mcp-stage-')) throw fault('EACCES', '模拟安装失败');
    if (to === file && path.basename(from).startsWith('.mcp-backup-')) throw fault('EBUSY', '模拟回滚失败');
    return realRename(from, to);
  };
  fs.rm = async (target, options) => {
    if (String(target).startsWith(f.root) && (path.basename(target).startsWith('.mcp-stage-') || target.endsWith('.lock'))) throw fault('EPERM', '模拟清理失败');
    return realRm(target, options);
  };
  let response;
  try { response = await f.call('write_file', { path: file, content: 'NEW', writePolicy: 'preserve' }); }
  finally { fs.rename = realRename; fs.rm = realRm; }
  const data = failure(response, 'EACCES');
  assert.equal(data.changed, true);
  assert.equal(data.cleanupErrors.length, 2);
  assert.match(data.rollbackError, /回滚失败/);
  assert.equal(await fs.readFile(data.recoveryPath, 'utf8'), 'ORIGINAL');
  await assert.rejects(fs.access(file), { code: 'ENOENT' });
});

test('N2 暂存写满磁盘与清理同时失败，不覆盖原始ENOSPC', async t => {
  const f = await fixture(t);
  const file = await f.sample('target.txt', 'ORIGINAL');
  f.encryption.prepare = async stage => { await fs.writeFile(stage, 'PART'); throw fault('ENOSPC', '模拟磁盘满'); };
  const realRm = fs.rm;
  fs.rm = async (target, options) => { if (path.dirname(target) === f.root && path.basename(target).startsWith('.mcp-stage-')) throw fault('EBUSY', '模拟暂存清理失败'); return realRm(target, options); };
  let response;
  try { response = await f.call('write_file', { path: file, content: 'NEW', writePolicy: 'preserve' }); }
  finally { fs.rm = realRm; }
  const data = failure(response, 'ENOSPC');
  assert.equal(data.changed, false);
  assert.equal(data.cleanupErrors.length, 1);
  assert.equal(await fs.readFile(file, 'utf8'), 'ORIGINAL');
});

test('N2 目录复制成功时保留子文件的清理诊断', async t => {
  const f = await fixture(t);
  const source = await f.sample('src/a.txt', 'A');
  const destination = path.join(f.root, 'dst');
  const realRm = fs.rm;
  // 提交已经完成，仅模拟清理阶段权限错误，检查诊断跨目录包装保留。
  fs.rm = async (target, options) => { if (path.dirname(target) === destination && path.basename(target).startsWith('.mcp-stage-')) throw fault('EACCES', '模拟清理阶段访问失败'); return realRm(target, options); };
  let response;
  try { response = await f.call('copy_path', { source: path.dirname(source), destination, writePolicy: 'preserve' }); }
  finally { fs.rm = realRm; }
  const data = success(response);
  assert.equal(data.changed, true);
  assert.equal(data.cleanupErrors[0].code, 'EACCES');
  assert.ok(response.structuredContent.warnings.length);
  assert.equal(await fs.readFile(path.join(destination, 'a.txt'), 'utf8'), 'A');
});

test('N3 递归删除中途失败返回已删除项、准确计数与失败路径', async t => {
  const f = await fixture(t);
  const a = await f.sample('tree/a.txt', 'A');
  const b = await f.sample('tree/b.txt', 'B');
  const realUnlink = fs.unlink;
  fs.unlink = async file => { if (file === b) throw fault('EBUSY', '模拟占用'); return realUnlink(file); };
  let response;
  try { response = await f.call('remove_path', { path: path.dirname(a) }); }
  finally { fs.unlink = realUnlink; }
  const data = failure(response, 'EBUSY');
  assert.equal(data.changed, true);
  assert.deepEqual(data.partial, [a]);
  assert.equal(data.removedCount, 1);
  assert.equal(data.failedPath, b);
  assert.equal(data.partialTruncated, false);
  await assert.rejects(fs.access(a), { code: 'ENOENT' });
  assert.equal(await fs.readFile(b, 'utf8'), 'B');
});

test('N3 删除部分完成后取消仍保留准确状态', async t => {
  const f = await fixture(t);
  const a = await f.sample('tree/a.txt', 'A');
  const b = await f.sample('tree/b.txt', 'B');
  const controller = new AbortController();
  const realUnlink = fs.unlink;
  fs.unlink = async file => { await realUnlink(file); if (file === a) controller.abort(); };
  let response;
  try { response = await f.handlers.remove_path({ path: path.dirname(a) }, { signal: controller.signal }); }
  finally { fs.unlink = realUnlink; }
  const data = failure(response, 'CANCELLED');
  assert.equal(data.changed, true);
  assert.equal(data.removedCount, 1);
  assert.deepEqual(data.partial, [a]);
  assert.equal(await fs.readFile(b, 'utf8'), 'B');
});

test('N3 Windows真实独占句柄造成部分删除，返回状态与磁盘一致', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t);
  const a = await f.sample('tree/a.txt', 'FREE');
  const b = await f.sample('tree/b.txt', 'LOCKED');
  const quoted = "'" + b.replace(/'/g, "''") + "'";
  const code = "$ErrorActionPreference='Stop';$f=[IO.File]::Open(" + quoted + ",[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None);try{[Console]::Out.WriteLine('READY');[Console]::Out.Flush();[Console]::ReadLine()|Out-Null}finally{$f.Dispose()}";
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', code], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const ready = gate(), closed = gate();
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; if (output.includes('READY')) ready.resolve(); });
  child.on('error', error => ready.resolve(error));
  child.on('close', () => closed.resolve());
  let response;
  try { await bounded(ready.promise); response = await f.call('remove_path', { path: path.dirname(a), recursive: true }); }
  finally { child.stdin.end('\n'); try { await bounded(closed.promise); } catch { child.kill(); await bounded(closed.promise); } }
  const data = failure(response, 'EBUSY');
  assert.equal(data.changed, true);
  assert.equal(data.removedCount, 1);
  assert.deepEqual(data.partial, [a]);
  assert.equal(await fs.readFile(b, 'utf8'), 'LOCKED');
});

test('N4 字面量扩大结果先检查体量，超限不改文件', async t => {
  const f = await fixture(t);
  const original = 'a'.repeat(20000);
  const file = await f.sample('expand.txt', original);
  failure(await f.call('edit_file', { path: file, oldString: 'a', newString: 'b'.repeat(1000), replaceAll: true }), 'FILE_TOO_LARGE');
  assert.equal(await fs.readFile(file, 'utf8'), original);
});

test('N4 字面量排队时间计入硬预算，取消后可继续编辑', async () => {
  const slow = runRegex({ operation: 'edit', pattern: '^(a+)+$', text: 'a'.repeat(32) + '!', replacement: 'x' }).catch(error => error);
  await assert.rejects(runLiteral('a', { oldString: 'a', newString: 'b' }, false, { timeoutMs: 100 }), { code: 'TIMEOUT' });
  await slow;
  const controller = new AbortController();
  const pending = runLiteral('a', { oldString: 'a', newString: 'b' }, false, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { code: 'CANCELLED' });
  assert.equal((await runLiteral('a', { oldString: 'a', newString: 'b' }, false)).updated, 'b');
});

test('N4 真实stdio字面量replaceAll保持心跳响应并遵守预算', async t => {
  const f = await fixture(t);
  const original = 'a'.repeat(20000) + 'z'.repeat(500000);
  const file = await f.sample('large.txt', original);
  await fs.writeFile(f.encryption.cachePath, JSON.stringify(cachedProfile()));
  const client = new Client({ name: 'literal-regression', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve(__dirname, '../index.js')], cwd: f.root, stderr: 'pipe', env: { ...process.env, MCP_PROFILE_DIR: f.stateDir, MCP_BASE_DIR: f.root, MCP_ALLOWED_ROOTS: JSON.stringify([f.root]) } });
  await client.connect(transport);
  f.cleanupTasks.push(() => client.close());
  const begin = performance.now();
  const editing = client.callTool({ name: 'edit_file', arguments: { path: file, oldString: 'a', newString: 'b', replaceAll: true, dryRun: true, timeoutMs: 100 } }).then(response => ({ response, elapsedMs: performance.now() - begin }));
  await new Promise(resolve => setTimeout(resolve, 20));
  const pulse = performance.now();
  success(await client.callTool({ name: 'check_status', arguments: {} }));
  const heartbeatMs = performance.now() - pulse;
  const result = await editing;
  assert.ok(['OK', 'TIMEOUT'].includes(result.response.structuredContent.code));
  if (result.response.structuredContent.ok) assert.equal(result.response.structuredContent.data.replaced, 20000);
  assert.ok(result.elapsedMs < 1000, '编辑耗时=' + result.elapsedMs);
  assert.ok(heartbeatMs < 800, '心跳耗时=' + heartbeatMs);
  assert.equal(await fs.readFile(file, 'utf8'), original);
  t.diagnostic(JSON.stringify({ inputBytes: original.length, requestedTimeoutMs: 100, code: result.response.structuredContent.code, elapsedMs: result.elapsedMs, heartbeatMs }));
});
