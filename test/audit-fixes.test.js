/** 2026-10审查修复：实际文件状态、复合故障、预算边界、取消隔离及真实协议。 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { fixture, cachedProfile } = require('./helper.cjs');
const { fault, EDIT_BYTES } = require('../lib/text');
const { externalCopy, atomicJson, createEncryption } = require('../lib/encryption');
const { globMatcher, globMatcherAsync, globToRegex } = require('../lib/patterns');
const { runRegex, runLiteral, stop } = require('../lib/regex');
after(() => stop());

/** 断言完整的成功协议状态。 */
function success(response) {
  assert.equal(response.structuredContent.ok, true, JSON.stringify(response));
  return response.structuredContent.data;
}
/** 断言失败码及内外changed一致后返回诊断。 */
function failure(response, code) {
  assert.equal(response.structuredContent.ok, false, JSON.stringify(response));
  assert.equal(response.structuredContent.code, code);
  assert.equal(response.structuredContent.changed, !!response.structuredContent.data.changed);
  return response.structuredContent.data;
}
/** 注入范围受控的fs故障，操作后立即恢复，保证夹具可清理。 */
async function withFs(overrides, action) {
  const originals = Object.fromEntries(Object.keys(overrides).map(key => [key, fs[key]]));
  Object.assign(fs, overrides);
  try { return await action(); } finally { Object.assign(fs, originals); }
}
/** 判断独立夹具中的内部辅助文件，不影响配置和其他测试。 */
function auxiliary(root, file, prefix) { return String(file).startsWith(root + path.sep) && path.basename(file).startsWith(prefix); }

test('A1 策略失败保留新父目录并准确报告changed和路径', async t => {
  const f = await fixture(t);
  const file = path.join(f.root, 'new', 'nested', 'file.txt');
  f.encryption.strategy = async () => { throw fault('DISK_UNVERIFIED', '模拟策略检查失败'); };
  const data = failure(await f.call('write_file', { path: file, content: 'NEW' }), 'DISK_UNVERIFIED');
  assert.equal(data.changed, true);
  assert.deepEqual(data.createdDirectories, [path.join(f.root, 'new'), path.dirname(file)]);
  for (const dir of data.createdDirectories) assert.ok((await fs.stat(dir)).isDirectory());
  await assert.rejects(fs.access(file), { code: 'ENOENT' });
});

test('A1 暂存失败不误删新目录中的并发内容，已有父目录不报changed', async t => {
  const f = await fixture(t);
  const file = path.join(f.root, 'new', 'file.txt');
  const sibling = path.join(path.dirname(file), 'sibling.txt');
  f.encryption.prepare = async () => { await fs.writeFile(sibling, 'OTHER'); throw fault('ENOSPC', '模拟磁盘满'); };
  const data = failure(await f.call('write_file', { path: file, content: 'NEW', writePolicy: 'preserve' }), 'ENOSPC');
  assert.equal(data.changed, true);
  assert.equal(await fs.readFile(sibling, 'utf8'), 'OTHER');
  const again = failure(await f.call('write_file', { path: file, content: 'NEW', writePolicy: 'preserve' }), 'ENOSPC');
  assert.equal(again.changed, false);
  assert.equal(again.createdDirectories, undefined);
});

test('A1 多层mkdir部分失败也报告已创建的祖先，复制文件同样适用', async t => {
  const f = await fixture(t);
  const source = await f.sample('source.txt', 'SOURCE');
  const destination = path.join(f.root, 'made', 'blocked', 'target.txt');
  const mkdir = fs.mkdir;
  const response = await withFs({ mkdir: async (dir, options) => {
    if (dir === path.dirname(destination)) throw fault('EACCES', '模拟子目录创建失败');
    return mkdir(dir, options);
  } }, () => f.call('copy_path', { source, destination, writePolicy: 'preserve' }));
  const data = failure(response, 'EACCES');
  assert.equal(data.changed, true);
  assert.deepEqual(data.createdDirectories, [path.join(f.root, 'made')]);
  assert.equal(await fs.readFile(source, 'utf8'), 'SOURCE');
});

