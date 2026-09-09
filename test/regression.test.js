/** 原审查B01—B26的正确行为断言，以及新增功能与异常提交验收。 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { fixture, cachedProfile } = require('./helper.cjs');
const { createEncryption } = require('../lib/encryption');
const { createServer } = require('../lib/server');
const { readText, fingerprint, payloadFingerprint, fault } = require('../lib/text');
const { globToRegex, globMatcher, applyLiteral } = require('../lib/patterns');
const { runRegex, stop } = require('../lib/regex');
after(() => stop());

/** 从工具成功结果中提取数据；错误文字一并显示便于定位。 */
function success(response) {
  assert.equal(!!response.isError, false, response.content[0].text);
  assert.equal(response.structuredContent.ok, true);
  return response.structuredContent.data;
}
/** 断言业务错误可被协议识别，不靠成功文本后的警告。 */
function failure(response, code) {
  assert.equal(response.isError, true, response.content[0].text);
  assert.equal(response.structuredContent.ok, false);
  if (code) assert.equal(response.structuredContent.code, code, response.content[0].text);
  return response.structuredContent.data;
}

test('B01 UTF8跨4KB/64KB及BOM边界，编辑其他位置不改变原字节', async t => {
  const f = await fixture(t);
  for (const length of [4095, 4096, 65535, 65534]) {
    for (const character of ['中', '😀']) {
      const content = '\uFEFF' + 'a'.repeat(length) + character + '\r\nold\r\n';
      const file = await f.sample('boundary.txt', content);
      success(await f.call('edit_file', { path: file, oldString: 'old', newString: 'new' }));
      assert.equal(await fs.readFile(file, 'utf8'), content.replace('old', 'new'));
    }
  }
});

test('B02 搜索8KB边界中文不漏报', async t => {
  const f = await fixture(t);
  const file = await f.sample('search.txt', 'a'.repeat(8191) + '中needle');
  const data = success(await f.call('search_files', { path: file, pattern: '中needle', onlyMatching: true }));
  assert.equal(data.results[0].text, '中needle');
});

test('B03 短GBK、低比例非法UTF8被拒绝，合法替换字符不误报', async t => {
  const f = await fixture(t);
  for (const prefix of ['old', 'a'.repeat(20000) + 'old']) {
    const bytes = Buffer.concat([Buffer.from(prefix), Buffer.from([0xd6, 0xd0, 0xce, 0xc4])]);
    const file = await f.sample('invalid.txt', bytes);
    failure(await f.call('edit_file', { path: file, oldString: 'old', newString: 'new' }), 'INVALID_UTF8');
    assert.deepEqual(await fs.readFile(file), bytes);
  }
  const file = await f.sample('valid.txt', '\uFFFD'.repeat(200) + 'old');
  success(await f.call('edit_file', { path: file, oldString: 'old', newString: 'new' }));
  assert.equal(await fs.readFile(file, 'utf8'), '\uFFFD'.repeat(200) + 'new');
});

test('B04 append进入自动纠正时保留原文、BOM和CRLF', async t => {
  const f = await fixture(t, {
    /** 仅模拟直接暂存文件被加密，外部复制完成后返回明文视图。 */
    reader: async ({ file, copied, context }) => {
      const actual = await fingerprint(file, context);
      if (path.basename(file).startsWith('.mcp-stage-') && !copied.has(file)) return { hash: 'f'.repeat(64), size: actual.size + 128, prefix: '25545344' };
      return actual;
    },
  });
  const file = await f.sample('append.foo', '\uFEFFORIGINAL\r\n');
  success(await f.call('write_file', { path: file, content: 'APPEND\n', mode: 'append' }));
  assert.equal(await fs.readFile(file, 'utf8'), '\uFEFFORIGINAL\r\nAPPEND\r\n');
  assert.ok(f.copied.size > 0);
});

test('B05 safeWrite不得覆盖或删除同名现有备份', async t => {
  const f = await fixture(t);
  const file = await f.sample('note.scss', 'old');
  const backup = await f.sample('note.scss.tmp', 'USER BACKUP');
  success(await f.call('mark_extension', { extension: '.scss', category: 'unsafe' }));
  success(await f.call('write_file', { path: file, content: 'new' }));
  assert.equal(await fs.readFile(backup, 'utf8'), 'USER BACKUP');
});

