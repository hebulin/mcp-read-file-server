/** 2.1.0通用写入状态回归：模拟Node透明解密与外部密文视图，真实文件操作保持执行。 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture } = require('./helper.cjs');
const { fingerprint, payloadFingerprint, fault } = require('../lib/text');
const { stop } = require('../lib/regex');
after(() => stop());

/** 提取成功结果，失败时同时显示完整协议返回。 */
function success(response) {
  assert.equal(response.structuredContent.ok, true, JSON.stringify(response));
  return response.structuredContent.data;
}

/** 验证失败码，防止错误通过人类文本伪装为成功。 */
function failure(response, code) {
  assert.equal(response.structuredContent.ok, false, JSON.stringify(response));
  assert.equal(response.structuredContent.code, code);
  return response.structuredContent.data;
}

/** 按文件身份记录模拟保护状态，使rename前后外部视图保持一致。 */
async function encryptedEnvironment(t, settings = {}) {
  const protectedFiles = new Set();
  const inspected = [];
  /** 获取不会因同目录rename而变化的文件标识。 */
  async function identity(file) {
    const st = await fs.stat(file, { bigint: true });
    return st.dev + ':' + st.ino;
  }
  const f = await fixture(t, {
    profile: settings.profile,
    /** Node暂存/探测触发加密；安全中转复制出的文件提供预期明文视图。 */
    reader: async ({ file, copied, context }) => {
      inspected.push(file);
      const key = await identity(file);
      const name = path.basename(file);
      if (settings.encryptDirect !== false && /^\.mcp-(stage|probe)-/.test(name) && !copied.has(file)) protectedFiles.add(key);
      const actual = await fingerprint(file, context);
      // 安全候选文件代表“应当保持明文”的临时文件：即使它复用了刚被删除暂存文件的inode，
      // 也必须按明文读取；否则回退循环里每个候选都会被误判为已受保护密文，整体报SAFE_WRITE_FAILED。
      if (/^\.mcp-safe-/.test(name)) return actual;
      return protectedFiles.has(key) ? payloadFingerprint(Buffer.concat([Buffer.from('%TSD-Header-###%'), await fs.readFile(file)])) : actual;
    },
    /** 外部复制不触发模拟加密；可注入失败验证原目标和源文件的保留。 */
    copier: async ({ source, destination, copied }) => {
      if (settings.copyFails) throw fault('EACCES', '模拟所有外部复制均失败');
      await fs.copyFile(source, destination);
      protectedFiles.delete(await identity(destination));
      copied.add(destination);
    },
  });
  /** 为已有样本设置受保护视图，不改变Node看到的内容。 */
  async function protect(file) { protectedFiles.add(await identity(file)); }
  /** 独立检查提交后的模拟外部视图，不能只断言工具返回成功。 */
  async function isProtected(file) { return protectedFiles.has(await identity(file)); }
  const prepare = f.encryption.prepare;
  /** 模拟写入即触发保护，显式preserve跳过外部读取时也应保持真实的模拟状态。 */
  f.encryption.prepare = (stage, writer, expected, decision, context) => prepare(stage, async destination => {
    await writer(destination);
    if (settings.encryptDirect !== false && path.basename(destination).startsWith('.mcp-stage-')) await protect(destination);
  }, expected, decision, context);
  return { ...f, inspected, protect, isProtected };
}

test('通用auto：明文文件不因任意后缀、大小写、无后缀或点文件名被写成密文', async t => {
  const f = await encryptedEnvironment(t);
  for (const name of ['style.scss', 'code.java', 'data.custom+type', 'upper.SCSS', 'file.随机后缀', 'README', '.env']) {
    const file = await f.sample(name, '\uFEFF你好\r\nold\r\n');
    // 模拟历史扩展名分类为protected，不能把它作为现有明文文件的存储状态。
    const profile = await f.encryption.getProfile();
    profile.scopes[f.root + '|' + path.extname(file).toLowerCase()] = 'protected';
    const data = success(await f.call('edit_file', { path: file, oldString: 'old', newString: 'new', expectedMatches: 1 }));
    assert.equal(data.strategy.basis, 'target');
    assert.equal(data.strategy.originalState, 'plaintext');
    assert.equal(data.diskState, 'plaintext');
    assert.equal(data.diskVerified, true);
    assert.equal(data.via.process, 'powershell');
    assert.equal(await fs.readFile(file, 'utf8'), '\uFEFF你好\r\nnew\r\n');
    assert.equal(await f.isProtected(file), false, name);
  }
});