test('A2 外部复制辅助文件写入与清理同时失败，保留主错误与残留路径', async t => {
  const f = await fixture(t);
  const writeFile = fs.writeFile, rm = fs.rm;
  await withFs({
    writeFile: async (file, value, options) => {
      if (auxiliary(f.root, file, '.mcp-copy-')) { await writeFile(file, 'PARTIAL', options); throw fault('ENOSPC', '主错误'); }
      return writeFile(file, value, options);
    },
    rm: async (file, options) => { if (auxiliary(f.root, file, '.mcp-copy-')) throw fault('EACCES', '清理错误'); return rm(file, options); },
  }, async () => {
    await assert.rejects(externalCopy('cscript', path.join(f.root, 'source'), path.join(f.root, 'destination')), error => {
      assert.equal(error.code, 'ENOSPC');
      assert.equal(error.cleanupErrors.length, 1);
      assert.equal(error.cleanupErrors[0].code, 'EACCES');
      return true;
    });
  });
  assert.ok((await fs.readdir(f.root)).some(name => name.startsWith('.mcp-copy-')));
});

test('A2 原子配置保存失败不覆盖旧值，清理失败不掩盖rename主错误', async t => {
  const f = await fixture(t);
  const file = await f.sample('config.json', '{"old":true}');
  const rename = fs.rename, rm = fs.rm;
  await withFs({
    rename: async (from, to) => { if (to === file) throw fault('EPERM', '配置提交失败'); return rename(from, to); },
    rm: async (target, options) => { if (String(target).startsWith(file + '.')) throw fault('EBUSY', '配置暂存占用'); return rm(target, options); },
  }, () => assert.rejects(atomicJson(file, { new: true }), error => {
    assert.equal(error.code, 'EPERM');
    assert.equal(error.cleanupErrors[0].code, 'EBUSY');
    return true;
  }));
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { old: true });
});

test('A2 已保存的手工策略遇到清理告警仍成功，changed与实际策略一致', async t => {
  const f = await fixture(t);
  await f.encryption.mark('.txt', 'clear');
  const rm = fs.rm;
  const response = await withFs({ rm: async (file, options) => {
    if (String(file).startsWith(f.encryption.policyDir + path.sep) && file.endsWith('.tmp')) throw fault('EACCES', '配置清理失败');
    return rm(file, options);
  } }, () => f.call('mark_extension', { extension: '.txt', category: 'protected' }));
  const data = success(response);
  assert.equal(data.changed, true);
  assert.equal(data.cleanupErrors.length, 1);
  assert.ok(response.structuredContent.warnings.length);
  assert.equal(await f.encryption.getOverride('.txt'), 'protected');
});

test('A2 新文件探测的主错误及清理诊断传递到MCP响应', async t => {
  const f = await fixture(t);
  const writeFile = fs.writeFile, rm = fs.rm;
  const response = await withFs({
    writeFile: async (file, value, options) => {
      if (auxiliary(f.root, file, '.mcp-probe-')) { await writeFile(file, 'PART', options); throw fault('ENOSPC', '探测写满'); }
      return writeFile(file, value, options);
    },
    rm: async (file, options) => { if (auxiliary(f.root, file, '.mcp-probe-')) throw fault('EBUSY', '探测样本占用'); return rm(file, options); },
  }, () => f.call('inspect_write_strategy', { path: path.join(f.root, 'new.txt') }));
  const data = failure(response, 'ENOSPC');
  assert.equal(data.cleanupErrors.length, 1);
  assert.equal(data.cleanupErrors[0].code, 'EBUSY');
});

