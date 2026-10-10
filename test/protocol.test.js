/** 真实SDK/stdio验收，不替换MCP传输和参数校验。 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { fixture, cachedProfile } = require('./helper.cjs');

/** 启动使用隔离profile和根目录的真实进程；重启验收可保留刚刷新的实际缓存。 */
async function connect(t, f, extraEnv = {}, preserveProfile = false) {
  if (!preserveProfile) await fs.writeFile(f.encryption.cachePath, JSON.stringify(cachedProfile()));
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve(__dirname, '../index.js')], cwd: f.root, stderr: 'pipe', env: { ...process.env, MCP_PROFILE_DIR: f.stateDir, MCP_BASE_DIR: f.root, MCP_ALLOWED_ROOTS: JSON.stringify([f.root]), ...extraEnv } });
  const client = new Client({ name: 'regression', version: '1.0.0' });
  await client.connect(transport);
  f.cleanupTasks.push(() => client.close());
  return client;
}

/** 验证成功响应有稳定的结构化字段与可读文本。 */
function data(response) {
  assert.ok(!response.isError, JSON.stringify(response));
  assert.equal(response.structuredContent.ok, true);
  return response.structuredContent.data;
}

test('真实stdio：18个工具注册、输入输出schema和全部基础文件操作', async t => {
  const f = await fixture(t);
  const client = await connect(t, f);
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 18);
  assert.ok(tools.tools.every(tool => tool.inputSchema && tool.outputSchema));
  assert.equal(client.getServerVersion().version, require('../package.json').version);
  // 此协议夹具故意不配置外部读取器，显式preserve验证基础工具协议；auto拒绝路径另行覆盖。
  const writePolicy = 'preserve';
  const file = path.join(f.root, 'hello.txt');
  data(await client.callTool({ name: 'write_file', arguments: { path: file, content: 'hello\r\nworld\r\n', writePolicy } }));
  assert.equal(data(await client.callTool({ name: 'read_file', arguments: { path: file } })).content, 'hello\r\nworld\r\n');
  data(await client.callTool({ name: 'edit_file', arguments: { path: file, oldString: 'hello\nworld', newString: 'first\nsecond', writePolicy } }));
  assert.equal(data(await client.callTool({ name: 'read_file', arguments: { path: file } })).content, 'first\r\nsecond\r\n');
  assert.equal(data(await client.callTool({ name: 'read_file_partial', arguments: { path: file, mode: 'lines', startLine: 2 } })).lines[0].text, 'second');
  assert.equal(data(await client.callTool({ name: 'read_files', arguments: { paths: [file] } })).entries.length, 1);
  assert.equal(data(await client.callTool({ name: 'search_files', arguments: { path: file, pattern: 'second', include: '*.txt' } })).results.length, 1);
  assert.equal(data(await client.callTool({ name: 'find_files', arguments: { path: f.root, pattern: '**/*.txt' } })).entries.length, 1);
  assert.ok(data(await client.callTool({ name: 'list_directory', arguments: { path: f.root } })).entries.some(entry => entry.name === 'hello.txt'));
  assert.ok(data(await client.callTool({ name: 'file_info', arguments: { path: file } })).hash);
  const copied = path.join(f.root, 'copy.txt');
  const moved = path.join(f.root, 'moved.txt');
  data(await client.callTool({ name: 'copy_path', arguments: { source: file, destination: copied, writePolicy } }));
  data(await client.callTool({ name: 'move_path', arguments: { source: copied, destination: moved, writePolicy } }));
  assert.equal(data(await client.callTool({ name: 'remove_path', arguments: { path: moved, dryRun: true } })).changed, false);
  data(await client.callTool({ name: 'remove_path', arguments: { path: moved } }));
  data(await client.callTool({ name: 'create_directory', arguments: { path: path.join(f.root, 'empty') } }));
  data(await client.callTool({ name: 'remove_path', arguments: { path: path.join(f.root, 'empty'), recursive: false } }));
  assert.equal(data(await client.callTool({ name: 'check_status', arguments: {} })).decryptionVerified, false);
  data(await client.callTool({ name: 'mark_extension', arguments: { extension: '.java', category: 'protected' } }));
  assert.equal(data(await client.callTool({ name: 'inspect_write_strategy', arguments: { path: path.join(f.root, 'a.java') } })).mode, 'preserve');
  assert.equal(data(await client.callTool({ name: 'encryption_profile', arguments: {} })).overrides[0].category, 'protected');
  const bad = await client.callTool({ name: 'read_file_partial', arguments: { path: file, mode: 'chars', charCount: -1 } });
  assert.equal(bad.isError, true);
  const tooLarge = await client.callTool({ name: 'search_files', arguments: { path: f.root, pattern: 'x', maxResults: 10000000 } });
  assert.equal(tooLarge.isError, true);
  const invalidMark = await client.callTool({ name: 'mark_extension', arguments: { extension: '../evil', category: 'unsafe' } });
  assert.equal(invalidMark.isError, true);
});

