/** 异步环境探测、独立用户策略和目录感知的写入校验。 */
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { fault, checkBudget, fingerprint, payloadFingerprint } = require('./text');
const SAFE_CANDIDATES = ['.tmp', '.md', '.txt', '.log', '.dat', '.bak', '.cache', '.temp', '.mcp_tmp'];
const OTHER_CANDIDATES = ['.java', '.js', '.ts', '.css', '.scss', '.json', '.xml', '.py'];
const TTL = 30 * 86400000;
const PROBE = Buffer.from('mcp-encryption-probe|' + '0123456789abcdef'.repeat(9) + '|eol\n');

/** 限制扩展名为单一后缀，禁止把策略名称解释为路径。 */
function extension(value) {
  const ext = (value.startsWith('.') ? value : '.' + value).toLowerCase();
  if (!/^\.[a-z0-9_+-]{1,32}$/.test(ext)) throw fault('INVALID_EXTENSION', '扩展名必须是单个有效后缀，如 .java');
  return ext;
}

/** PowerShell 字面量转义，不接受控制字符和 Windows 不合法引号。 */
function quote(value) { return "'" + value.replace(/'/g, "''") + "'"; }

/** 运行受超时、取消和输出预算限制的外部进程。 */
function execute(exe, args, options = {}) {
  checkBudget(options.signal, options.deadline);
  const timeout = Math.max(1, Math.min(5000, (options.deadline ?? Infinity) - performance.now()));
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...options.spawnOptions });
    let stdout = '';
    let stderr = '';
    let failure = null;
    const abort = () => { failure = fault('CANCELLED', '外部进程已取消'); child.kill(); };
    const timer = setTimeout(() => { failure = fault('PROCESS_TIMEOUT', '外部进程超时: ' + exe); child.kill(); }, timeout);
    options.signal?.addEventListener('abort', abort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 65536) { failure = fault('OUTPUT_LIMIT', '外部进程输出超过预算'); child.kill(); } });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4096); });
    child.on('error', error => { failure = error; });
    child.on('close', code => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else if (!(options.successCodes || [0]).includes(code)) reject(fault('PROCESS_FAILED', exe + ': ' + stderr.trim()));
      else resolve(stdout.trim());
    });
  });
}

/** 流式计算磁盘原始字节指纹；外部进程不可用时返回未知，不认证明文。 */
async function inspectDisk(proc, file, options = {}) {
  if (!proc) return null;
  const code = "$ErrorActionPreference='Stop';$f=[IO.File]::OpenRead(" + quote(file) + ');try{' +
    '$b=New-Object byte[] 16;$n=$f.Read($b,0,16);$prefix=\'\';if($n -gt 0){$prefix=([BitConverter]::ToString($b,0,$n)).Replace(\'-\',\'\').ToLowerInvariant()};' +
    '$null=$f.Seek(0,0);$sha=[Security.Cryptography.SHA256]::Create();try{$hash=([BitConverter]::ToString($sha.ComputeHash($f))).Replace(\'-\',\'\').ToLowerInvariant()}finally{$sha.Dispose()};' +
    '[pscustomobject]@{hash=$hash;size=$f.Length;prefix=$prefix}|ConvertTo-Json -Compress}finally{$f.Dispose()}';
  try {
    const raw = await execute(proc === 'pwsh' ? 'pwsh.exe' : 'powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', code], options);
    const data = JSON.parse(raw.replace(/^\uFEFF/, ''));
    if (!/^[a-f0-9]{64}$/.test(data.hash) || !Number.isSafeInteger(data.size) || !/^[a-f0-9]{0,32}$/.test(data.prefix)) return null;
    return data;
  } catch (error) {
    if (error.code === 'CANCELLED' || error.code === 'TIMEOUT') throw error;
    return null;
  }
}