test('覆盖及追加均按原文件明文状态提交，追加保留BOM和CRLF', async t => {
  const f = await encryptedEnvironment(t);
  for (const mode of ['overwrite', 'append']) {
    const file = await f.sample(mode + '.opaque', '\uFEFFORIGINAL\r\n');
    const data = success(await f.call('write_file', { path: file, content: 'NEW\n', mode }));
    assert.equal(data.diskVerified, true);
    assert.equal(await f.isProtected(file), false);
    assert.equal(await fs.readFile(file, 'utf8'), '\uFEFF' + (mode === 'append' ? 'ORIGINAL\r\n' : '') + 'NEW\r\n');
  }
});

test('相同扩展名文件分别观察状态；原受保护文件不会自动解密为明文', async t => {
  const f = await encryptedEnvironment(t);
  const plain = await f.sample('plain.same', 'old');
  const protectedFile = await f.sample('protected.same', 'old');
  await f.protect(protectedFile);
  const plainResult = success(await f.call('write_file', { path: plain, content: 'NEW' }));
  const protectedResponse = await f.call('write_file', { path: protectedFile, content: 'NEW' });
  const protectedResult = success(protectedResponse);
  assert.equal(plainResult.strategy.originalState, 'plaintext');
  assert.equal(protectedResult.strategy.originalState, 'protected');
  assert.equal(protectedResult.diskState, 'preserved');
  assert.equal(protectedResult.diskVerified, false);
  assert.equal(protectedResult.protectionObserved, true);
  assert.equal(await f.isProtected(protectedFile), true);
  assert.ok(protectedResponse.structuredContent.warnings.some(w => w.includes('IDEA')));
  assert.equal(protectedResult.via, undefined);
});

test('新建路径即使目录探测为protected也要求明文，不把Node可读推断为IDEA可读', async t => {
  const f = await encryptedEnvironment(t);
  for (const name of ['new.scss', 'new.arbitrary', 'NOEXT', '.settings']) {
    const file = path.join(f.root, name);
    const data = success(await f.call('write_file', { path: file, content: 'NEW' }));
    assert.equal(data.strategy.basis, 'new_file');
    assert.equal(data.strategy.category, 'protected');
    assert.equal(data.strategy.mode, 'plaintext');
    assert.equal(data.diskVerified, true);
    assert.equal(await f.isProtected(file), false);
  }
  const noExtensionProbe = f.inspected.find(file => path.basename(file).startsWith('.mcp-probe-') && path.extname(file) === '');
  assert.ok(noExtensionProbe, '无后缀探测必须使用真正无后缀文件');
});

test('普通明文环境不必调用外部复制器，仍验证最终外部视图', async t => {
  const f = await fixture(t, {
    /** 安全目录直接暂存即可，额外外部复制表示发生性能退化。 */
    copier: async () => { throw new Error('不应调用外部复制器'); },
  });
  const file = await f.sample('existing.txt', 'old');
  for (const target of [file, path.join(f.root, 'new.txt')]) {
    const data = success(await f.call('write_file', { path: target, content: 'NEW' }));
    assert.equal(data.diskVerified, true);
    assert.equal(data.via, undefined);
  }
});

test('dryRun不进入写入策略；无变化提交仍返回实际状态依据', async t => {
  const f = await encryptedEnvironment(t);
  const file = await f.sample('keep.any', 'old');
  const preview = success(await f.call('edit_file', { path: file, oldString: 'old', newString: 'new', dryRun: true }));
  assert.equal(preview.changed, false);
  assert.equal(f.inspected.length, 0);
  const same = success(await f.call('write_file', { path: file, content: 'old' }));
  assert.equal(same.changed, false);
  assert.equal(same.strategy.basis, 'target');
  assert.equal(same.diskVerified, true);
  assert.equal(await fs.readFile(file, 'utf8'), 'old');
  assert.ok(!f.inspected.some(file => path.basename(file).startsWith('.mcp-stage-')));
});

