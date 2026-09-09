/** 真实SDK/stdio验收，不替换MCP传输和参数校验。 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { fixture, cachedProfile } = require('./helper.cjs');

/** 启动使用隔离profile和根目录的真实服务进程。 */
async function connect(t, f, extraEnv = {}) {
  await fs.writeFile(f.encryption.cachePath, JSON.stringify(cachedProfile()));
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
  const file = path.join(f.root, 'hello.txt');
  data(await client.callTool({ name: 'write_file', arguments: { path: file, content: 'hello\r\nworld\r\n' } }));
  assert.equal(data(await client.callTool({ name: 'read_file', arguments: { path: file } })).content, 'hello\nworld\n');
  data(await client.callTool({ name: 'edit_file', arguments: { path: file, oldString: 'hello\nworld', newString: 'first\nsecond' } }));
  assert.equal(data(await client.callTool({ name: 'read_file_partial', arguments: { path: file, mode: 'lines', startLine: 2 } })).lines[0].text, 'second');
  assert.equal(data(await client.callTool({ name: 'read_files', arguments: { paths: [file] } })).entries.length, 1);
  assert.equal(data(await client.callTool({ name: 'search_files', arguments: { path: file, pattern: 'second', include: '*.txt' } })).results.length, 1);
  assert.equal(data(await client.callTool({ name: 'find_files', arguments: { path: f.root, pattern: '**/*.txt' } })).entries.length, 1);
  assert.ok(data(await client.callTool({ name: 'list_directory', arguments: { path: f.root } })).entries.some(entry => entry.name === 'hello.txt'));
  assert.ok(data(await client.callTool({ name: 'file_info', arguments: { path: file } })).hash);
  const copied = path.join(f.root, 'copy.txt');
  const moved = path.join(f.root, 'moved.txt');
  data(await client.callTool({ name: 'copy_path', arguments: { source: file, destination: copied } }));
  data(await client.callTool({ name: 'move_path', arguments: { source: copied, destination: moved } }));
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
