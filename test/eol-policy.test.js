/** 2.1.2真机C06回归：auto无旧行尾时保留输入字节，显式行尾与既有格式保持兼容。 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { fixture, cachedProfile } = require('./helper.cjs');
const { EDIT_BYTES } = require('../lib/text');
const S0 = '\uFEFF/* MCP_REAL_2_1_1 中文😀 */\r\n$color: #123456;\r\n.title { color: $color; }\r\n';
const S0_HASH = '537e68e3d17945b1b952f69f62bfc54fb10489dc4402e46d7ad016b14a534e86';

/** 从操作前定义的期望字节计算指纹，不拿写后目标自证。 */
function expectedHash(value) { return createHash('sha256').update(Buffer.from(value)).digest('hex'); }
/** 断言协议成功、完整文件字节和独立期望指纹。 */
async function verifyWrite(f, file, args, expected) {
  const response = await f.call('write_file', { path: file, ...args });
  assert.equal(response.structuredContent.ok, true, JSON.stringify(response));
  assert.equal(response.structuredContent.data.hash, expectedHash(expected));
  assert.ok((await fs.readFile(file)).equals(Buffer.from(expected)), '文件字节不符: ' + path.basename(file));
  return response.structuredContent.data;
}

test('EOL1 真机C06输入保持81字节BOM+CRLF，未知后缀与点文件同样适用', async t => {
  const f = await fixture(t);
  assert.equal(Buffer.byteLength(S0), 81);
  assert.equal(expectedHash(S0), S0_HASH);
  for (const name of ['new.scss', 'new.java', 'new.custom-212', 'NOEXT', '.settings']) {
    const data = await verifyWrite(f, path.join(f.root, name), { content: S0, overwrite: false, writePolicy: 'auto' }, S0);
    assert.equal(data.size, 81);
    assert.equal(data.strategy.basis, 'new_file');
    assert.equal(data.diskState, 'plaintext');
    assert.equal(data.diskVerified, true);
  }
});

test('EOL2 新文件auto/省略参数保留LF、CRLF、CR、混合与无行尾输入', async t => {
  const f = await fixture(t);
  const contents = ['单行😀', '甲\n乙\n', '甲\r\n乙\r\n', '甲\r乙\r', '甲\r\n乙\n丙\r'];
  let index = 0;
  for (const body of contents) for (const bom of ['', '\uFEFF']) for (const mode of ['overwrite', 'append']) for (const eol of [undefined, 'auto']) {
    const content = bom + body;
    await verifyWrite(f, path.join(f.root, 'new-' + index++ + '.txt'), { content, mode, ...(eol ? { eol } : {}) }, content);
  }
  assert.equal(index, 40);
});

test('EOL3 新文件显式lf/crlf仍规范化混合行尾，BOM与字符不变', async t => {
  const f = await fixture(t);
  for (const mode of ['overwrite', 'append']) for (const eol of ['lf', 'crlf']) {
    const content = '\uFEFF甲\r\n乙\n😀\r';
    const expected = eol === 'lf' ? '\uFEFF甲\n乙\n😀\n' : '\uFEFF甲\r\n乙\r\n😀\r\n';
    await verifyWrite(f, path.join(f.root, mode + '-' + eol + '.txt'), { content, mode, eol }, expected);
  }
});

test('EOL4 已有文件auto继续跟随原LF/CRLF/CR，覆盖和追加不改变既有规则', async t => {
  const f = await fixture(t);
  let index = 0;
  for (const ending of ['\n', '\r\n', '\r']) for (const bom of ['', '\uFEFF']) for (const mode of ['overwrite', 'append']) {
    const old = bom + 'OLD' + ending;
    const file = await f.sample('old-' + index++ + '.txt', old);
    const expected = bom + (mode === 'append' ? 'OLD' + ending : '') + ['A', 'B', 'C', ''].join(ending);
    await verifyWrite(f, file, { content: 'A\r\nB\nC\r', mode, eol: 'auto', expectedHash: expectedHash(old) }, expected);
  }
});