test('B06 源名等于旧临时名的复制不删源', async t => {
  const f = await fixture(t);
  const source = await f.sample('code.scss.tmp', 'SOURCE');
  success(await f.call('mark_extension', { extension: '.scss', category: 'unsafe' }));
  const destination = path.join(f.root, 'code.scss');
  success(await f.call('copy_path', { source, destination }));
  assert.equal(await fs.readFile(source, 'utf8'), 'SOURCE');
  assert.equal(await fs.readFile(destination, 'utf8'), 'SOURCE');
});

test('B07 同路径及移动到当前父目录不删除文件', async t => {
  const f = await fixture(t);
  const file = await f.sample('same.scss', 'SOURCE');
  success(await f.call('mark_extension', { extension: '.scss', category: 'unsafe' }));
  for (const destination of [file, f.root]) {
    assert.equal(success(await f.call('move_path', { source: file, destination })).changed, false);
    assert.equal(await fs.readFile(file, 'utf8'), 'SOURCE');
  }
});

test('B08 unsafe和protected均可clear，独立实例立即可见', async t => {
  const f = await fixture(t);
  const other = createEncryption(f.opts);
  for (const category of ['unsafe', 'protected']) {
    success(await f.call('mark_extension', { extension: 'JAVA', category }));
    assert.equal(await other.getOverride('.java'), category);
    success(await f.call('mark_extension', { extension: '.java', category: 'clear' }));
    assert.equal(await other.getOverride('.java'), null);
  }
});

test('B09 刷新、TTL到期和重启保留手工策略', async t => {
  const f = await fixture(t);
  await f.encryption.mark('.java', 'protected');
  await f.encryption.mark('.scss', 'unsafe');
  await f.encryption.refresh();
  const p = { ...(await f.encryption.getProfile()), detectedAt: '2000-01-01T00:00:00Z' };
  await fs.writeFile(f.encryption.cachePath, JSON.stringify(p));
  const restarted = createEncryption(f.opts);
  await restarted.getProfile();
  assert.equal(await restarted.getOverride('.java'), 'protected');
  assert.equal(await restarted.getOverride('.scss'), 'unsafe');
});

test('B09 过期v2的protected标注只迁移一次，clear不被旧缓存复活', async t => {
  const f = await fixture(t);
  const p = { ...cachedProfile(), version: 2, detectedAt: '2000-01-01', userProtectedExtensions: ['.java'] };
  await fs.writeFile(f.encryption.cachePath, JSON.stringify(p));
  assert.equal(await f.encryption.getOverride('.java'), 'protected');
  await f.encryption.mark('.java', 'clear');
  assert.equal(await createEncryption(f.opts).getOverride('.java'), null);
});

test('B10/B11/B12 include递归扩展名、花括号和单文件过滤', async t => {
  const f = await fixture(t);
  await f.sample('src/a.java', 'NEEDLE');
  const ts = await f.sample('a.ts', 'NEEDLE');
  await f.sample('b.tsx', 'NEEDLE');
  assert.equal(success(await f.call('search_files', { path: f.root, pattern: 'NEEDLE', include: '*.java' })).results.length, 1);
  assert.equal(success(await f.call('search_files', { path: f.root, pattern: 'NEEDLE', include: '**/*.{ts,tsx}' })).results.length, 2);
  assert.equal(success(await f.call('search_files', { path: ts, pattern: 'NEEDLE', include: '*.ts' })).results.length, 1);
  assert.equal(success(await f.call('search_files', { path: f.root, pattern: 'NEEDLE', include: ['**/*.ts', '**/*.tsx'] })).results.length, 2);
});

test('B13/B14 glob字面括号与完整目录段语义', () => {
  assert.ok(globToRegex('app/(auth)/page.tsx').test('app/(auth)/page.tsx'));
  assert.ok(!globToRegex('app/(auth)/page.tsx').test('app/auth/page.tsx'));
  assert.ok(globToRegex('**/foo.js').test('foo.js'));
  assert.ok(globToRegex('**/foo.js').test('x/y/foo.js'));
  assert.ok(!globToRegex('**/foo.js').test('notfoo.js'));
  assert.ok(globToRegex('src/**/*.{ts,tsx}').test('src/a.tsx'));
  assert.ok(globToRegex('{src,{lib,test}}/*.js').test('test/a.js'));
  assert.ok(globMatcher(['{**/*.js,**/*.ts}'])('a.js'));
  assert.ok(globMatcher(['{**/*.js,**/*.ts}'])('src/a.ts'));
  assert.ok(!globMatcher(['**/foo.js'])('notfoo.js'));
  assert.ok(!globMatcher(['*a'.repeat(30) + 'b'])('a'.repeat(100)));
});

