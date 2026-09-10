/** 2026-09-09复核问题R1—R4的正确行为回归；样本及故障注入均隔离。 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture } = require('./helper.cjs');
const { fault } = require('../lib/text');

/** 验证工具失败状态，并返回结构化数据供文件状态断言使用。 */
function failed(response, code) {
  assert.equal(response.isError, true, JSON.stringify(response));
  if (code) assert.equal(response.structuredContent.code, code);
  return response.structuredContent.data;
}

for (const tool of ['copy_path', 'move_path']) {
  test('R1 ' + tool + '拒绝祖先/后代重叠，源与目标均不改变', async t => {
    const f = await fixture(t);
    const first = await f.sample('tree/tree/z.txt', 'ORIGINAL-UNIQUE');
    const nested = await f.sample('tree/tree/tree/z.txt', 'INNER');
    const source = path.dirname(first);
    const before = await fs.readdir(f.root);
    const response = await f.call(tool, { source, destination: f.root });
    assert.equal(failed(response, 'OVERLAPPING_PATHS').changed, false);
    assert.equal(await fs.readFile(first, 'utf8'), 'ORIGINAL-UNIQUE');
    assert.equal(await fs.readFile(nested, 'utf8'), 'INNER');
    await assert.rejects(fs.access(path.join(f.root, 'tree/z.txt')), { code: 'ENOENT' });
    assert.deepEqual(await fs.readdir(f.root), before);
    failed(await f.call(tool, { source, destination: path.join(source, 'new-child') }), 'RECURSIVE_TARGET');
    assert.equal((await f.call(tool, { source, destination: path.dirname(source) })).structuredContent.data.sameFile, true);
    assert.equal(await fs.readFile(first, 'utf8'), 'ORIGINAL-UNIQUE');
  });
}

for (const installFails of [false, true]) {
  test('R2 复制' + (installFails ? '安装前' : '安装后') + '回滚失败保留changed、partial和恢复备份', async t => {
    const f = await fixture(t);
    const source = await f.sample('source.txt', 'NEW');
    const destination = await f.sample('target.txt', 'ORIGINAL');
    const realRename = fs.rename;
    const realVerify = f.encryption.verify;
    /** 只对本案例最终目标注入验证失败。 */
    f.encryption.verify = async (file, ...args) => {
      if (file === destination) throw fault('DISK_MISMATCH', '模拟最终校验失败');
      return realVerify(file, ...args);
    };
    /** 模拟安装或回滚时文件被其他进程占用，不影响其他测试路径。 */
    fs.rename = async (from, to) => {
      if (path.dirname(from) === f.root && to === destination) {
        if (path.basename(from).startsWith('.mcp-backup-')) throw fault('EBUSY', '模拟回滚失败');
        if (installFails && path.basename(from).startsWith('.mcp-stage-')) throw fault('EACCES', '模拟安装失败');
      }
      return realRename(from, to);
    };
    let response;
    try { response = await f.call('copy_path', { source, destination }); }
    finally { fs.rename = realRename; }
    const data = failed(response, installFails ? 'EACCES' : 'DISK_MISMATCH');
    assert.equal(response.structuredContent.changed, true);
    assert.equal(data.changed, true);
    assert.deepEqual(data.partial, [destination]);
    assert.equal(data.sourceRetained, true);
    assert.ok(data.recoveryPath);
    assert.equal(await fs.readFile(data.recoveryPath, 'utf8'), 'ORIGINAL');
    assert.equal(await fs.readFile(source, 'utf8'), 'NEW');
    if (installFails) await assert.rejects(fs.access(destination), { code: 'ENOENT' });
    else assert.equal(await fs.readFile(destination, 'utf8'), 'NEW');
  });
}