test('策略预览按已有文件状态读取，不用同后缀探测结果替代且不缓存文件状态', async t => {
  const f = await encryptedEnvironment(t);
  const file = await f.sample('inspect.any', 'old');
  const plain = success(await f.call('inspect_write_strategy', { path: file }));
  assert.equal(plain.mode, 'plaintext');
  assert.equal(plain.basis, 'target');
  await f.protect(file);
  const protectedResult = success(await f.call('inspect_write_strategy', { path: file }));
  assert.equal(protectedResult.mode, 'preserve');
  assert.equal(protectedResult.originalState, 'protected');
  assert.ok(!f.inspected.some(file => path.basename(file).startsWith('.mcp-probe-')));
  assert.equal(await fs.readFile(file, 'utf8'), 'old');
});

test('单次显式策略优先于人工标注，人工标注优先于自动状态规则', async t => {
  const f = await encryptedEnvironment(t);
  const file = await f.sample('override.java', 'old');
  await f.encryption.mark('.java', 'protected');
  const controlled = success(await f.call('write_file', { path: file, content: 'CONTROLLED' }));
  assert.equal(controlled.strategy.basis, 'override');
  assert.equal(controlled.diskState, 'preserved');
  assert.equal(await f.isProtected(file), true);
  const plain = success(await f.call('write_file', { path: file, content: 'PLAIN', writePolicy: 'plaintext' }));
  assert.equal(plain.strategy.basis, 'explicit');
  assert.equal(await f.isProtected(file), false);
  await f.encryption.mark('.java', 'unsafe');
  const explicitlyProtected = success(await f.call('write_file', { path: file, content: 'CONTROLLED', writePolicy: 'preserve' }));
  assert.equal(explicitlyProtected.strategy.basis, 'explicit');
  assert.equal(await f.isProtected(file), true);
  const overridePlain = success(await f.call('write_file', { path: file, content: 'PLAIN' }));
  assert.equal(overridePlain.strategy.basis, 'override');
  assert.equal(await f.isProtected(file), false);
});

for (const tool of ['copy_path', 'move_path']) {
  test(tool + '对新目标继承源状态，二进制及无扩展名使用同一策略', async t => {
    const f = await encryptedEnvironment(t);
    const bytes = Buffer.from([0, 1, 128, 255, 13, 10, 4]);
    const source = await f.sample('source/data.unknown', bytes);
    const destination = path.join(f.root, 'destination', 'NOEXT');
    success(await f.call(tool, { source, destination }));
    assert.deepEqual(await fs.readFile(destination), bytes);
    assert.equal(await f.isProtected(destination), false);
    const protectedSource = await f.sample('protected/file.unknown', 'SECRET');
    await f.protect(protectedSource);
    const protectedTarget = path.join(f.root, 'protected-target.java');
    success(await f.call(tool, { source: protectedSource, destination: protectedTarget }));
    assert.equal(await f.isProtected(protectedTarget), true);
    if (tool === 'move_path') {
      await assert.rejects(fs.access(source), { code: 'ENOENT' });
      await assert.rejects(fs.access(protectedSource), { code: 'ENOENT' });
    }
  });
}

test('覆盖复制以已有目标状态为准，目录内逐文件应用明文保护', async t => {
  const f = await encryptedEnvironment(t);
  const source = await f.sample('source.a', 'NEW');
  const target = await f.sample('target.a', 'old');
  success(await f.call('copy_path', { source, destination: target }));
  assert.equal(await f.isProtected(target), false);
  const treeSource = await f.sample('tree/a.a', 'A');
  await f.sample('tree/sub/NOEXT', 'B');
  const destination = path.join(f.root, 'tree-copy');
  success(await f.call('copy_path', { source: path.dirname(treeSource), destination }));
  for (const name of ['a.a', 'sub/NOEXT']) assert.equal(await f.isProtected(path.join(destination, name)), false);
});