test('B15 空目录非递归删除成功，非空目录失败不丢内容', async t => {
  const f = await fixture(t);
  const empty = path.join(f.root, 'empty');
  await fs.mkdir(empty);
  success(await f.call('remove_path', { path: empty, recursive: false }));
  await assert.rejects(fs.access(empty));
  const file = await f.sample('nonempty/keep.txt', 'keep');
  failure(await f.call('remove_path', { path: path.dirname(file), recursive: false }));
  assert.equal(await fs.readFile(file, 'utf8'), 'keep');
});

test('B16 密文/非法字节不得报告解密正常；可信hash可明确验证', async t => {
  const f = await fixture(t);
  const cipher = await f.sample('cipher.java', '%TSD-Header-###%ABC');
  failure(await f.call('check_status', { path: cipher }), 'CIPHERTEXT_DETECTED');
  const plain = await f.sample('plain.txt', 'plaintext');
  assert.equal(success(await f.call('check_status', { path: plain })).decryptionVerified, false);
  assert.equal(success(await f.call('check_status', { path: plain, expectedHash: (await fingerprint(plain)).hash })).decryptionVerified, true);
});

test('B17/B18 损坏复制不能自比较通过，编辑safe失败必须报错并保留原文', async t => {
  const f = await fixture(t, {
    /** 模拟外部复制返回成功但实际写坏内容。 */
    copier: async ({ destination }) => fs.writeFile(destination, 'CORRUPTED'),
  });
  const file = await f.sample('x.scss', 'old');
  await f.encryption.mark('.scss', 'unsafe');
  const response = await f.call('edit_file', { path: file, oldString: 'old', newString: 'new' });
  failure(response, 'SAFE_WRITE_FAILED');
  assert.equal(await fs.readFile(file, 'utf8'), 'old');
  assert.equal(response.structuredContent.changed, false);
});

test('B19 小文件与分块路径均不切断代理对，分页拼接无损', async t => {
  const f = await fixture(t);
  for (const content of ['a😀z', '😀', 'a'.repeat(65535) + '😀z']) {
    const file = await f.sample('unicode.txt', content);
    let offset = 0;
    let restored = '';
    do {
      const data = await readText(file, { limit: content.length > 100 ? 65536 : 2, offset });
      assert.ok(!/[\uD800-\uDBFF]$/.test(data.content));
      restored += data.content;
      offset = data.nextOffset;
    } while (offset !== null);
    assert.equal(restored, content);
  }
});

test('B20 大文件截断元数据有效，没有undefined字节提示', async t => {
  const f = await fixture(t);
  const file = await f.sample('large.txt', 'a'.repeat(500000));
  const response = await f.call('read_file', { path: file });
  const data = success(response);
  assert.equal(data.nextOffset, 400000);
  assert.equal(data.size, 400000);
  assert.ok(!response.content[0].text.includes('undefined'));
});

test('B21 Unicode忽略大小写替换使用原始索引，批量也生效', async t => {
  assert.equal(applyLiteral('İABC', { oldString: 'ABC', newString: 'X' }, true).updated, 'İX');
  const f = await fixture(t);
  const file = await f.sample('case.txt', 'İABC\r\nDeF');
  const data = success(await f.call('edit_file', { path: file, edits: [{ oldString: 'abc\ndef', newString: 'X' }], ignoreCase: true }));
  assert.equal(data.replaced, 1);
  assert.equal(await fs.readFile(file, 'utf8'), 'İX');
});

test('B22 UTF16追加被拒绝且原始字节不变', async t => {
  const f = await fixture(t);
  const bytes = Buffer.concat([Buffer.from([255, 254]), Buffer.from('old', 'utf16le')]);
  const file = await f.sample('utf16.txt', bytes);
  failure(await f.call('write_file', { path: file, content: 'new', mode: 'append' }), 'UNSUPPORTED_ENCODING');
  assert.deepEqual(await fs.readFile(file), bytes);
});