test('A2 初始环境探测源写入和目录清理同时失败保留两个原因', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t);
  const encryption = createEncryption({ stateDir: f.stateDir, probeDir: f.root });
  const writeFile = fs.writeFile, rm = fs.rm;
  await withFs({
    writeFile: async (file, value, options) => { if (path.basename(file) === 'source.tmp') throw fault('ENOSPC', '探测源写满'); return writeFile(file, value, options); },
    rm: async (file, options) => { if (auxiliary(f.root, file, 'mcp-enc-probe-')) throw fault('EBUSY', '探测目录占用'); return rm(file, options); },
  }, () => assert.rejects(encryption.refresh(), error => {
    assert.equal(error.code, 'ENOSPC');
    assert.equal(error.cleanupErrors[0].code, 'EBUSY');
    return true;
  }));
});

test('A2 安全中转成功但清理失败，不回滚或重复提交已完成内容', async t => {
  const f = await fixture(t);
  const file = await f.sample('target.txt', 'OLD');
  const rm = fs.rm;
  const response = await withFs({ rm: async (target, options) => {
    if (auxiliary(f.root, target, '.mcp-safe-')) throw fault('EACCES', '中转样本清理失败');
    return rm(target, options);
  } }, () => f.call('write_file', { path: file, content: 'NEW', writePolicy: 'plaintext' }));
  const data = success(response);
  assert.equal(data.changed, true);
  assert.equal(data.cleanupErrors.length, 1);
  assert.equal(await fs.readFile(file, 'utf8'), 'NEW');
  assert.ok(response.structuredContent.warnings.length);
});

test('A2 安全中转写满且清理失败保留原文件与主错误', async t => {
  const f = await fixture(t);
  const file = await f.sample('target.txt', 'OLD');
  const writeFile = fs.writeFile, rm = fs.rm;
  const response = await withFs({
    writeFile: async (target, value, options) => {
      if (auxiliary(f.root, target, '.mcp-safe-')) { await writeFile(target, 'PART', options); throw fault('ENOSPC', '中转写满'); }
      return writeFile(target, value, options);
    },
    rm: async (target, options) => { if (auxiliary(f.root, target, '.mcp-safe-')) throw fault('EBUSY', '中转占用'); return rm(target, options); },
  }, () => f.call('write_file', { path: file, content: 'NEW', writePolicy: 'plaintext' }));
  const data = failure(response, 'ENOSPC');
  assert.equal(data.changed, false);
  assert.equal(data.cleanupErrors.length, 1);
  assert.equal(await fs.readFile(file, 'utf8'), 'OLD');
});

test('A3 正则扩大结果在worker内拒绝；工具失败不写盘且后续请求正常', async t => {
  const task = { operation: 'edit', text: 'a'.repeat(1000), pattern: 'a', replacement: 'b'.repeat(20000), replaceAll: true };
  await assert.rejects(runRegex(task), { code: 'FILE_TOO_LARGE' });
  const f = await fixture(t);
  const file = await f.sample('expand.txt', task.text);
  failure(await f.call('edit_file', { path: file, oldString: task.pattern, newString: task.replacement, useRegex: true, replaceAll: true }), 'FILE_TOO_LARGE');
  assert.equal(await fs.readFile(file, 'utf8'), task.text);
  assert.equal((await runRegex({ ...task, text: 'a', replacement: 'ok' })).updated, 'ok');
});

test('A3 替换语义对照原生replace：捕获组、前后文、美元、零宽与Unicode', async () => {
  const texts = ['ab ab\nac', '😀ab', 'aaa', ''];
  const patterns = ['(a)(b)?', '(?<word>a)(b)?', '^|$', '(?=a)', 'a', '(.)', 'z'];
  const replacements = ['$$:$&:$`:$\'', '$1/$2/$3/$01/$00/$10/$12/$99/$100', '$<word>/$<missing>/$<a$&>', '中😀', '$', '$$1', ''];
  for (const text of texts) for (const pattern of patterns) for (const replacement of replacements) for (const replaceAll of [false, true]) {
    const regex = new RegExp(pattern, 'gm');
    const matches = [...text.matchAll(regex)];
    const expected = text.replace(new RegExp(pattern, replaceAll ? 'gm' : 'm'), replacement);
    const actual = await runRegex({ operation: 'edit', text, pattern, replacement, replaceAll });
    assert.equal(actual.updated, expected, JSON.stringify({ text, pattern, replacement, replaceAll }));
    assert.equal(actual.matched, matches.length);
    assert.equal(actual.replaced, replaceAll ? matches.length : Math.min(1, matches.length));
  }
});

