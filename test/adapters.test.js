/** 实际Windows外部进程适配器验收；不依赖或更改真实加密profile。 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const { readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { performance } = require('node:perf_hooks');
const { fixture } = require('./helper.cjs');
const { externalCopy, inspectDisk } = require('../lib/encryption');
const { fingerprint } = require('../lib/text');

/** 运行真实适配器源码，仅替换进程与时钟，确定性模拟CI慢启动而不实际等待数十秒。 */
function simulatedProcess() {
  const filename = path.resolve(__dirname, '../lib/encryption.js');
  const realRequire = createRequire(filename);
  const timers = new Map();
  const children = [];
  let now = performance.now();
  let serial = 0;
  /** 构造支持编码设置的输出事件流，模拟spawn的pipe接口。 */
  function outputStream() {
    const stream = new EventEmitter();
    stream.setEncoding = () => stream;
    return stream;
  }
  /** 模拟一个可被超时/取消杀死的子进程，不执行任何系统命令。 */
  function spawn() {
    const child = new EventEmitter();
    child.stdout = outputStream();
    child.stderr = outputStream();
    child.killed = false;
    child.kill = () => { child.killed = true; child.emit('close', null); return true; };
    children.push(child);
    return child;
  }
  const sandbox = {
    module: { exports: {} }, Buffer, process,
    require: name => name === 'node:child_process' ? { spawn } : name === 'node:perf_hooks' ? { performance: { now: () => now } } : realRequire(name),
    setTimeout: (callback, ms) => { const id = ++serial; timers.set(id, { callback, at: now + ms }); return id; },
    clearTimeout: id => timers.delete(id),
  };
  vm.runInNewContext(readFileSync(filename, 'utf8'), sandbox, { filename });
  /** 推进虚拟时钟并执行到期回调，保留生产代码计算截止时间的逻辑。 */
  function advance(ms) {
    now += ms;
    for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback(); }
  }
  /** 从当前进程返回输出或错误，供读取器解析和错误透传验收。 */
  function reply(stdout, code = 0, stderr = '') {
    const child = children.at(-1);
    child.stdout.emit('data', stdout);
    child.stderr.emit('data', stderr);
    child.emit('close', code);
  }
  return { api: sandbox.module.exports, children, advance, reply, now: () => now };
}

test('适配器预算：默认仍在5秒终止，读取失败保持不可验证而非伪造成功', async () => {
  const sim = simulatedProcess();
  const pending = sim.api.inspectDisk('powershell', 'sample.tmp');
  sim.advance(4999);
  assert.equal(sim.children[0].killed, false);
  sim.advance(2);
  assert.equal(sim.children[0].killed, true);
  assert.equal(await pending, null);
});

test('适配器预算：显式30秒预算允许6秒慢启动后返回完整指纹', async () => {
  const sim = simulatedProcess();
  const expected = { hash: 'a'.repeat(64), size: 7, prefix: '0001ff1a0d0a41' };
  const pending = sim.api.inspectDisk('powershell', 'sample.tmp', { processTimeoutMs: 30000, throwOnError: true });
  sim.advance(6000);
  assert.equal(sim.children[0].killed, false, '测试显式预算不能再被5秒上限覆盖');
  sim.reply(JSON.stringify(expected));
  assert.deepEqual({ ...(await pending) }, expected);
});

test('适配器预算：较短的请求deadline与取消仍优先于30秒预算', async () => {
  const deadline = simulatedProcess();
  const timedOut = assert.rejects(deadline.api.inspectDisk('powershell', 'sample.tmp', { deadline: deadline.now() + 1200, processTimeoutMs: 30000, throwOnError: true }), { code: 'PROCESS_TIMEOUT' });
  deadline.advance(1201);
  await timedOut;
  assert.equal(deadline.children[0].killed, true);
  const cancelled = simulatedProcess();
  const controller = new AbortController();
  const aborted = assert.rejects(cancelled.api.inspectDisk('powershell', 'sample.tmp', { signal: controller.signal, processTimeoutMs: 30000 }), { code: 'CANCELLED' });
  controller.abort();
  await aborted;
  assert.equal(cancelled.children[0].killed, true);
});

test('适配器预算：严格诊断保留进程错误和无效指纹，普通调用仍返回null', async () => {
  const failed = simulatedProcess();
  const error = assert.rejects(failed.api.inspectDisk('powershell', 'sample.tmp', { throwOnError: true }), { code: 'PROCESS_FAILED', message: /reader denied/ });
  failed.reply('', 1, 'reader denied');
  await error;
  const invalid = simulatedProcess();
  const malformed = assert.rejects(invalid.api.inspectDisk('powershell', 'sample.tmp', { throwOnError: true }), { code: 'INVALID_DISK_FINGERPRINT' });
  invalid.reply('{}');
  await malformed;
  const ordinary = simulatedProcess();
  const unavailable = ordinary.api.inspectDisk('powershell', 'sample.tmp');
  ordinary.reply('{}');
  assert.equal(await unavailable, null);
});

test('适配器预算：拒绝无界或非法单进程预算，失败时不启动进程', () => {
  const sim = simulatedProcess();
  for (const processTimeoutMs of [0, -1, 1.5, NaN, Infinity, 60001]) {
    assert.throws(() => sim.api.execute('unused.exe', [], { processTimeoutMs }), { code: 'INVALID_PROCESS_TIMEOUT' });
  }
  assert.equal(sim.children.length, 0);
});

test('实际Windows适配器：PowerShell/cmd/robocopy/cscript复制特殊路径与二进制', { skip: process.platform !== 'win32', timeout: 270000 }, async t => {
  const f = await fixture(t);
  const source = await f.sample("带 空格 ' %PATH%.tmp", Buffer.from([0, 1, 255, 26, 13, 10, 65]));
  for (const proc of ['powershell', 'cmd', 'robocopy', 'cscript']) {
    await t.test(proc, { timeout: 65000 }, async () => {
      const destination = path.join(f.root, proc + " 输出 ' %PATH%.dat");
      // 托管Windows的冷启动不适合作为5秒性能断言；复制+读取仍共享60秒总预算，不重试或跳过失败。
      const context = { processTimeoutMs: 30000, deadline: performance.now() + 60000, throwOnError: true };
      await externalCopy(proc, source, destination, context);
      assert.deepEqual(await fs.readFile(destination), await fs.readFile(source));
      const raw = await inspectDisk('powershell', destination, context);
      assert.deepEqual(raw, await fingerprint(source));
    });
  }
  assert.ok(!(await fs.readdir(f.root)).some(name => name.startsWith('.mcp-')));
});