test('R2 目标原已相同但删源部分完成，失败也必须changed=true', async t => {
  const f = await fixture(t);
  const a = await f.sample('src/a.txt', 'A');
  const b = await f.sample('src/b.txt', 'B');
  await f.sample('dest/src/a.txt', 'A');
  await f.sample('dest/src/b.txt', 'B');
  const realUnlink = fs.unlink;
  let deleted = null;
  let retained = null;
  /** 仅让第二个源文件删除失败，已存在相同目标无需被改写。 */
  fs.unlink = async file => {
    if (file === a || file === b) {
      if (deleted) { retained = file; throw fault('EBUSY', '模拟第二个源文件占用'); }
      await realUnlink(file);
      deleted = file;
      return;
    }
    return realUnlink(file);
  };
  let response;
  try { response = await f.call('move_path', { source: path.dirname(a), destination: path.join(f.root, 'dest') }); }
  finally { fs.unlink = realUnlink; }
  const data = failed(response, 'EBUSY');
  assert.equal(data.changed, true);
  assert.equal(data.sourceRetained, false);
  await assert.rejects(fs.access(deleted), { code: 'ENOENT' });
  await fs.access(retained);
  assert.equal(await fs.readFile(path.join(f.root, 'dest/src/a.txt'), 'utf8'), 'A');
  assert.equal(await fs.readFile(path.join(f.root, 'dest/src/b.txt'), 'utf8'), 'B');
});

test('R3 首行无法放入页时明确拒绝，不返回无法前进的成功空页', async t => {
  const f = await fixture(t);
  for (const size of [399985, 399990, 400000]) {
    const file = await f.sample('line.txt', 'X'.repeat(size) + '\n');
    failed(await f.call('read_file_partial', { path: file, mode: 'lines', startLine: 1, endLine: 1 }), 'LINE_TOO_LONG');
  }
  const fitting = await f.sample('fitting.txt', 'X'.repeat(399984) + '\n');
  const response = await f.call('read_file_partial', { path: fitting, mode: 'lines', startLine: 1, endLine: 1 });
  assert.ok(!response.isError);
  assert.equal(response.structuredContent.data.lines[0].text.length, 399984);
  assert.equal(response.structuredContent.data.nextLine, 2);
});

test('R3 多行触及预算后游标前进，下一页可正确读取', async t => {
  const f = await fixture(t);
  const file = await f.sample('pages.txt', 'A'.repeat(200000) + '\n' + 'B'.repeat(200000) + '\n');
  const first = (await f.call('read_file_partial', { path: file, mode: 'lines', startLine: 1, endLine: 2 })).structuredContent;
  assert.ok(first.ok);
  assert.equal(first.data.lines.length, 1);
  assert.equal(first.data.nextLine, 2);
  const second = (await f.call('read_file_partial', { path: file, mode: 'lines', startLine: first.data.nextLine, endLine: 2 })).structuredContent;
  assert.ok(second.ok);
  assert.equal(second.data.lines[0].text, 'B'.repeat(200000));
  assert.ok(second.data.nextLine > first.data.nextLine);
});

test('R4 请求第一行不因范围外超长行失败，兼容LF/CRLF/CR', async t => {
  const f = await fixture(t);
  for (const eol of ['\n', '\r\n', '\r']) {
    const file = await f.sample('long-following.txt', 'FIRST' + eol + 'X'.repeat(400002) + eol);
    const response = await f.call('read_file_partial', { path: file, mode: 'lines', startLine: 1, endLine: 1 });
    assert.ok(!response.isError, JSON.stringify(response));
    assert.deepEqual(response.structuredContent.data.lines, [{ line: 1, text: 'FIRST' }]);
    assert.equal(response.structuredContent.data.nextLine, 2);
    assert.equal(response.structuredContent.data.totalLines, null);
  }
});

test('R4 未提前停止时EOF计数准确，候选续读越界有明确错误', async t => {
  const f = await fixture(t);
  for (const content of ['', 'FIRST', 'FIRST\n']) {
    const file = await f.sample('eof.txt', content);
    const page = (await f.call('read_file_partial', { path: file, mode: 'lines', startLine: 1, endLine: 10 })).structuredContent;
    assert.ok(page.ok);
    assert.equal(page.data.totalLines, 1);
    assert.equal(page.data.nextLine, null);
    failed(await f.call('read_file_partial', { path: file, mode: 'lines', startLine: 2, endLine: 2 }), 'LINE_OUT_OF_RANGE');
  }
});