test('A3 正则UTF8预算的精确边界和跨片段代理对', async () => {
  const text = 'x'.repeat(EDIT_BYTES - 4) + '😀';
  const result = await runRegex({ operation: 'edit', text, pattern: '\\ud83d', replacement: '\ud83d', replaceAll: true }, { timeoutMs: 3000 });
  assert.equal(result.updated, text);
  assert.equal(Buffer.byteLength(result.updated), EDIT_BYTES);
  await assert.rejects(runRegex({ operation: 'edit', text, pattern: '^', replacement: '中', replaceAll: false }, { timeoutMs: 3000 }), { code: 'FILE_TOO_LARGE' });
});

test('A3 前后文标记扩张也提前拒绝，多位捕获组保持原生语义', async () => {
  await assert.rejects(runRegex({ operation: 'edit', text: 'a'.repeat(1000) + 'z'.repeat(32768), pattern: 'a', replacement: "$'", replaceAll: true }), { code: 'FILE_TOO_LARGE' });
  const text = 'abcdefghijkl';
  const pattern = [...text].map(letter => '(' + letter + ')').join('');
  const replacement = '$01|$09|$10|$12|$13|$99|$100';
  const actual = await runRegex({ operation: 'edit', text, pattern, replacement });
  assert.equal(actual.updated, text.replace(new RegExp(pattern, 'm'), replacement));
});

test('A4 literal搜索4096个元字符正常匹配，正则模式仍保留校验', async t => {
  const f = await fixture(t);
  const pattern = '.*[]'.repeat(1024);
  const file = await f.sample('literal.txt', 'prefix' + pattern + 'suffix\n');
  const data = success(await f.call('search_files', { path: file, pattern, mode: 'literal', onlyMatching: true }));
  assert.equal(data.results.length, 1);
  assert.equal(data.results[0].text, pattern);
  failure(await f.call('search_files', { path: file, pattern: '[', mode: 'regex' }), 'INVALID_REGEX');
});

/** 提供只读虚拟目录树，复用真实路径检查、遍历与预算，禁止写入虚拟路径。 */
async function virtualTransfer(f, tool, layout) {
  const source = path.join(f.root, 'virtual-source');
  const destination = path.join(f.root, 'virtual-target');
  const isVirtual = file => [source, destination].some(root => file === root || String(file).startsWith(root + path.sep));
  const realpath = fs.realpath, lstat = fs.lstat, opendir = fs.opendir, mkdir = fs.mkdir, rmdir = fs.rmdir;
  const stats = { isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false };
  let visits = 0;
  const response = await withFs({
    realpath: async file => isVirtual(file) ? file : realpath(file),
    lstat: async file => isVirtual(file) ? stats : lstat(file),
    opendir: async file => {
      if (!isVirtual(file)) return opendir(file);
      visits++;
      const depth = path.relative(source, file).split(path.sep).filter(Boolean).length;
      const names = layout.startsWith('wide') ? (file === source ? Array.from({ length: layout === 'wide-ok' ? 9999 : 10000 }, (_, i) => 'd' + i) : []) : depth < (layout === 'deep-ok' ? 128 : 129) ? ['d'] : [];
      return { async *[Symbol.asyncIterator]() { for (const name of names) yield { name }; } };
    },
    mkdir: async (file, options) => { assert.ok(!isVirtual(file), '模型中所有目标目录已经存在'); return mkdir(file, options); },
    rmdir: async file => { assert.ok(!isVirtual(file), '超过遍历预算前不应删源'); return rmdir(file); },
  }, () => f.call(tool, { source, destination, timeoutMs: 60000 }));
  return { response, visits };
}