test('真实stdio：无外部读取器时Windows auto拒绝写入并保留基线，显式策略可用', async t => {
  const f = await fixture(t);
  const file = await f.sample('unverified.custom', 'ORIGINAL');
  const client = await connect(t, f);
  const response = await client.callTool({ name: 'write_file', arguments: { path: file, content: 'NEW' } });
  if (process.platform === 'win32') {
    assert.equal(response.structuredContent.code, 'DISK_UNVERIFIED');
    assert.equal(response.structuredContent.changed, false);
    assert.equal(await fs.readFile(file, 'utf8'), 'ORIGINAL');
  } else {
    assert.equal(data(response).diskState, 'unknown');
    assert.ok(response.structuredContent.warnings.length);
  }
  const explicit = await client.callTool({ name: 'write_file', arguments: { path: file, content: 'EXPLICIT', writePolicy: 'preserve' } });
  assert.equal(data(explicit).strategy.basis, 'explicit');
  assert.ok(explicit.structuredContent.warnings.some(w => w.includes('IDEA')));
});

test('真实stdio：正则计算中tools/list继续响应，超时后仍能读取文件', async t => {
  const f = await fixture(t);
  const file = await f.sample('redos.txt', 'a'.repeat(32) + '!');
  const client = await connect(t, f);
  const pending = client.callTool({ name: 'search_files', arguments: { path: file, pattern: '^(a+)+$' } });
  const begin = performance.now();
  const tools = await client.listTools();
  const latency = performance.now() - begin;
  assert.equal(tools.tools.length, 18);
  assert.ok(latency < 800, 'tools/list耗时=' + latency);
  const response = await pending;
  assert.equal(response.isError, true);
  assert.equal(response.structuredContent.code, 'REGEX_TIMEOUT');
  assert.equal(data(await client.callTool({ name: 'read_file', arguments: { path: file } })).content, 'a'.repeat(32) + '!');
  t.diagnostic(JSON.stringify({ toolsListLatencyMs: latency }));
});

test('真实stdio：只读模式允许读取、拒绝写入，根目录外路径拒绝', async t => {
  const f = await fixture(t);
  const file = await f.sample('keep.txt', 'keep');
  const client = await connect(t, f, { MCP_READ_ONLY: '1' });
  assert.equal(data(await client.callTool({ name: 'read_file', arguments: { path: file } })).content, 'keep');
  const write = await client.callTool({ name: 'write_file', arguments: { path: file, content: 'changed' } });
  assert.equal(write.structuredContent.code, 'READ_ONLY');
  const outside = await client.callTool({ name: 'read_file', arguments: { path: path.resolve(f.root, '..', 'outside') } });
  assert.equal(outside.structuredContent.code, 'PATH_OUTSIDE_ROOTS');
  assert.equal(await fs.readFile(file, 'utf8'), 'keep');
});

