/** 实际Windows外部进程适配器验收；不依赖或更改真实加密profile。 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture } = require('./helper.cjs');
const { externalCopy, inspectDisk } = require('../lib/encryption');
const { fingerprint } = require('../lib/text');

test('实际Windows适配器：PowerShell/cmd/robocopy/cscript复制特殊路径与二进制', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t);
  const source = await f.sample("带 空格 ' %PATH%.tmp", Buffer.from([0, 1, 255, 26, 13, 10, 65]));
  for (const proc of ['powershell', 'cmd', 'robocopy', 'cscript']) {
    await t.test(proc, async () => {
      const destination = path.join(f.root, proc + " 输出 ' %PATH%.dat");
      await externalCopy(proc, source, destination);
      assert.deepEqual(await fs.readFile(destination), await fs.readFile(source));
      const raw = await inspectDisk('powershell', destination);
      assert.deepEqual(raw, await fingerprint(source));
    });
  }
  assert.ok(!(await fs.readdir(f.root)).some(name => name.startsWith('.mcp-')));
});