for (const tool of ['copy_path', 'move_path']) {
  test('A5 ' + tool + '一万项包含已有空目录，超限前不删源', async t => {
    const f = await fixture(t);
    const { response, visits } = await virtualTransfer(f, tool, 'wide');
    const data = failure(response, 'ITEM_LIMIT');
    assert.equal(data.changed, false);
    assert.equal(data.sourceRetained, true);
    assert.equal(visits, 10000);
  });
  test('A5 ' + tool + '在129层拒绝继续递归', async t => {
    const f = await fixture(t);
    const { response, visits } = await virtualTransfer(f, tool, 'deep');
    const data = failure(response, 'DEPTH_LIMIT');
    assert.equal(data.changed, false);
    assert.equal(visits, 129);
  });
}

test('A5 恰好一万项或128层的目录仍允许复制', async t => {
  const f = await fixture(t);
  for (const [layout, expectedVisits] of [['wide-ok', 10000], ['deep-ok', 129]]) {
    const { response, visits } = await virtualTransfer(f, 'copy_path', layout);
    assert.equal(success(response).changed, false);
    assert.equal(visits, expectedVisits);
  }
});

test('A5 实际目录合并与移动保持文件内容和空目录', async t => {
  const f = await fixture(t);
  const file = await f.sample('src/a.txt', 'A');
  await fs.mkdir(path.join(f.root, 'src', 'empty'));
  await fs.mkdir(path.join(f.root, 'dst', 'src', 'empty'), { recursive: true });
  success(await f.call('copy_path', { source: path.dirname(file), destination: path.join(f.root, 'dst'), writePolicy: 'preserve' }));
  assert.equal(await fs.readFile(path.join(f.root, 'dst', 'src', 'a.txt'), 'utf8'), 'A');
  success(await f.call('move_path', { source: path.dirname(file), destination: path.join(f.root, 'moved'), writePolicy: 'preserve' }));
  assert.ok((await fs.stat(path.join(f.root, 'moved', 'empty'))).isDirectory());
  await assert.rejects(fs.access(file), { code: 'ENOENT' });
});

test('A6 glob空分支、重复空分支及嵌套分支与兼容编译器一致', async () => {
  for (const pattern of ['{,src/}*.js', '{src/,}*.js', '{,src/{,lib/}}*.js', '{,,src/}*.js', '{}*.js']) {
    const asyncMatch = await globMatcherAsync(pattern);
    const syncMatch = globMatcher(pattern);
    for (const name of ['index.js', 'src/index.js', 'src/lib/index.js', 'lib/index.js', 'a.txt']) {
      const target = pattern.includes('/') ? name : name.split('/').at(-1);
      const expected = globToRegex(pattern).test(target);
      assert.equal(await asyncMatch(name), expected, pattern + ' ' + name);
      assert.equal(syncMatch(name), expected, pattern + ' ' + name);
    }
  }
});

test('A7 取消排队任务不连带取消正在运行或其他排队任务', async () => {
  const busy = new AbortController(), queued = new AbortController();
  let slowDone = false;
  const slow = runRegex({ operation: 'edit', pattern: '^(a+)+$', text: 'a'.repeat(40) + '!', replacement: 'x' }, { signal: busy.signal, timeoutMs: 5000 }).catch(error => { slowDone = true; return error; });
  const cancelled = runLiteral('a', { oldString: 'a', newString: 'b' }, false, { signal: queued.signal });
  const fast = runLiteral('a', { oldString: 'a', newString: 'ok' }, false, { timeoutMs: 3000 });
  queued.abort();
  await assert.rejects(cancelled, { code: 'CANCELLED' });
  assert.equal(slowDone, false);
  busy.abort();
  assert.equal((await slow).code, 'CANCELLED');
  assert.equal((await fast).updated, 'ok');
});