test('EOL5 已有空文件、BOM空文件与单行文件没有可继承行尾时保留输入', async t => {
  const f = await fixture(t);
  let index = 0;
  for (const old of ['', 'OLD', '\uFEFF', '\uFEFFOLD']) for (const mode of ['overwrite', 'append']) {
    const file = await f.sample('empty-' + index++ + '.txt', old);
    const addition = '新\r\n行\r\n';
    const expected = (mode === 'append' ? old : old.startsWith('\uFEFF') ? '\uFEFF' : '') + addition;
    await verifyWrite(f, file, { content: addition, mode, eol: 'auto' }, expected);
  }
});

test('EOL6 显式行尾只转换本次载荷，追加不重写原内容也不重复BOM', async t => {
  const f = await fixture(t);
  const file = await f.sample('append.txt', '\uFEFFOLD\r\n');
  await verifyWrite(f, file, { content: '\uFEFFNEW\r\nTAIL\r', mode: 'append', eol: 'lf' }, '\uFEFFOLD\r\nNEW\nTAIL\n');
  await verifyWrite(f, file, { content: 'NEXT\n', eol: 'crlf' }, '\uFEFFNEXT\r\n');
});

test('EOL7 保留CRLF后的16MB字节预算仍精确，超限不创建目标', async t => {
  const f = await fixture(t);
  const exact = 'a'.repeat(EDIT_BYTES - 2) + '\r\n';
  await verifyWrite(f, path.join(f.root, 'exact.txt'), { content: exact }, exact);
  const tooLarge = 'a'.repeat(EDIT_BYTES - 3) + '中\r\n';
  const file = path.join(f.root, 'too-large.txt');
  const response = await f.call('write_file', { path: file, content: tooLarge });
  assert.equal(response.structuredContent.code, 'FILE_TOO_LARGE');
  assert.equal(response.structuredContent.changed, false);
  await assert.rejects(fs.access(file), { code: 'ENOENT' });
});

test('EOL8 真实stdio新文件保留S0且版本一致，显式crlf与旧文件auto兼容', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.encryption.cachePath, JSON.stringify(cachedProfile()));
  const client = new Client({ name: 'eol-regression', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve(__dirname, '../index.js')], cwd: f.root, stderr: 'pipe', env: { ...process.env, MCP_PROFILE_DIR: f.stateDir, MCP_BASE_DIR: f.root, MCP_ALLOWED_ROOTS: JSON.stringify([f.root]) } });
  await client.connect(transport);
  f.cleanupTasks.push(() => client.close());
  assert.equal(client.getServerVersion().version, require('../package.json').version);
  const file = path.join(f.root, 'stdio.scss');
  // 协议夹具没有真实外部读取器；显式preserve隔离验证行尾，auto状态由策略测试覆盖。
  const written = await client.callTool({ name: 'write_file', arguments: { path: file, content: S0, overwrite: false, writePolicy: 'preserve' } });
  assert.equal(written.structuredContent.ok, true);
  assert.equal(written.structuredContent.data.hash, S0_HASH);
  assert.deepEqual(await fs.readFile(file), Buffer.from(S0));
  const append = await client.callTool({ name: 'write_file', arguments: { path: file, content: '/* APPEND_01 */\n', mode: 'append', eol: 'auto', writePolicy: 'preserve' } });
  assert.equal(append.structuredContent.ok, true);
  assert.deepEqual(await fs.readFile(file), Buffer.from(S0 + '/* APPEND_01 */\r\n'));
  const explicit = await client.callTool({ name: 'write_file', arguments: { path: path.join(f.root, 'explicit.txt'), content: 'a\nb\n', eol: 'crlf', writePolicy: 'preserve' } });
  assert.equal(explicit.structuredContent.ok, true);
  assert.deepEqual(await fs.readFile(path.join(f.root, 'explicit.txt')), Buffer.from('a\r\nb\r\n'));
});