/** 按独立路径参数或受控环境变量复制文件，不移动或删除源。 */
async function externalCopy(proc, source, destination, options = {}) {
  if (/["\r\n\0]/.test(source + destination)) throw fault('INVALID_PATH', '外部复制路径含不支持的字符');
  if (proc === 'powershell' || proc === 'pwsh') {
    await execute(proc === 'pwsh' ? 'pwsh.exe' : 'powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop';[IO.File]::Copy(" + quote(source) + ',' + quote(destination) + ',$true)'], options);
  } else if (proc === 'cmd') {
    await execute('cmd.exe', ['/d', '/v:off', '/s', '/c', 'copy /b /y "%MCP_COPY_SOURCE%" "%MCP_COPY_DEST%"'], {
      ...options, spawnOptions: { windowsVerbatimArguments: true, env: { ...process.env, MCP_COPY_SOURCE: source, MCP_COPY_DEST: destination } }
    });
  } else if (proc === 'robocopy') {
    const dir = await fs.mkdtemp(path.join(path.dirname(destination), '.mcp-robo-'));
    try {
      await execute('robocopy.exe', [path.dirname(source), dir, path.basename(source), '/R:0', '/W:0', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'], { ...options, successCodes: [0, 1, 2, 3, 4, 5, 6, 7] });
      await fs.rename(path.join(dir, path.basename(source)), destination);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  } else if (proc === 'cscript') {
    const helper = path.join(path.dirname(destination), '.mcp-copy-' + crypto.randomUUID() + '.tmp');
    try {
      await fs.writeFile(helper, 'var f=new ActiveXObject("Scripting.FileSystemObject");f.CopyFile(WScript.Arguments(0),WScript.Arguments(1),true);', { flag: 'wx' });
      await execute('cscript.exe', ['//nologo', '//E:JScript', helper, source, destination], options);
    } finally { await fs.rm(helper, { force: true }); }
  } else throw fault('INVALID_PROCESS', '未知复制进程');
}

/** 使用独占临时文件和 rename 保存小型配置，不暴露半个 JSON。 */
async function atomicJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = file + '.' + crypto.randomUUID() + '.tmp';
  try { await fs.writeFile(temp, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 }); await fs.rename(temp, file); }
  finally { await fs.rm(temp, { force: true }); }
}

/** 创建可注入磁盘读取和复制适配器的策略管理器，测试不需要修改真实用户缓存。 */
function createEncryption(options = {}) {
  const stateDir = path.resolve(options.stateDir || process.env.MCP_PROFILE_DIR || os.homedir());
  const cachePath = path.join(stateDir, '.mcp-encryption-profile.json');
  const policyDir = path.join(stateDir, '.mcp-file-policies');
  const machineId = crypto.createHash('sha256').update(os.hostname() + '|' + os.userInfo().username).digest('hex').slice(0, 16);
  const reader = options.inspectDisk || inspectDisk;
  const copier = options.externalCopy || externalCopy;
  let loading = null;
  let active = null;

  /** 创建字段完整的自动观察缓存，用户策略不会放入其中。 */
  function emptyProfile() {
    return { version: 3, machineId, detectedAt: new Date().toISOString(), safeExtensions: [], protectedExtensions: [], unsafeExtensions: [], encryptedExtensions: [], availableProcesses: [], byteReader: null, bestCombo: null, scopes: {} };
  }

  /** 严格校验缓存时间、列表与读取器；非法缓存不会变成安全结论。 */
  async function loadCache() {
    try {
      const p = JSON.parse(await fs.readFile(cachePath, 'utf8'));
      const date = Date.parse(p.detectedAt);
      if (![2, 3].includes(p.version) || p.machineId !== machineId || !Number.isFinite(date) || date > Date.now() + 60000 || Date.now() - date > TTL) return null;
      for (const key of ['safeExtensions', 'protectedExtensions', 'unsafeExtensions', 'encryptedExtensions']) {
        if (!Array.isArray(p[key]) || p[key].length > 1000 || !p[key].every(x => typeof x === 'string' && /^\.[a-z0-9_+-]{1,32}$/.test(x))) return null;
      }
      if (!Array.isArray(p.availableProcesses) || !p.availableProcesses.every(x => ['powershell', 'pwsh', 'cmd', 'robocopy', 'cscript'].includes(x.id))) return null;
      if (p.byteReader !== null && !['powershell', 'pwsh'].includes(p.byteReader)) return null;
      return { ...p, version: 3, scopes: {} };
    } catch { return null; }
  }

  /** 用户策略按扩展名单独存文件，避免不同扩展名的多实例更新互相覆盖。 */
  function policyPath(ext) { return path.join(policyDir, crypto.createHash('sha256').update(ext).digest('hex') + '.json'); }

  /** 一次性迁移旧版 protected 手工标注，即使旧缓存过期也保留用户意图。 */
  async function migrate() {
    const marker = path.join(policyDir, 'migration-v2.json');
    try { await fs.access(marker); return; } catch {}
    let legacy;
    try { legacy = JSON.parse(await fs.readFile(cachePath, 'utf8')); } catch { legacy = {}; }
    if (legacy.machineId === machineId && Array.isArray(legacy.userProtectedExtensions)) {
      await fs.mkdir(policyDir, { recursive: true });
      for (const value of legacy.userProtectedExtensions) {
        try {
          const ext = extension(value);
          await fs.writeFile(policyPath(ext), JSON.stringify({ extension: ext, category: 'protected' }), { flag: 'wx', mode: 0o600 });
        } catch (error) { if (error.code !== 'EEXIST' && error.code !== 'INVALID_EXTENSION') throw error; }
      }
    }
    await atomicJson(marker, { migratedAt: new Date().toISOString() });
  }

  /** 每次读策略都重读对应文件，使其他 MCP 进程的标注立即可见。 */
  async function getOverride(ext) {
    await migrate();
    if (!ext) return null;
    try {
      const data = JSON.parse(await fs.readFile(policyPath(ext), 'utf8'));
      if (data.extension !== ext || !['protected', 'unsafe', 'clear'].includes(data.category)) throw fault('INVALID_POLICY', '手工策略文件损坏');
      return data.category === 'clear' ? null : data.category;
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }

  /** 写入手工策略或显式清除墓碑，刷新与旧版迁移不能重新引入已清除标注。 */
  async function mark(value, category) {
    const ext = extension(value);
    await migrate();
    await atomicJson(policyPath(ext), { extension: ext, category, updatedAt: new Date().toISOString() });
    return { extension: ext, category };
  }

  /** 在指定目录使用随机独占样本分类；不以系统临时目录的分类覆盖其他目录。 */
  async function classify(ext, dir, profile, context = {}) {
    const temp = path.join(dir, '.mcp-probe-' + crypto.randomUUID() + ext);
    try {
      await fs.writeFile(temp, PROBE, { flag: 'wx', mode: 0o600 });
      const own = await fingerprint(temp, context);
      const expected = payloadFingerprint(PROBE);
      if (own.hash !== expected.hash) return 'unsafe';
      const raw = await reader(profile.byteReader, temp, context);
      if (!raw) return 'unknown';
      return raw.hash === expected.hash ? 'safe' : 'protected';
    } finally { await fs.rm(temp, { force: true }); }
  }

  /** 异步探测可用读取/复制器；总截止时间限制候选遍历。 */
  async function detect(context = {}) {
    const p = emptyProfile();
    if (options.profile) return { ...p, ...options.profile };
    if (process.platform !== 'win32') return p;
    const dir = await fs.mkdtemp(path.join(options.probeDir || os.tmpdir(), 'mcp-enc-probe-'));
    const source = path.join(dir, 'source.tmp');
    const target = path.join(dir, 'target.tmp');
    try {
      await fs.writeFile(source, PROBE, { flag: 'wx' });
      for (const id of ['powershell', 'pwsh', 'cmd', 'robocopy', 'cscript']) {
        checkBudget(context.signal, context.deadline);
        try {
          await copier(id, source, target, context);
          if ((await fingerprint(target, context)).hash === payloadFingerprint(PROBE).hash) p.availableProcesses.push({ id });
          if (!p.byteReader && ['powershell', 'pwsh'].includes(id)) {
            const raw = await reader(id, source, context);
            if (raw?.hash === payloadFingerprint(PROBE).hash) p.byteReader = id;
          }
        } catch (error) { if (['TIMEOUT', 'CANCELLED'].includes(error.code)) throw error; }
        await fs.rm(target, { force: true });
      }
      for (const ext of SAFE_CANDIDATES.concat(OTHER_CANDIDATES)) {
        checkBudget(context.signal, context.deadline);
        const category = await classify(ext, dir, p, context);
        if (category !== 'unknown') p[category + 'Extensions'].push(ext);
      }
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
    return p;
  }

  /** 获取自动观察缓存，首次探测异步完成且多个请求共享同一任务。 */
  async function getProfile(context = {}) {
    if (active && Date.now() - Date.parse(active.detectedAt) <= TTL) return active;
    if (!loading) loading = (async () => {
      await migrate();
      active = await loadCache();
      if (!active) { active = await detect(context); await atomicJson(cachePath, active); }
      return active;
    })().finally(() => { loading = null; });
    return loading;
  }

  /** 只刷新自动观察值，人工策略单独保存且不受 TTL 影响。 */
  async function refresh(context = {}) {
    await migrate();
    const fresh = await detect(context);
    await atomicJson(cachePath, fresh);
    active = fresh;
    return fresh;
  }

  /** 解析显式策略与人工覆盖；未知目录在写入前用独立样本探测。 */
  async function strategy(file, requested = 'auto', context = {}) {
    const ext = path.extname(file).toLowerCase();
    const override = await getOverride(ext);
    if (requested === 'preserve' || (requested === 'auto' && override === 'protected')) return { mode: 'preserve', category: 'user_protected', extension: ext };
    if (requested === 'plaintext' || (requested === 'auto' && override === 'unsafe')) return { mode: 'plaintext', category: 'user_unsafe', extension: ext };
    const p = await getProfile(context);
    const dir = await fs.realpath(path.dirname(file));
    const key = dir + '|' + ext;
    let category = p.scopes[key];
    if (!category) {
      category = await classify(ext || '.mcp-noext', dir, p, context);
      if (category === 'unknown' && (p.unsafeExtensions.includes(ext) || p.encryptedExtensions.includes(ext))) category = 'unsafe';
      p.scopes[key] = category;
    }
    return { mode: category === 'unsafe' ? 'plaintext' : category === 'protected' ? 'preserve' : 'auto', category, extension: ext, scope: dir };
  }

  /** 校验 Node 可见内容和原始磁盘状态，unknown 从不声称已验证明文。 */
  async function verify(file, expected, mode, context = {}) {
    const own = await fingerprint(file, context);
    if (own.hash !== expected.hash || own.size !== expected.size) throw fault('CONTENT_MISMATCH', '写入内容校验不一致');
    if (mode === 'preserve') return { contentVerified: true, diskState: 'preserved', diskVerified: false };
    const p = await getProfile(context);
    const raw = await reader(p.byteReader, file, context);
    if (!raw) {
      if (mode === 'plaintext' || p.byteReader) throw fault('DISK_UNVERIFIED', '无法验证磁盘明文状态，保留原文件');
      return { contentVerified: true, diskState: 'unknown', diskVerified: false };
    }
    if (raw.hash !== expected.hash || raw.size !== expected.size) throw fault('DISK_MISMATCH', '磁盘字节与预期明文不一致');
    return { contentVerified: true, diskState: 'plaintext', diskVerified: true };
  }

  /** 为目标生成可校验的暂存文件；所有候选失败即中止，禁止回退破坏原文。 */
  async function prepare(stage, write, expected, decision, context = {}) {
    if (decision.mode !== 'plaintext') {
      await write(stage);
      try { return await verify(stage, expected, decision.mode, context); }
      catch (error) { if (error.code !== 'DISK_MISMATCH' || decision.mode === 'preserve') throw error; }
      await fs.rm(stage, { force: true });
    }
    const p = await getProfile(context);
    if (!p.byteReader) throw fault('DISK_UNVERIFIED', '强制明文写入需要可用的独立磁盘读取器');
    const errors = [];
    for (const ext of [...new Set(p.safeExtensions.concat(SAFE_CANDIDATES))]) {
      checkBudget(context.signal, context.deadline);
      const temp = path.join(path.dirname(stage), '.mcp-safe-' + crypto.randomUUID() + ext);
      try {
        await write(temp);
        try { await verify(temp, expected, 'plaintext', context); }
        catch (error) { errors.push(error.code); continue; }
        for (const proc of p.availableProcesses) {
          checkBudget(context.signal, context.deadline);
          try {
            await copier(proc.id, temp, stage, context);
            const result = await verify(stage, expected, 'plaintext', context);
            return { ...result, via: { extension: ext, process: proc.id } };
          } catch (error) { errors.push(error.code || error.message); await fs.rm(stage, { force: true }); }
        }
      } finally { await fs.rm(temp, { force: true }); }
    }
    throw fault('SAFE_WRITE_FAILED', '安全写入组合全部失败，原文件保持不变', { reasons: errors.slice(0, 10) });
  }

  /** 返回诊断信息与持久手工策略，避免把用户标注藏在自动分类里。 */
  async function summary(context = {}) {
    const p = await getProfile(context);
    const overrides = [];
    for (const entry of await fs.readdir(policyDir, { withFileTypes: true })) {
      if (!/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
      const data = JSON.parse(await fs.readFile(path.join(policyDir, entry.name), 'utf8'));
      if (data.category !== 'clear') overrides.push(data);
    }
    return { ...p, cachePath, policyDir, overrides };
  }

  return { stateDir, cachePath, policyDir, loadCache, getProfile, refresh, mark, getOverride, strategy, verify, prepare, summary };
}

module.exports = { createEncryption, inspectDisk, externalCopy, execute, atomicJson, extension };