test('B23 非TSD磁盘不一致不作为明文成功，所有候选失败保留原文', async t => {
  const f = await fixture(t, {
    /** 非TSD磁盘内容与预期不一致。 */
    reader: async ({ file, context }) => ({ ...(await fingerprint(file, context)), hash: 'f'.repeat(64), prefix: 'aabbccdd' }),
  });
  const file = await f.sample('x.foo', 'old');
  await assert.rejects(f.encryption.verify(file, payloadFingerprint('old'), 'auto'), { code: 'DISK_MISMATCH' });
  failure(await f.call('write_file', { path: file, content: 'new', writePolicy: 'plaintext' }));
  assert.equal(await fs.readFile(file, 'utf8'), 'old');
});

test('B24 读取器失效不得认证明文，强制明文失败保留目标与源', async t => {
  const f = await fixture(t, { reader: async () => null });
  const file = await f.sample('x.scss', 'old');
  await assert.rejects(f.encryption.verify(file, payloadFingerprint('old'), 'plaintext'), { code: 'DISK_UNVERIFIED' });
  failure(await f.call('write_file', { path: file, content: 'new', writePolicy: 'plaintext' }));
  const source = await f.sample('source.txt', 'SOURCE');
  failure(await f.call('move_path', { source, destination: file, writePolicy: 'plaintext' }));
  assert.equal(await fs.readFile(file, 'utf8'), 'old');
  assert.equal(await fs.readFile(source, 'utf8'), 'SOURCE');
});

test('B25 无效日期、未来日期、不完整字段和非法进程缓存均拒绝', async t => {
  const f = await fixture(t);
  for (const change of [{ detectedAt: 'not-a-date' }, { detectedAt: '2999-01-01' }, { unsafeExtensions: null }, { byteReader: 'evil' }, { availableProcesses: [{ id: 'evil' }] }]) {
    await fs.writeFile(f.encryption.cachePath, JSON.stringify({ ...cachedProfile(), ...change }));
    assert.equal(await f.encryption.loadCache(), null);
  }
});

test('B26 灾难性正则超时后可继续搜索与编辑，主线程计时器正常', async t => {
  const f = await fixture(t);
  const file = await f.sample('redos.txt', 'a'.repeat(32) + '!');
  let ticked = false;
  const timer = setTimeout(() => { ticked = true; }, 20);
  failure(await f.call('search_files', { path: file, pattern: '^(a+)+$' }), 'REGEX_TIMEOUT');
  clearTimeout(timer);
  assert.ok(ticked);
  assert.equal(success(await f.call('search_files', { path: file, pattern: '!', mode: 'literal' })).results.length, 1);
  failure(await f.call('edit_file', { path: file, oldString: '^(a+)+$', newString: 'X', useRegex: true }), 'REGEX_TIMEOUT');
  assert.equal(await fs.readFile(file, 'utf8'), 'a'.repeat(32) + '!');
});

test('优化 编辑dryRun、expectedHash、expectedMatches与批量计数', async t => {
  const f = await fixture(t);
  const file = await f.sample('edit.txt', 'foo foo\r\nbar');
  const original = await fs.readFile(file);
  const dry = success(await f.call('edit_file', { path: file, oldString: 'foo', newString: 'x', dryRun: true }));
  assert.equal(dry.changed, false);
  assert.equal(dry.replaced, 1);
  assert.equal(dry.matched, 2);
  assert.deepEqual(await fs.readFile(file), original);
  failure(await f.call('edit_file', { path: file, oldString: 'foo', newString: 'x', expectedMatches: 1 }), 'MATCH_COUNT_MISMATCH');
  failure(await f.call('edit_file', { path: file, oldString: 'foo', newString: 'x', expectedHash: '0'.repeat(64) }), 'CONFLICT');
  const batch = success(await f.call('edit_file', { path: file, edits: [{ oldString: 'foo', newString: 'x' }, { oldString: 'bar', newString: 'b' }] }));
  assert.equal(batch.replaced, 2);
  assert.equal(batch.matched, 3);
});

test('优化 批量失败无修改，混合参数拒绝，捕获组与字面替换语义保留', async t => {
  const f = await fixture(t);
  const file = await f.sample('batch.txt', 'foo\r\nbar');
  failure(await f.call('edit_file', { path: file, edits: [{ oldString: 'foo', newString: 'x' }, { oldString: 'missing', newString: 'y' }] }), 'NO_MATCH');
  assert.equal(await fs.readFile(file, 'utf8'), 'foo\r\nbar');
  failure(await f.call('edit_file', { path: file, oldString: 'foo', newString: 'x', edits: [{ oldString: 'foo', newString: 'x' }] }), 'AMBIGUOUS_EDIT');
  success(await f.call('edit_file', { path: file, oldString: '(foo)', newString: '$1X', useRegex: true }));
  success(await f.call('edit_file', { path: file, oldString: 'bar', newString: '$&' }));
  assert.equal(await fs.readFile(file, 'utf8'), 'fooX\r\n$&');
});