test('A7 排队超时不终止运行任务；运行超时后其他任务继续', async () => {
  let slowDone = false;
  const slow = runRegex({ operation: 'edit', pattern: '^(a+)+$', text: 'a'.repeat(40) + '!', replacement: 'x' }, { timeoutMs: 500 }).catch(error => { slowDone = true; return error; });
  const fast = runLiteral('a', { oldString: 'a', newString: 'ok' }, false, { timeoutMs: 3000 });
  await assert.rejects(runLiteral('a', { oldString: 'a', newString: 'b' }, false, { timeoutMs: 50 }), { code: 'TIMEOUT' });
  assert.equal(slowDone, false);
  assert.equal((await slow).code, 'REGEX_TIMEOUT');
  assert.equal((await fast).updated, 'ok');
});

test('A7 队列容量保持16，全局关闭取消所有任务后可重新使用', async () => {
  const tasks = [runRegex({ operation: 'edit', pattern: '^(a+)+$', text: 'a'.repeat(40) + '!', replacement: 'x' }, { timeoutMs: 5000 }).catch(error => error)];
  for (let i = 0; i < 15; i++) tasks.push(runLiteral('a', { oldString: 'a', newString: 'b' }, false, { timeoutMs: 5000 }).catch(error => error));
  await assert.rejects(runLiteral('a', { oldString: 'a', newString: 'b' }), { code: 'BUSY' });
  stop();
  assert.ok((await Promise.all(tasks)).every(error => error.code === 'CANCELLED'));
  assert.equal((await runLiteral('a', { oldString: 'a', newString: 'b' })).updated, 'b');
});

test('A8 安全中转失败reasons及两种编辑matched均在MCP错误中保留', async t => {
  const f = await fixture(t, { copier: async () => { throw fault('EACCES', '模拟复制失败'); } });
  const file = await f.sample('target.txt', 'aa');
  const failed = failure(await f.call('write_file', { path: file, content: 'NEW', writePolicy: 'plaintext' }), 'SAFE_WRITE_FAILED');
  assert.ok(failed.reasons.includes('EACCES'));
  for (const useRegex of [false, true]) {
    const data = failure(await f.call('edit_file', { path: file, oldString: 'a', newString: 'x', useRegex, expectedMatches: 3 }), 'MATCH_COUNT_MISMATCH');
    assert.equal(data.matched, 2);
  }
  assert.equal(await fs.readFile(file, 'utf8'), 'aa');
});

test('A8 真实stdio验证长literal、glob空分支、错误诊断与超限后的心跳', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.encryption.cachePath, JSON.stringify(cachedProfile()));
  const file = await f.sample('index.js', '.'.repeat(4096) + '\naa');
  const client = new Client({ name: 'audit-fixes', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve(__dirname, '../index.js')], cwd: f.root, stderr: 'pipe', env: { ...process.env, MCP_PROFILE_DIR: f.stateDir, MCP_BASE_DIR: f.root, MCP_ALLOWED_ROOTS: JSON.stringify([f.root]) } });
  await client.connect(transport);
  f.cleanupTasks.push(() => client.close());
  assert.equal((await client.listTools()).tools.length, 18);
  const matches = success(await client.callTool({ name: 'search_files', arguments: { path: file, mode: 'literal', pattern: '.'.repeat(4096) } }));
  assert.equal(matches.results.length, 1);
  const found = success(await client.callTool({ name: 'find_files', arguments: { path: f.root, pattern: '{,src/}*.js' } }));
  assert.ok(found.entries.some(entry => entry.file === file));
  const conflict = failure(await client.callTool({ name: 'edit_file', arguments: { path: file, oldString: 'a', newString: 'b', expectedMatches: 3 } }), 'MATCH_COUNT_MISMATCH');
  assert.equal(conflict.matched, 2);
  failure(await client.callTool({ name: 'edit_file', arguments: { path: file, oldString: '\\.', newString: 'b'.repeat(5000), useRegex: true, replaceAll: true } }), 'FILE_TOO_LARGE');
  const start = performance.now();
  success(await client.callTool({ name: 'check_status', arguments: {} }));
  assert.ok(performance.now() - start < 1000);
  assert.equal(await fs.readFile(file, 'utf8'), '.'.repeat(4096) + '\naa');
});