test('现场补测C10：真实刷新与重启保留人工策略，clear后不会复活', { timeout: 90000 }, async t => {
  const f = await fixture(t);
  const client = await connect(t, f);
  data(await client.callTool({ name: 'mark_extension', arguments: { extension: '.field-preserve', category: 'protected' } }));
  data(await client.callTool({ name: 'mark_extension', arguments: { extension: '.field-plain', category: 'unsafe' } }));
  const refreshed = data(await client.callTool({ name: 'refresh_profile', arguments: { timeoutMs: 60000 } }, undefined, { timeout: 70000 }));
  assert.ok(refreshed.overrides.some(item => item.extension === '.field-preserve' && item.category === 'protected'));
  assert.ok(refreshed.overrides.some(item => item.extension === '.field-plain' && item.category === 'unsafe'));
  await client.close();
  const restarted = await connect(t, f, {}, true);
  const profile = data(await restarted.callTool({ name: 'encryption_profile', arguments: {} }));
  assert.equal(profile.detectedAt, refreshed.detectedAt, '重启应读取实际刷新缓存，而非重建测试缓存');
  assert.deepEqual(profile.overrides, refreshed.overrides);
  const target = path.join(f.root, 'sample.field-preserve');
  const automatic = data(await restarted.callTool({ name: 'inspect_write_strategy', arguments: { path: target, writePolicy: 'auto' } }));
  assert.equal(automatic.mode, 'preserve');
  assert.equal(automatic.basis, 'override');
  const explicit = data(await restarted.callTool({ name: 'inspect_write_strategy', arguments: { path: target, writePolicy: 'plaintext' } }));
  assert.equal(explicit.mode, 'plaintext');
  assert.equal(explicit.basis, 'explicit');
  data(await restarted.callTool({ name: 'mark_extension', arguments: { extension: '.field-preserve', category: 'clear' } }));
  await restarted.close();
  const cleared = await connect(t, f, {}, true);
  const afterClear = data(await cleared.callTool({ name: 'encryption_profile', arguments: {} }));
  assert.ok(!afterClear.overrides.some(item => item.extension === '.field-preserve'));
  assert.ok(afterClear.overrides.some(item => item.extension === '.field-plain' && item.category === 'unsafe'));
});

test('现场补测N08：慢正则仍运行时取消排队请求，运行与其他排队请求不被连带取消', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const slowFile = await f.sample('slow.txt', 'a'.repeat(40) + '!');
  const cancelledFile = await f.sample('cancelled.txt', 'abc');
  const survivingFile = await f.sample('surviving.txt', 'abc');
  const client = await connect(t, f);
  // 先启动worker，减少冷启动对后续取消时间线的干扰。
  data(await client.callTool({ name: 'edit_file', arguments: { path: survivingFile, oldString: 'a', newString: 'b', dryRun: true } }));
  const slowController = new AbortController();
  const queuedController = new AbortController();
  let slowSettled = false, queuedSettled = false, survivingSettled = false;
  const begin = performance.now();
  const slow = client.callTool({ name: 'edit_file', arguments: { path: slowFile, oldString: '^(a+)+$', newString: 'x', useRegex: true, dryRun: true, timeoutMs: 5000 } }, undefined, { signal: slowController.signal })
    .then(response => ({ response }), error => ({ error })).finally(() => { slowSettled = true; });
  let queued, surviving;
  try {
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(slowSettled, false, '慢任务已结束时不能声称测试了排队取消');
    queued = client.callTool({ name: 'edit_file', arguments: { path: cancelledFile, oldString: 'a', newString: 'b', dryRun: true, timeoutMs: 5000 } }, undefined, { signal: queuedController.signal })
      .then(response => ({ response }), error => ({ error })).finally(() => { queuedSettled = true; });
    surviving = client.callTool({ name: 'edit_file', arguments: { path: survivingFile, oldString: 'a', newString: 'b', dryRun: true, timeoutMs: 5000 } })
      .then(response => ({ response }), error => ({ error })).finally(() => { survivingSettled = true; });
    await new Promise(resolve => setTimeout(resolve, 75));
    assert.equal(slowSettled, false);
    assert.equal(queuedSettled, false);
    assert.equal(survivingSettled, false);
    const cancelledAt = performance.now() - begin;
    queuedController.abort();
    assert.ok((await queued).error, '取消应体现为SDK请求拒绝');
    assert.equal((await client.listTools()).tools.length, 18);
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(slowSettled, false, '取消排队请求不得终止运行中的正则');
    assert.equal(survivingSettled, false, '其他排队请求不得被连带拒绝');
    slowController.abort();
    assert.ok((await slow).error);
    const survivor = await surviving;
    assert.equal(survivor.error, undefined);
    assert.equal(data(survivor.response).replaced, 1);
    assert.equal(await fs.readFile(slowFile, 'utf8'), 'a'.repeat(40) + '!');
    assert.equal(await fs.readFile(cancelledFile, 'utf8'), 'abc');
    assert.equal(await fs.readFile(survivingFile, 'utf8'), 'abc');
    t.diagnostic(JSON.stringify({ cancelledAtMs: cancelledAt, elapsedMs: performance.now() - begin, slowPendingAtCancellation: true }));
  } finally {
    queuedController.abort();
    slowController.abort();
    await Promise.allSettled([slow, queued, surviving].filter(Boolean));
  }
});
