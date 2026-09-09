/** 测试夹具：只在指定临时根目录读写，清理前校验绝对路径。 */
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createServer } = require('../lib/server');
const { createEncryption } = require('../lib/encryption');
const { fingerprint } = require('../lib/text');

/** 初始化隔离测试目录和可注入复制器，不接触用户真实profile。 */
async function fixture(t, settings = {}) {
  const base = path.resolve(process.env.MCP_TEST_ROOT || path.join(os.tmpdir(), 'mcp-read-file-tests'));
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'case-'));
  const stateDir = path.join(root, 'state');
  await fs.mkdir(stateDir);
  const cleanupTasks = [];
  t.after(async () => {
    for (const task of cleanupTasks.reverse()) await task();
    const resolved = await fs.realpath(root);
    const realBase = await fs.realpath(base);
    if (!resolved.startsWith(realBase + path.sep)) throw new Error('清理路径越界');
    await fs.rm(resolved, { recursive: true, force: true });
  });
  const copied = new Set();
  const profile = { safeExtensions: ['.tmp'], byteReader: 'powershell', availableProcesses: [{ id: 'powershell' }], ...settings.profile };
  const opts = { stateDir, baseDir: root, allowedRoots: [root], probeDir: root, profile,
    /** 模拟独立磁盘视图；生产控制流和实际样本文件保持真实执行。 */
    inspectDisk: async (proc, file, context) => {
      if (settings.reader) return settings.reader({ proc, file, context, copied, root });
      return proc ? fingerprint(file, context) : null;
    },
    /** 只复制独立测试文件；可注入损坏或失败验证事务回滚。 */
    externalCopy: async (proc, source, destination, context) => {
      if (settings.copier) return settings.copier({ proc, source, destination, context, copied, root });
      await fs.copyFile(source, destination);
      copied.add(destination);
    },
    ...settings.options,
  };
  const encryption = createEncryption(opts);
  const app = createServer({ ...opts, encryption });
  /** 写入独立样本，父目录仅在本测试根下创建。 */
  async function sample(name, value) {
    const file = path.resolve(root, name);
    if (!file.startsWith(root + path.sep)) throw new Error('样本路径越界');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, value);
    return file;
  }
  /** 调用实际生产回调；协议和schema另外用真实stdio覆盖。 */
  async function call(name, args) { return app.handlers[name](args); }
  return { ...app, root, stateDir, profile, opts, copied, sample, call, cleanupTasks };
}

/** 生成实际stdio使用的无外部进程测试缓存。 */
function cachedProfile() {
  return { version: 3, machineId: crypto.createHash('sha256').update(os.hostname() + '|' + os.userInfo().username).digest('hex').slice(0, 16), detectedAt: new Date().toISOString(), safeExtensions: [], protectedExtensions: [], unsafeExtensions: [], encryptedExtensions: [], availableProcesses: [], byteReader: null, bestCombo: null, scopes: {} };
}

module.exports = { fixture, cachedProfile };