test('优化 提交后磁盘验证失败回滚原始字节', async t => {
  const f = await fixture(t);
  const file = await f.sample('rollback.txt', 'ORIGINAL');
  const originalVerify = f.encryption.verify;
  /** 在最终路径阶段注入校验失败，模拟rename后目录策略变化。 */
  f.encryption.verify = async (target, expected, mode, context) => {
    if (target === file && expected.hash !== payloadFingerprint('ORIGINAL').hash) throw fault('DISK_MISMATCH', '模拟提交后校验失败');
    return originalVerify(target, expected, mode, context);
  };
  failure(await f.call('write_file', { path: file, content: 'NEW' }), 'DISK_MISMATCH');
  assert.equal(await fs.readFile(file, 'utf8'), 'ORIGINAL');
  assert.ok(!(await fs.readdir(f.root)).some(name => name.startsWith('.mcp-')));
});

test('优化 暂存阶段ENOSPC不截断原文件', async t => {
  const f = await fixture(t);
  const file = await f.sample('diskfull.txt', 'ORIGINAL');
  /** 注入写入一半后失败，验证最终文件尚未被覆盖。 */
  f.encryption.prepare = async stage => { await fs.writeFile(stage, 'PART'); throw fault('ENOSPC', '模拟磁盘满'); };
  failure(await f.call('write_file', { path: file, content: 'NEW' }), 'ENOSPC');
  assert.equal(await fs.readFile(file, 'utf8'), 'ORIGINAL');
});

test('优化 文件和目录均应用unsafe策略，目录失败保留源', async t => {
  const f = await fixture(t);
  const source = await f.sample('src/a.scss', 'A');
  await f.sample('src/nested/b.txt', 'B');
  await f.encryption.mark('.scss', 'unsafe');
  const destination = path.join(f.root, 'dst');
  success(await f.call('copy_path', { source: path.dirname(source), destination }));
  assert.equal(await fs.readFile(path.join(destination, 'a.scss'), 'utf8'), 'A');
  assert.ok(f.copied.size > 0);
  success(await f.call('move_path', { source: path.dirname(source), destination: path.join(f.root, 'moved') }));
  await assert.rejects(fs.access(path.dirname(source)));
});

test('优化 目录移动不能删除复制期间新出现的源文件', async t => {
  const f = await fixture(t);
  const source = await f.sample('src/a.txt', 'A');
  const destination = path.join(f.root, 'dst');
  const originalVerify = f.encryption.verify;
  /** 最终目标验证时新增未被复制的源文件。 */
  f.encryption.verify = async (target, expected, mode, context) => {
    if (target === path.join(destination, 'a.txt')) await fs.writeFile(path.join(path.dirname(source), 'new.txt'), 'NEW');
    return originalVerify(target, expected, mode, context);
  };
  failure(await f.call('move_path', { source: path.dirname(source), destination }));
  assert.equal(await fs.readFile(path.join(path.dirname(source), 'new.txt'), 'utf8'), 'NEW');
  assert.equal(await fs.readFile(path.join(destination, 'a.txt'), 'utf8'), 'A');
});

test('优化 hash冲突、禁止覆盖、根目录保护、只读边界', async t => {
  const f = await fixture(t);
  const file = await f.sample('keep.txt', 'old');
  failure(await f.call('write_file', { path: file, content: 'new', overwrite: false }), 'ALREADY_EXISTS');
  failure(await f.call('write_file', { path: file, content: 'new', expectedHash: '0'.repeat(64) }), 'CONFLICT');
  failure(await f.call('remove_path', { path: f.root }), 'PROTECTED_ROOT');
  failure(await f.call('read_file', { path: path.resolve(f.root, '..', 'outside.txt') }), 'PATH_OUTSIDE_ROOTS');
  const readOnly = createServer({ ...f.opts, encryption: f.encryption, readOnly: true });
  failure(await readOnly.handlers.write_file({ path: file, content: 'new' }), 'READ_ONLY');
  assert.equal(await fs.readFile(file, 'utf8'), 'old');
});