test('基线外部读取失败时auto中止，不用目录protected分类掩盖未知状态', async t => {
  const f = await fixture(t, { reader: async () => null });
  const file = await f.sample('keep.any', 'ORIGINAL');
  const profile = await f.encryption.getProfile();
  profile.scopes[f.root + '|.any'] = 'protected';
  const data = failure(await f.call('write_file', { path: file, content: 'NEW' }), 'DISK_UNVERIFIED');
  assert.equal(data.changed, false);
  assert.equal(await fs.readFile(file, 'utf8'), 'ORIGINAL');
  assert.ok(!(await fs.readdir(f.root)).some(name => name.startsWith('.mcp-')));
});

test('基线读取期间内容改变时拒绝提交，保留外部最新修改', async t => {
  let changed = false;
  const f = await fixture(t, {
    /** 在外部指纹读取与Node复核之间模拟编辑器保存新内容。 */
    reader: async ({ file, context }) => {
      const raw = await fingerprint(file, context);
      if (path.basename(file) === 'conflict.any' && !changed) { changed = true; await fs.writeFile(file, 'EXTERNAL'); }
      return raw;
    },
  });
  const file = await f.sample('conflict.any', 'ORIGINAL');
  failure(await f.call('write_file', { path: file, content: 'NEW' }), 'CONFLICT');
  assert.equal(await fs.readFile(file, 'utf8'), 'EXTERNAL');
});

test('明文安全中转全部失败时不回退受控写入，移动源仍保留', async t => {
  const f = await encryptedEnvironment(t, { copyFails: true });
  const file = await f.sample('keep.any', 'ORIGINAL');
  failure(await f.call('write_file', { path: file, content: 'NEW' }), 'SAFE_WRITE_FAILED');
  assert.equal(await fs.readFile(file, 'utf8'), 'ORIGINAL');
  assert.equal(await f.isProtected(file), false);
  const source = await f.sample('source.any', 'SOURCE');
  failure(await f.call('move_path', { source, destination: file }), 'SAFE_WRITE_FAILED');
  assert.equal(await fs.readFile(source, 'utf8'), 'SOURCE');
  assert.equal(await fs.readFile(file, 'utf8'), 'ORIGINAL');
});

test('最终路径才发生加密时明文终验失败并回滚，不只验证暂存文件', async t => {
  const f = await encryptedEnvironment(t);
  const file = await f.sample('rollback.any', 'ORIGINAL');
  const verify = f.encryption.verify;
  /** 仅在新内容已安装至最终路径时改变外部读取视图。 */
  f.encryption.verify = async (target, expected, mode, context) => {
    if (target === file && expected.hash === payloadFingerprint('NEW').hash) await f.protect(file);
    return verify(target, expected, mode, context);
  };
  const data = failure(await f.call('write_file', { path: file, content: 'NEW' }), 'DISK_MISMATCH');
  assert.equal(data.changed, false);
  assert.equal(await fs.readFile(file, 'utf8'), 'ORIGINAL');
  assert.equal(await f.isProtected(file), false);
});

test('原受保护文件不能在自动写入中静默变为明文，失败保留原文件', async t => {
  const f = await encryptedEnvironment(t, { encryptDirect: false });
  const file = await f.sample('protected.any', 'SECRET');
  await f.protect(file);
  failure(await f.call('write_file', { path: file, content: 'NEW' }), 'PROTECTION_MISMATCH');
  assert.equal(await fs.readFile(file, 'utf8'), 'SECRET');
  assert.equal(await f.isProtected(file), true);
  assert.equal(f.copied.size, 0, '受保护状态失败不能降级为明文中转');
});

test('无读取器且缓存有加密观察时所有平台均拒绝auto，不静默认证明文', async t => {
  const f = await fixture(t, { profile: { byteReader: null, encryptedExtensions: ['.any'] } });
  const file = await f.sample('protected.any', 'old');
  failure(await f.call('write_file', { path: file, content: 'NEW' }), 'DISK_UNVERIFIED');
  assert.equal(await fs.readFile(file, 'utf8'), 'old');
});
