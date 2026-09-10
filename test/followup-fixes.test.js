/** 子代理审查FS1—FS4及TP1的正确行为回归；全部样本和配置隔离。 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { fixture, cachedProfile } = require('./helper.cjs');
const { createServer } = require('../lib/server');
const { fingerprint, fault } = require('../lib/text');
const { globMatcherAsync } = require('../lib/patterns');

/** 取得成功的结构化数据，失败时展示完整响应。 */
function success(response) { assert.equal(response.structuredContent.ok, true, JSON.stringify(response)); return response.structuredContent.data; }
/** 核对业务错误后取得状态字段。 */
function failure(response, code) { assert.equal(response.structuredContent.ok, false, JSON.stringify(response)); assert.equal(response.structuredContent.code, code); return response.structuredContent.data; }
/** 建立确定性的调度屏障，不改变文件操作返回值。 */
function gate() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
/** 限制测试等待时间，错误时不让测试进程永久挂起。 */
async function bounded(promise, ms = 4000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('测试等待超时')), ms); })]); }
  finally { clearTimeout(timer); }
}
/** 使用平台支持的目录链接，不申请额外权限或修改环境。 */
async function directoryLink(target, alias) { await fs.symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir'); }

test('FS1 工作根配置为目录别名时，同时拒绝删除或移动真实根与配置别名', async t => {
  const f = await fixture(t);
  const file = await f.sample('actual/keep.txt', 'WORKSPACE-CONTENT');
  const actual = path.dirname(file), alias = path.join(f.root, 'alias');
  await directoryLink(actual, alias);
  const app = createServer({ ...f.opts, encryption: f.encryption, baseDir: alias, allowedRoots: [] });
  for (const root of [actual, alias]) {
    failure(await app.handlers.remove_path({ path: root }), 'PROTECTED_ROOT');
    failure(await app.handlers.move_path({ source: root, destination: path.join(f.root, 'moved') }), 'PROTECTED_ROOT');
  }
  assert.equal(await fs.readFile(file, 'utf8'), 'WORKSPACE-CONTENT');
  await assert.rejects(fs.access(path.join(f.root, 'moved')), { code: 'ENOENT' });
});

test('FS1 别名位于工作根祖先时仍保护真实根，普通链接可以单独删除', async t => {
  const f = await fixture(t);
  const file = await f.sample('actual/work/keep.txt', 'KEEP');
  const alias = path.join(f.root, 'alias');
  await directoryLink(path.join(f.root, 'actual'), alias);
  const app = createServer({ ...f.opts, encryption: f.encryption, baseDir: path.join(alias, 'work'), allowedRoots: [] });
  failure(await app.handlers.remove_path({ path: path.dirname(file) }), 'PROTECTED_ROOT');
  failure(await app.handlers.move_path({ source: path.join(f.root, 'actual'), destination: path.join(f.root, 'moved-parent') }), 'PROTECTED_ROOT');
  failure(await app.handlers.remove_path({ path: path.join(f.root, 'actual') }), 'PROTECTED_ROOT');
  const target = await f.sample('separate/value.txt', 'SEPARATE');
  const childLink = path.join(path.dirname(file), 'link');
  await directoryLink(path.dirname(target), childLink);
  success(await app.handlers.remove_path({ path: childLink }));
  assert.equal(await fs.readFile(target, 'utf8'), 'SEPARATE');
  assert.equal(await fs.readFile(file, 'utf8'), 'KEEP');
});

test('FS2 空目录移动部分删除失败，返回源变化计数及路径', async t => {
  const f = await fixture(t);
  const source = path.join(f.root, 'src'), target = path.join(f.root, 'out/src');
  for (const root of [source, target]) for (const name of ['a', 'b']) await fs.mkdir(path.join(root, name), { recursive: true });
  const realRmdir = fs.rmdir;
  let removed, retained;
  // 只让第二个源子目录删除失败，不依赖目录枚举顺序。
  fs.rmdir = async (file, ...args) => {
    if (path.dirname(file) === source) {
      if (removed) { retained = file; throw fault('EBUSY', '模拟第二个空目录占用'); }
      await realRmdir(file, ...args); removed = file; return;
    }
    return realRmdir(file, ...args);
  };
  let response;
  try { response = await f.call('move_path', { source, destination: path.dirname(target), writePolicy: 'preserve' }); }
  finally { fs.rmdir = realRmdir; }
  const data = failure(response, 'EBUSY');
  assert.equal(data.changed, true);
  assert.equal(data.sourceRetained, false);
  assert.equal(data.removedSourceCount, 1);
  assert.deepEqual(data.removedSourcePaths, [removed]);
  assert.equal(data.removedSourcePathsTruncated, false);
  await assert.rejects(fs.access(removed), { code: 'ENOENT' });
  await fs.access(retained);
  for (const name of ['a', 'b']) await fs.access(path.join(target, name));
});

test('FS2 未删除源项时失败仍报告未变化；成功移动空目录正常完成', async t => {
  const f = await fixture(t);
  const source = path.join(f.root, 'src'), target = path.join(f.root, 'out/src');
  await fs.mkdir(source); await fs.mkdir(target, { recursive: true });
  const realRmdir = fs.rmdir;
  fs.rmdir = async (file, ...args) => { if (file === source) throw fault('EBUSY', '模拟源根占用'); return realRmdir(file, ...args); };
  let response;
  try { response = await f.call('move_path', { source, destination: path.dirname(target) }); }
  finally { fs.rmdir = realRmdir; }
  const data = failure(response, 'EBUSY');
  assert.equal(data.changed, false);
  assert.equal(data.sourceRetained, true);
  assert.equal(data.removedSourceCount, 0);
  success(await f.call('move_path', { source, destination: path.dirname(target) }));
  await assert.rejects(fs.access(source), { code: 'ENOENT' });
  await fs.access(target);
});

test('FS3 策略探测完成并清理后才允许移动父目录，目标不留下探测文件', async t => {
  const reached = gate(), release = gate();
  const f = await fixture(t, {
    /** 在真实探测文件已生成后暂停独立读取结果，模拟正常异步I/O窗口。 */
    reader: async ({ file, context }) => {
      const raw = await fingerprint(file, context);
      if (path.basename(file).startsWith('.mcp-probe-')) { reached.resolve(file); await release.promise; }
      return raw;
    },
  });
  const file = await f.sample('src/data.txt', 'USER-CONTENT');
  const destination = path.join(f.root, 'dst');
  const inspecting = f.call('inspect_write_strategy', { path: path.join(path.dirname(file), 'new.txt') });
  let moving, settled = false;
  try {
    await bounded(reached.promise);
    moving = f.call('move_path', { source: path.dirname(file), destination, writePolicy: 'preserve' }).then(value => { settled = true; return value; });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(settled, false);
    release.resolve();
    success(await inspecting);
    assert.equal(success(await moving).files, 1);
    assert.deepEqual(await fs.readdir(destination), ['data.txt']);
    assert.equal(await fs.readFile(path.join(destination, 'data.txt'), 'utf8'), 'USER-CONTENT');
  } finally { release.resolve(); await inspecting; if (moving) await moving; }
});

test('FS4 目录复制后续失败时保留先前清理诊断及当前主错误', async t => {
  const f = await fixture(t);
  const a = await f.sample('src/a.txt', 'A');
  const b = await f.sample('src/b.txt', 'B');
  const destination = path.join(f.root, 'dst/src');
  await fs.mkdir(path.join(destination, 'b.txt'), { recursive: true });
  const realRm = fs.rm;
  fs.rm = async (file, ...args) => { if (path.dirname(file) === destination && path.basename(file).startsWith('.mcp-stage-')) throw fault('EACCES', '模拟首项清理失败'); return realRm(file, ...args); };
  let response;
  try { response = await f.call('copy_path', { source: path.dirname(a), destination: path.dirname(destination), writePolicy: 'preserve' }); }
  finally { fs.rm = realRm; }
  const data = failure(response, 'NOT_FILE');
  assert.equal(data.changed, true);
  assert.deepEqual(data.partial, [path.join(destination, 'a.txt')]);
  assert.equal(data.cleanupErrors.length, 1);
  assert.equal(data.cleanupErrors[0].code, 'EACCES');
  assert.ok(response.structuredContent.warnings.length);
  assert.equal(await fs.readFile(path.join(destination, 'a.txt'), 'utf8'), 'A');
  assert.equal(await fs.readFile(b, 'utf8'), 'B');
});

/** 构造不含重复项、但每项仍满足schema的高复杂度模式。 */
function uniquePatterns() {
  return Array.from({ length: 100 }, (_, i) => '*a'.repeat(200) + '{' + Array.from({ length: 64 }, (_, j) => 'x' + j).join(',') + '}end' + i);
}

test('TP1 异步glob保留花括号、basename与字面括号语义', async () => {
  const cases = [
    ['*.{ts,tsx}', 'src/a.tsx', true], ['*.{ts,tsx}', 'src/a.js', false],
    ['**/foo.js', 'foo.js', true], ['**/foo.js', 'a/foo.js', true], ['**/foo.js', 'notfoo.js', false],
    ['app/(auth)/page.tsx', 'app/(auth)/page.tsx', true], ['app/(auth)/page.tsx', 'app/auth/page.tsx', false],
    ['{src,{lib,test}}/*.js', 'test/a.js', true], [undefined, 'nested/file.txt', true],
  ];
  for (const [pattern, file, expected] of cases) assert.equal(await (await globMatcherAsync(pattern))(file), expected);
});

test('TP1 glob总预算跨文件累计，计算过程中让出事件循环', async () => {
  const matches = await globMatcherAsync('*a'.repeat(200) + 'x');
  let ticked = false;
  const first = matches('a'.repeat(200) + '.txt');
  const timer = setImmediate(() => { ticked = true; });
  try { assert.equal(await first, false); assert.equal(ticked, true); }
  finally { clearImmediate(timer); }
  let processed = 1;
  await assert.rejects(async () => { for (; processed < 1000; processed++) await matches('a'.repeat(200) + '.txt'); }, { code: 'GLOB_LIMIT' });
  assert.ok(processed > 1 && processed < 1000);
});

test('TP1 glob编译也受总预算、截止时间和取消约束', async () => {
  await assert.rejects(globMatcherAsync(uniquePatterns()), { code: 'GLOB_LIMIT' });
  await assert.rejects(globMatcherAsync('*.js', { deadline: performance.now() - 1 }), { code: 'TIMEOUT' });
  const controller = new AbortController();
  const compiling = globMatcherAsync(uniquePatterns(), { signal: controller.signal });
  controller.abort();
  await assert.rejects(compiling, { code: 'CANCELLED' });
  const matches = await globMatcherAsync('*.txt', { signal: controller.signal }).catch(error => error);
  assert.equal(matches.code, 'CANCELLED');
});

test('TP1 真实stdio复杂include保持心跳响应，重复模式优化且过量编译明确失败', async t => {
  const f = await fixture(t);
  const file = await f.sample('samples/' + 'a'.repeat(200) + '.txt', 'hello');
  await fs.writeFile(f.encryption.cachePath, JSON.stringify(cachedProfile()));
  const client = new Client({ name: 'glob-regression', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve(__dirname, '../index.js')], cwd: f.root, stderr: 'pipe', env: { ...process.env, MCP_PROFILE_DIR: f.stateDir, MCP_BASE_DIR: f.root, MCP_ALLOWED_ROOTS: JSON.stringify([f.root]) } });
  await client.connect(transport);
  f.cleanupTasks.push(() => client.close());
  const include = Array(100).fill('*a'.repeat(200) + '{' + Array(64).fill('x').join(',') + '}');
  const start = performance.now();
  const pending = client.callTool({ name: 'search_files', arguments: { path: path.dirname(file), pattern: 'hello', mode: 'literal', include, timeoutMs: 300 } }).then(response => ({ response, elapsedMs: performance.now() - start }));
  await new Promise(resolve => setTimeout(resolve, 10));
  const pulse = performance.now();
  success(await client.callTool({ name: 'check_status', arguments: {} }));
  const heartbeatMs = performance.now() - pulse;
  const result = await bounded(pending);
  assert.equal(success(result.response).results.length, 0);
  assert.ok(result.elapsedMs < 800, '查询耗时=' + result.elapsedMs);
  assert.ok(heartbeatMs < 500, '心跳耗时=' + heartbeatMs);
  const limited = await client.callTool({ name: 'search_files', arguments: { path: path.dirname(file), pattern: 'hello', include: uniquePatterns(), timeoutMs: 3000 } });
  failure(limited, 'GLOB_LIMIT');
  assert.equal(success(await client.callTool({ name: 'find_files', arguments: { path: path.dirname(file), pattern: '*.txt' } })).entries.length, 1);
  t.diagnostic(JSON.stringify({ includeCount: 100, alternativesEach: 64, requestedTimeoutMs: 300, elapsedMs: result.elapsedMs, heartbeatMs, distinctPatternCode: limited.structuredContent.code }));
});