test('优化 多个实例并发追加不丢失更新，策略不同扩展名互不覆盖', async t => {
  const f = await fixture(t);
  const second = createServer({ ...f.opts, encryption: createEncryption(f.opts) });
  const file = await f.sample('concurrent.txt', 'base\n');
  const responses = await Promise.all([f.call('write_file', { path: file, content: 'A\n', mode: 'append' }), second.handlers.write_file({ path: file, content: 'B\n', mode: 'append' })]);
  responses.forEach(success);
  const content = await fs.readFile(file, 'utf8');
  assert.ok(content.includes('A\n') && content.includes('B\n'));
  await Promise.all([f.encryption.mark('.java', 'protected'), second.encryption.mark('.scss', 'unsafe')]);
  assert.equal(await f.encryption.getOverride('.java'), 'protected');
  assert.equal(await f.encryption.getOverride('.scss'), 'unsafe');
});

test('优化 隐藏项开关、字面量搜索、上下文和搜索总输出预算', async t => {
  const f = await fixture(t);
  await f.sample('.hidden/a.txt', 'before\na.b\nafter');
  assert.equal(success(await f.call('search_files', { path: f.root, pattern: 'a.b', include: '*.txt' })).results.length, 0);
  const data = success(await f.call('search_files', { path: f.root, pattern: 'a.b', mode: 'literal', showHidden: true, include: '*.txt', contextLines: 1 }));
  assert.deepEqual(data.results[0].context, { before: ['before'], after: ['after'] });
  const huge = await f.sample('huge.txt', 'X'.repeat(1000000));
  const bounded = success(await f.call('search_files', { path: huge, pattern: 'X' }));
  assert.equal(bounded.truncated, true);
  assert.ok(JSON.stringify(bounded).length < 410000);
});

test('优化 CR-only行分页、批量总预算、原始字节大小含BOM', async t => {
  const f = await fixture(t);
  const file = await f.sample('lines.txt', '\uFEFFone\rtwo\rthree\r');
  const page = success(await f.call('read_file_partial', { path: file, mode: 'lines', startLine: 2, endLine: 2 }));
  assert.deepEqual(page.lines, [{ line: 2, text: 'two' }]);
  assert.equal(page.nextLine, 3);
  assert.equal(success(await f.call('file_info', { path: file })).sizeReadable, (await fs.readFile(file)).length);
  const a = await f.sample('a.txt', 'a'.repeat(300000));
  const b = await f.sample('b.txt', 'b'.repeat(300000));
  const batch = success(await f.call('read_files', { paths: [a, b] }));
  assert.ok(batch.entries.reduce((total, item) => total + (item.content?.length || 0), 0) <= 400001);
});

test('优化 100MB字符/行分页保持有界内存与及时返回', async t => {
  const f = await fixture(t);
  const file = await f.sample('100mb.txt', 'first\nsecond\n');
  // 稀疏文件用于验证不会为了前缀或前两行读取剩余100MB。
  await fs.truncate(file, 100 * 1024 * 1024);
  // 读取器严格拒绝NUL；改用真实重复文本分块写入，保证测试覆盖有效文本。
  const handle = await fs.open(file, 'w');
  try {
    const block = Buffer.from(('a'.repeat(99) + '\n').repeat(10000));
    for (let i = 0; i < 100; i++) await handle.write(block);
  } finally { await handle.close(); }
  const before = process.memoryUsage().rss;
  const start = performance.now();
  const prefix = success(await f.call('read_file', { path: file }));
  const lines = success(await f.call('read_file_partial', { path: file, mode: 'lines', startLine: 1, endLine: 2 }));
  assert.equal(prefix.content.length, 400000);
  assert.equal(lines.lines.length, 2);
  const rssDelta = process.memoryUsage().rss - before;
  const elapsed = performance.now() - start;
  t.diagnostic(JSON.stringify({ bytes: (await fs.stat(file)).size, elapsedMs: elapsed, rssDeltaBytes: rssDelta }));
  assert.ok(elapsed < 5000);
  assert.ok(rssDelta < 100 * 1024 * 1024);
});

test('优化 取消正则任务后服务可恢复', async () => {
  const controller = new AbortController();
  const promise = runRegex({ operation: 'edit', pattern: '^(a+)+$', text: 'a'.repeat(32) + '!', replacement: 'x' }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(promise, { code: 'CANCELLED' });
  const next = await runRegex({ operation: 'edit', pattern: 'a', text: 'a', replacement: 'b' });
  assert.equal(next.updated, 'b');
});
