#!/usr/bin/env node
/**
 * MCP Server: 文件操作工具集（加密软件环境明文读写）
 *
 * 通用场景：当电脑安装了文件加密软件（如天锐绿盾、IP-Guard、亿赛通等），
 * 且 Node.js 进程被列为白名单（受信任进程）时，fs.readFileSync / fs.writeFileSync
 * 可自动解密/加密，读到明文。而 Claude Code CLI 内置工具（Read/Write/Edit/Grep）
 * 是独立进程，不在白名单内，只能读到密文。
 *
 * 本 MCP Server 通过 Node.js 进程提供文件读写工具，替代 Claude Code 内置工具，
 * 适用于任何「Node.js 是加密软件白名单进程」的场景。
 *
 * 提供工具：
 *   - read_file          读取单个文件明文（替代内置 Read，大文件自动截断）
 *   - read_files         批量读取多个文件明文
 *   - read_file_partial  局部读取文件（前N字符 / 指定行范围）
 *   - write_file         写入文件，自动加密落盘（替代内置 Write，支持 append / 行尾风格 / BOM 保留）
 *   - edit_file          精确字符串/正则替换后写回（替代内置 Edit/MultiEdit，CRLF/LF 自动兼容）
 *   - search_files       递归搜索文件内容（替代内置 Grep，支持 ** 目录通配、跳过二进制/超大文件）
 *   - find_files         按文件名 glob 递归查找文件（替代内置 Glob）
 *   - list_directory     列出目录内容（替代内置 LS）
 *   - copy_path          复制文件或目录（替代 bash cp，加密环境必须经白名单进程）
 *   - move_path          移动/重命名文件或目录（替代 bash mv）
 *   - remove_path        删除文件或目录（替代 bash rm）
 *   - create_directory   递归创建目录
 *   - file_info          查询文件/目录信息
 *   - check_status       检查工具运行状态（可实测解密能力）
 *   - encryption_profile 查看环境探测结果（扩展名分类/可用进程/最佳组合）
 *   - refresh_profile    强制重新探测环境并更新缓存
 *   - mark_extension     手动标注扩展名写入策略（protected 保持加密 / unsafe 保持明文 / clear 清除标注）
 *
 * 环境自适应（1.7.0）：加密软件按目标扩展名决定是否透明加密且各机策略不同，
 * 本 Server 首次启动时自动探测本机扩展名分类（safe/protected/unsafe）与可用
 * 外部进程（powershell/cmd/robocopy 等），unsafe 扩展名走 safeWrite 中转落盘，
 * 探测结果按 machineId 缓存到 ~/.mcp-encryption-profile.json，换机自动重探。
 *
 * 写入后实时重分类（1.8.0）：启动探测只给先验分类，且 Node.js 白名单读回无法
 * 区分「真受控」与「伪受控」。所有直写路径完成后用外部进程读磁盘原始字节实测：
 * 磁盘为密文（命中 %TSD 魔数）→ 自动将该扩展名重分类为 encrypted 并立即用
 * safeWrite 重写为明文；磁盘为明文 → 重分类为 safe。用户可用 mark_extension
 * 手动标注 protected（保持加密，跳过自动纠正）或 unsafe（强制 safeWrite）。
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = require("zod");

// 版本号读取自 package.json，与发布版本保持同步，避免硬编码漂移
const pkg = require("./package.json");
const server = new McpServer({ name: "read-file-server", version: pkg.version });

// read_file / read_files 返回内容的安全上限：超过则截断，避免撑爆 Agent 上下文
const READ_MAX_CHARS = 400000;
// search_files 单文件扫描上限：超过则跳过该文件（超大日志/minified 产物）
const SCAN_MAX_BYTES = 5 * 1024 * 1024;
// search_files 嗅探二进制的采样字节数：首块含 NUL 即视为二进制
const BINARY_SNIFF_BYTES = 8192;

/**
 * 检测 buffer 是否为 UTF-16 文件（BOM FF FE / FE FF，或前若干字节呈现 NUL 交替特征）。
 * 用于读工具拒绝按 UTF-8 处理 UTF-16 文件（静默乱码 + edit 写回即损坏）。
 */
function looksUtf16(buf) {
  if (buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) return true;
  // 无 BOM 启发式：ASCII 内容的 UTF-16LE 呈现「可打印字节与 NUL 交替」
  const len = Math.min(buf.length, 256);
  let pairs = 0, alt = 0;
  for (let i = 0; i + 1 < len; i += 2) {
    pairs++;
    if ((buf[i] !== 0 && buf[i + 1] === 0) || (buf[i] === 0 && buf[i + 1] !== 0)) alt++;
  }
  return pairs >= 4 && alt / pairs > 0.8;
}

/**
 * 检测 UTF-8 文本是否含大量替换字符（非法字节序列被解码的产物），
 * 用于 edit_file 拒绝写回疑似非 UTF-8（GBK 等）内容，防止不可逆损坏。
 */
function isLikelyNonUtf8(text) {
  if (text.length < 100) return false;
  let bad = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 0xfffd) bad++;
  }
  return bad / text.length > 0.01; // >1% 替换字符即判定
}

/**
 * 读取文件明文内容并做大文件与 BOM 处理（预算读取实现）。
 * - maxChars 限制返回字符数：先按 UTF-8 最多 4 字节/字符的关系将预算换算为字节数，
 *   只读需要的字节数；截断时用明文字节数报告真实体量，避免 readFileSync 全量载入
 * - 剥离 UTF-8 BOM 并记录，写回工具据此外决定是否补回，避免 oldString 匹配失败与 BOM 丢失
 * 返回 { ok, content, size, truncated, hasBom, totalChars }，失败返回 { ok:false, error }。
 */
function readFileContent(filePath, maxChars) {
  try {
    const limit = maxChars || Infinity;
    // UTF-8 变长编码（1-4 字节/字符）：预算字节数 = 上限字符数 × 4，保证解码后至少有 limit 个字符。
    // 预算同时兼作 UTF-16 嗅探（首字节特征），一次 IO 完成（无限制场景也先嗅 4KB）
    const budgetBytes = limit === Infinity ? 4096 : limit * 4;
    const pref = readFilePrefix(filePath, budgetBytes);
    if (!pref.ok) return pref;
    // UTF-16 防护：按 UTF-8 解码 UTF-16 文件会产生大量乱码，且 edit_file 写回会损坏
    // 原文件。嗅探首块命中则直接拒绝并给出明确指引。
    if (looksUtf16(pref.firstBytes)) {
      return { ok: false, error: "文件疑似 UTF-16 编码（检测到 UTF-16 BOM 或字节特征），本工具仅支持 UTF-8，请先转换为 UTF-8 再操作: " + filePath };
    }
    let content = pref.text;
    const hasBom = content.charCodeAt(0) === 0xfeff;
    if (hasBom) content = content.slice(1);
    if (!pref.isTruncated) {
      // 整个文件都在预算内：无截断。但字符数可能仍超 limit（预算按4字节/字符放大），
      // 此时按 limit 截断字符（文件已全部读入，totalChars 可精确报告）
      if (limit !== Infinity && content.length > limit) {
        return { ok: true, content: content.slice(0, limit), size: Buffer.byteLength(content, "utf-8"), truncated: true, hasBom, totalChars: content.length };
      }
      const size = Buffer.byteLength(content, "utf-8");
      return { ok: true, content, size, truncated: false, hasBom, totalChars: content.length };
    }
    if (limit === Infinity) {
      // 无限制场景（edit_file 等）预算只是嗅探：文件超 4KB 需全量补读
      content = content + fs.readFileSync(filePath, "utf-8").slice(content.length + (hasBom ? 1 : 0));
      return { ok: true, content, size: Buffer.byteLength(content, "utf-8"), truncated: false, hasBom, totalChars: content.length };
    }
    // 预算内读满仍可能没读全文件：截断到 limit 字符。
    // 预算按「最多4字节/字符」换算，正常文本截断点落在字符边界；若末字符恰为 U+FFFD，
    // 说明字节边界被切断，回退一位丢弃半个字符（多字节 UTF-8 中合法 U+FFFD 极罕见，可接受）
    let end = limit;
    if (end < content.length) {
      const code = content.charCodeAt(end - 1);
      if (code >= 0xd800 && code <= 0xdbff) end++; // 代理对保护
      else if (code === 0xfffd) end = Math.max(1, end - 1);
    }
    content = content.slice(0, end);
    // 明文总字节数：stat.size 是密文字节数不可用；截断场景用已读字节数做下界估计
    return { ok: true, content, size: pref.bytesRead, truncated: true, hasBom, totalChars: null, bytesRead: pref.bytesRead };
  } catch (e) {
    if (e.code === "ENOENT") {
      return { ok: false, error: "文件不存在: " + filePath };
    }
    if (e.code === "EISDIR") {
      return { ok: false, error: "路径是目录而非文件: " + filePath };
    }
    return { ok: false, error: "读取失败（可能是密文，请确认 Node.js 是否被加密软件列为白名单进程）: " + e.message };
  }
}

/**
 * 将 glob 模式编译为正则：支持 *（不含路径分隔符）、**（跨目录任意字符）、?（单字符）、
 * {a,b} 花括号展开（如 *.{ts,tsx}）。统一使用 / 作为路径分隔符（匹配前已把
 * Windows 的 \ 归一），与 Agent 的 glob 习惯一致。
 */
function globToRegex(glob) {
  // 先展开花括号 {a,b} -> (a|b)，支持一层嵌套场景（**/{src,test}/** 等）
  let expanded = glob;
  const brace = /\{([^{}]*,[^{}]*)\}/;
  let guard = 0;
  while (brace.test(expanded) && guard++ < 10) {
    expanded = expanded.replace(brace, (_m, inner) => "(" + inner.split(",").map((s) => s.trim()).join("|") + ")");
  }
  let re = "";
  for (let i = 0; i < expanded.length; i++) {
    const ch = expanded[i];
    if (ch === "*") {
      if (expanded[i + 1] === "*") {
        // ** 跨目录任意匹配（连同后随的 / 一并吞掉，避免空段）
        re += ".*";
        i++;
        if (expanded[i + 1] === "/") i++;
      } else {
        // * 不跨目录
        re += "[^/]*";
      }
    } else if (ch === "(") {
      // 花括号展开产生的分组 (a|b)：整段原样保留到闭括号，跳过其中字符的转义
      const close = expanded.indexOf(")", i);
      if (close === -1) {
        re += "\\(";
      } else {
        // 组内允许含 * 与 ? 通配，递归编译组内每个分支后重组
        const inner = expanded.slice(i + 1, close);
        const branches = inner.split("|").map((b) => globToRegex(b).source.replace(/^\^|\$$/g, ""));
        re += "(" + branches.join("|") + ")";
        i = close;
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else if (/[.+^${}()|[\]\\]/.test(ch)) {
      re += "\\" + ch;
    } else {
      re += ch;
    }
  }
  return new RegExp("^" + re + "$");
}

/**
 * 判断 buffer 首块是否含二进制特征（NUL 字节），用于 search_files 跳过图片/exe 等。
 */
function isBinaryBuffer(buf) {
  const len = Math.min(buf.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/**
 * 预算读取：只读文件前 budgetBytes 字节并按 UTF-8 增量解码。
 * 用于大文件截断与二进制嗅探场景，避免 readFileSync 全量载入（读 1GB 文件
 * 只为返回前 40 万字符的内存浪费）。解码在字节边界截断时，截断的末字符
 * 会退化为 U+FFFD，因此调用方必须显式传入 isTruncated 判定（截断才可信）。
 * 返回 { ok, text, bytesRead, isTruncated, firstBytes }，失败返回 { ok:false, error }。
 */
function readFilePrefix(filePath, budgetBytes) {
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
    const chunks = [];
    let total = 0;
    const chunk = Buffer.allocUnsafe(Math.min(budgetBytes, 1024 * 1024));
    while (total < budgetBytes) {
      const want = Math.min(chunk.length, budgetBytes - total);
      const n = fs.readSync(fd, chunk, 0, want, null);
      if (n <= 0) break;
      chunks.push(Buffer.from(chunk.subarray(0, n)));
      total += n;
    }
    const buf = Buffer.concat(chunks);
    return {
      ok: true,
      text: buf.toString("utf-8"),
      bytesRead: total,
      isTruncated: total >= budgetBytes,
      firstBytes: buf,
    };
  } catch (e) {
    if (e.code === "ENOENT") return { ok: false, error: "文件不存在: " + filePath };
    if (e.code === "EISDIR") return { ok: false, error: "路径是目录而非文件: " + filePath };
    return { ok: false, error: "读取失败（可能是密文，请确认 Node.js 是否被加密软件列为白名单进程）: " + e.message };
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (e) { /* 忽略关闭失败 */ } }
  }
}

// ==================== 环境自适应探测（加密策略感知，1.7.0 新增） ====================
// 背景：加密软件按「目标文件扩展名」决定是否透明加密，且不同电脑策略不同：
//   safe      写入后磁盘为明文（任何设备可读）
//   protected 写入后磁盘为密文，但 Node.js 白名单读回 == 写入内容（本机自动解密）
//   unsafe    写入后磁盘为密文，且 Node.js 读回 != 写入内容（本机也无法解密，乱码）
// unsafe 扩展名的写入必须走 safeWrite：先写安全扩展名临时文件（磁盘明文），
// 再由可用外部进程（非白名单进程，复制不触发透明加密）复制到目标路径。
// 探测结果按 machineId 缓存，换电脑/缓存过期自动重新探测，不硬编码任何结论。

// 探测结果缓存文件（绑定机器，machineId 不一致即重新探测）
const PROFILE_CACHE_PATH = path.join(os.homedir(), ".mcp-encryption-profile.json");
// 缓存有效期：30 天（加密策略可能被管理员调整，过期自动重探）
const PROFILE_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// 缓存结构版本：结构变更时递增，旧缓存自动作废
// v2：新增 encryptedExtensions（写入后实测磁盘为密文的扩展名）、
//     userProtectedExtensions（用户手动标注保持加密）、postWriteDetectionEnabled
const PROFILE_CACHE_VERSION = 2;
// 候选「安全扩展名」探测清单：仅为探测对象，实测分类因机而异，不做任何硬编码结论
const PROBE_SAFE_CANDIDATES = [".tmp", ".md", ".txt", ".log", ".dat", ".bak", ".cache", ".temp", ".mcp_tmp"];
// 候选「其他常见扩展名」探测清单：用于完整分类与交叉验证时寻找 unsafe 样例
const PROBE_OTHER_CANDIDATES = [".java", ".xml", ".js", ".ts", ".py", ".html", ".json", ".scss", ".css", ".less", ".yaml", ".sql"];
// 探测内容：长度刻意避开 4096/8192 等加密块对齐值，
// 使「物理大小 != 内容字节数」成为可靠的密文信号（TSD 密文按固定块大小落盘）
const PROBE_CONTENT = "mcp-encryption-probe|" + "0123456789abcdef".repeat(9) + "|eol\n";
const PROBE_BYTES = Buffer.byteLength(PROBE_CONTENT, "utf-8");
const PROBE_HEX_PREFIX = Buffer.from(PROBE_CONTENT, "utf-8").subarray(0, 16).toString("hex");
// TSD 加密文件头魔数（%TSD = 25 54 53 44），作为外部进程读原始字节时的密文佐证
const TSD_MAGIC_HEX = "25545344";
// 候选外部进程清单：exe 仅作探测对象，可用性实测决定（部分机器 MCP Server 可能无法 spawn）
const PROCESS_CANDIDATES = [
  { id: "powershell", exe: "powershell.exe", canReadBytes: true },
  { id: "pwsh", exe: "pwsh.exe", canReadBytes: true },
  { id: "cmd", exe: "cmd.exe", canReadBytes: false },
  { id: "robocopy", exe: "robocopy.exe", canReadBytes: false },
  { id: "cscript", exe: "cscript.exe", canReadBytes: false },
];
// 探测文件命名计数器，保证同一临时目录内文件名唯一
let probeFileCounter = 0;

/**
 * 计算机器指纹：hostname + username 的 SHA-256 截断值。
 * 用于绑定探测缓存，换电脑（或换用户）时缓存自动失效并重新探测。
 */
function getMachineId() {
  let username = "";
  try { username = os.userInfo().username; } catch (e) { /* 取不到用户名时仅按 hostname 区分 */ }
  return crypto.createHash("sha256").update(os.hostname() + "|" + username).digest("hex").slice(0, 16);
}

/**
 * 读取探测结果缓存。校验结构版本、machineId 与有效期，任一不满足返回 null（触发重探）。
 * 缓存文件损坏/不可读时同样返回 null，不影响启动。
 */
function loadProfileCache() {
  try {
    const raw = fs.readFileSync(PROFILE_CACHE_PATH, "utf-8");
    const p = JSON.parse(raw);
    if (!p || p.version !== PROFILE_CACHE_VERSION) return null;
    if (p.machineId !== getMachineId()) return null; // 换电脑/换用户
    if (!p.detectedAt || Date.now() - new Date(p.detectedAt).getTime() > PROFILE_CACHE_TTL_MS) return null;
    if (!Array.isArray(p.safeExtensions) || !Array.isArray(p.availableProcesses)) return null;
    // v2 新增字段兜底初始化（防手工编辑缓存导致字段缺失）
    if (!Array.isArray(p.encryptedExtensions)) p.encryptedExtensions = [];
    if (!Array.isArray(p.userProtectedExtensions)) p.userProtectedExtensions = [];
    if (p.postWriteDetectionEnabled === undefined) p.postWriteDetectionEnabled = true;
    return p;
  } catch (e) {
    return null;
  }
}

/**
 * 持久化探测结果到缓存文件（best-effort：写失败仅影响下次启动重探，不阻断运行）。
 */
function saveProfileCache(profile) {
  try {
    fs.writeFileSync(PROFILE_CACHE_PATH, JSON.stringify(profile, null, 2), "utf-8");
  } catch (e) { /* 缓存写失败可忽略，下次启动重新探测 */ }
}

/**
 * PowerShell 单引号字符串转义：单引号按 ''  doubling，防路径含引号时命令注入/断裂。
 */
function psQuote(p) {
  return "'" + String(p).replace(/'/g, "''") + "'";
}

/**
 * 通过外部进程（powershell/pwsh）读取文件磁盘原始字节的前 byteCount 字节（十六进制小写）。
 * 外部进程不在加密软件白名单内，读到的是磁盘真实字节（密文文件即密文头部），
 * 这是「磁盘是否密文」最可靠的判据。进程不可用/执行失败/输出异常时返回 null（未知），
 * 调用方需退化为其他判据（物理大小对比、Node 读回对比）。
 */
function externalReadHexPrefix(procId, filePath, byteCount) {
  const exe = procId === "pwsh" ? "pwsh.exe" : "powershell.exe";
  const cmd = "$b=[System.IO.File]::ReadAllBytes(" + psQuote(filePath) + ");" +
    "$n=[Math]::Min($b.Length," + byteCount + ");" +
    "if($n -gt 0){[BitConverter]::ToString($b[0..($n-1)])}";
  try {
    const r = spawnSync(exe, ["-NoProfile", "-NonInteractive", "-Command", cmd], { timeout: 10000, windowsHide: true, encoding: "utf-8" });
    if (r.error || r.status !== 0) return null; // EPERM/超时/策略拦截均按未知处理
    const hex = String(r.stdout || "").trim().replace(/-/g, "").toLowerCase();
    return /^[0-9a-f]*$/.test(hex) ? hex : null;
  } catch (e) {
    return null;
  }
}

/**
 * cscript 复制脚本路径（懒初始化）：JScript 内容用安全扩展名临时文件落盘，
 * 通过 //E:JScript 强制指定脚本引擎（不受临时文件扩展名限制）。
 */
let cscriptHelperPath = null;
function getCscriptHelperPath() {
  if (cscriptHelperPath && fs.existsSync(cscriptHelperPath)) return cscriptHelperPath;
  const p = path.join(os.tmpdir(), "mcp-enc-copy-" + process.pid + ".tmp");
  fs.writeFileSync(p, 'var f=new ActiveXObject("Scripting.FileSystemObject");f.CopyFile(WScript.Arguments(0),WScript.Arguments(1),true);', "utf-8");
  cscriptHelperPath = p;
  return p;
}

/**
 * 用指定外部进程将 src 复制为 dst（dst 可不同名）。复制动作由非白名单进程执行，
 * 不触发加密软件的透明加密，从而把「安全扩展名的明文临时文件」落到 unsafe 扩展名目标上。
 * 各进程参数差异在内部抹平：robocopy 不支持改名（复制后由 fs.renameSync 改名，
 * rename 不重写文件内容，不触发加密）；cmd 用 copy /y；cscript 走 JScript FileSystemObject。
 * 失败抛出 Error（含进程退出码/错误信息），成功返回 undefined。
 */
function externalCopyFile(procId, src, dst) {
  const opts = { timeout: 20000, windowsHide: true, encoding: "utf-8" };
  if (procId === "powershell" || procId === "pwsh") {
    const exe = procId === "powershell" ? "powershell.exe" : "pwsh.exe";
    const r = spawnSync(exe, ["-NoProfile", "-NonInteractive", "-Command",
      "Copy-Item -LiteralPath " + psQuote(src) + " -Destination " + psQuote(dst) + " -Force"], opts);
    if (r.error) throw r.error;
    if (r.status !== 0) throw new Error(procId + " 退出码 " + r.status + ": " + String(r.stderr || "").slice(0, 200));
  } else if (procId === "cmd") {
    // windowsVerbatimArguments：参数含空格时 Node 默认会再加一层引号，
    // 导致 cmd /c 收到嵌套引号解析失败（"文件名、目录名或卷标语法不正确"）
    const r = spawnSync("cmd.exe", ["/c", 'copy /y "' + src + '" "' + dst + '"'], Object.assign({}, opts, { windowsVerbatimArguments: true }));
    if (r.error) throw r.error;
    if (r.status !== 0) throw new Error("cmd 退出码 " + r.status + ": " + String(r.stderr || r.stdout || "").slice(0, 200));
  } else if (procId === "robocopy") {
    // robocopy 语义为「目录到目录 + 文件名」，不支持目标改名；退出码 0-7 均为成功
    const r = spawnSync("robocopy.exe", [path.dirname(src), path.dirname(dst), path.basename(src),
      "/NFL", "/NDL", "/NJH", "/NJS", "/NC", "/NS", "/NP"], opts);
    if (r.error) throw r.error;
    if (r.status === null || r.status >= 8) throw new Error("robocopy 退出码 " + r.status);
    const copied = path.join(path.dirname(dst), path.basename(src));
    if (path.resolve(copied) !== path.resolve(dst)) {
      fs.renameSync(copied, dst); // 改名不落盘内容，安全
    }
  } else if (procId === "cscript") {
    const r = spawnSync("cscript.exe", ["//nologo", "//E:JScript", getCscriptHelperPath(), src, dst], opts);
    if (r.error) throw r.error;
    if (r.status !== 0) throw new Error("cscript 退出码 " + r.status + ": " + String(r.stderr || r.stdout || "").slice(0, 200));
  } else {
    throw new Error("未知进程类型: " + procId);
  }
  if (!fs.existsSync(dst)) throw new Error(procId + " 复制后目标文件不存在");
}

/**
 * 分类单个扩展名：在指定目录写入探测文件，通过三重交叉验证判断磁盘状态。
 * 判定逻辑：
 *   ① Node 读回 != 写入内容 → 必为密文且无法解密（unsafe）
 *   ② 读回一致时，外部进程读磁盘原始字节 != 写入前缀（或命中 %TSD 魔数）→ protected
 *   ③ 无字节读取器时退化用物理大小对比：stat.size != 内容字节数 → protected
 *   ④ 以上均不命中 → safe（磁盘明文）
 * readerProcId 为 null 时跳过方式②（进程不可用环境自动降级）。
 */
function classifyExtension(ext, readerProcId, probeDir) {
  const dir = probeDir || os.tmpdir();
  const f = path.join(dir, "mcp-cls-" + process.pid + "-" + (++probeFileCounter) + ext);
  try {
    fs.writeFileSync(f, PROBE_CONTENT, "utf-8");
    let readBack = null;
    try { readBack = fs.readFileSync(f, "utf-8"); } catch (e) { /* 读回失败按不可解密处理 */ }
    let encrypted = readBack !== PROBE_CONTENT; // 判据①：读回不一致即密文（且不可解密）
    if (!encrypted) {
      if (readerProcId) {
        // 判据②：磁盘原始字节对比（最可靠，通用）+ %TSD 魔数（佐证）
        const hex = externalReadHexPrefix(readerProcId, f, 16);
        if (hex !== null) {
          encrypted = hex !== PROBE_HEX_PREFIX || hex.slice(0, 8) === TSD_MAGIC_HEX;
        } else {
          encrypted = isSizeAnomaly(f);
        }
      } else {
        // 判据③：物理大小对比（无外部进程可用时的降级方案）
        encrypted = isSizeAnomaly(f);
      }
    }
    if (!encrypted) return "safe";
    return readBack === PROBE_CONTENT ? "protected" : "unsafe";
  } finally {
    try { fs.rmSync(f, { force: true }); } catch (e) { /* 清理失败可忽略 */ }
  }
}

/**
 * 物理大小异常检测：探测内容长度刻意避开加密块对齐值，
 * stat.size 与内容字节数不一致即说明落盘的是密文（TSD 密文按固定块大小落盘）。
 */
function isSizeAnomaly(filePath) {
  try {
    return fs.statSync(filePath).size !== PROBE_BYTES;
  } catch (e) {
    return false; // stat 失败按非密文处理（后续读回对比兜底）
  }
}

/**
 * 探测单个外部进程的复制能力：用已知安全扩展名的明文文件做一次真实复制，
 * 并以 Node 读回验证复制产物内容一致（进程可能被策略拦截 spawn EPERM，或能启动但写盘受限）。
 */
function probeCopier(spec, safeExt, probeDir) {
  const src = path.join(probeDir, "proc-src" + safeExt);
  const dst = path.join(probeDir, "proc-dst" + safeExt);
  try {
    fs.writeFileSync(src, PROBE_CONTENT, "utf-8");
    externalCopyFile(spec.id, src, dst);
    return fs.readFileSync(dst, "utf-8") === PROBE_CONTENT;
  } catch (e) {
    return false;
  } finally {
    try { fs.rmSync(src, { force: true }); } catch (e) { /* 忽略 */ }
    try { fs.rmSync(dst, { force: true }); } catch (e) { /* 忽略 */ }
  }
}

/**
 * 探测外部进程的原始字节读取能力：读一个已知明文文件的前 16 字节，
 * 输出与期望前缀完全一致才认为可用（防止进程能启动但输出被策略篡改/为空）。
 */
function probeReader(procId, safeExt, probeDir) {
  const f = path.join(probeDir, "reader" + safeExt);
  try {
    fs.writeFileSync(f, PROBE_CONTENT, "utf-8");
    return externalReadHexPrefix(procId, f, 16) === PROBE_HEX_PREFIX;
  } catch (e) {
    return false;
  } finally {
    try { fs.rmSync(f, { force: true }); } catch (e) { /* 忽略 */ }
  }
}

/**
 * 交叉验证一组「安全扩展名 + 外部进程」组合：
 * 将安全扩展名的明文文件经外部进程复制为 unsafe 扩展名目标，
 * Node 读回与写入一致即证明该组合可在 unsafe 扩展名上落盘明文
 * （unsafe 扩展名若被透明加密，Node 读回必不一致）。
 */
function crossValidateCombo(safeExt, procId, unsafeExt, probeDir) {
  const src = path.join(probeDir, "xv-src" + safeExt);
  const dst = path.join(probeDir, "xv-dst-" + (++probeFileCounter) + unsafeExt);
  try {
    fs.writeFileSync(src, PROBE_CONTENT, "utf-8");
    externalCopyFile(procId, src, dst);
    return fs.readFileSync(dst, "utf-8") === PROBE_CONTENT;
  } catch (e) {
    return false;
  } finally {
    try { fs.rmSync(src, { force: true }); } catch (e) { /* 忽略 */ }
    try { fs.rmSync(dst, { force: true }); } catch (e) { /* 忽略 */ }
  }
}

/**
 * 环境探测主函数：在系统临时目录执行全部探测（不污染用户目录），返回 profile 对象。
 * 流程：① 无进程粗分类安全候选，找到至少一个 safe 扩展名（供进程探测造文件）
 *       ② 逐个探测外部进程的复制/字节读取能力
 *       ③ 用字节读取器（若有）对全部候选扩展名做精确分类
 *       ④ 交叉验证「safe 扩展名 × 可用进程」组合，确定 bestCombo
 * 任何单步失败都降级处理，保证返回结构完整的 profile（可能为空列表）。
 */
function detectEnvironment() {
  const profile = {
    version: PROFILE_CACHE_VERSION,
    machineId: getMachineId(),
    detectedAt: new Date().toISOString(),
    safeExtensions: [],
    protectedExtensions: [],
    unsafeExtensions: [],
    encryptedExtensions: [],
    userProtectedExtensions: [],
    postWriteDetectionEnabled: true,
    availableProcesses: [],
    byteReader: null,
    bestCombo: null,
  };
  let probeDir = null;
  try {
    probeDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-enc-probe-"));
    // ① 粗分类安全候选（无字节读取器，用大小+读回对比），找到第一个 safe 即停
    let firstSafe = null;
    for (const ext of PROBE_SAFE_CANDIDATES) {
      let cat;
      try { cat = classifyExtension(ext, null, probeDir); } catch (e) { continue; }
      if (cat === "safe") { firstSafe = ext; break; }
    }
    // ② 探测外部进程（需要 safe 扩展名造明文测试文件；无 safe 则进程探测无意义）
    if (firstSafe) {
      for (const spec of PROCESS_CANDIDATES) {
        try {
          if (probeCopier(spec, firstSafe, probeDir)) {
            profile.availableProcesses.push({ id: spec.id, exe: spec.exe });
            if (spec.canReadBytes && !profile.byteReader && probeReader(spec.id, firstSafe, probeDir)) {
              profile.byteReader = spec.id;
            }
          }
        } catch (e) { /* 单个进程探测失败不影响其他候选 */ }
      }
    }
    // ③ 精确分类全部候选扩展名（有字节读取器时结果最可靠）
    for (const ext of PROBE_SAFE_CANDIDATES.concat(PROBE_OTHER_CANDIDATES)) {
      let cat;
      try { cat = classifyExtension(ext, profile.byteReader, probeDir); } catch (e) { continue; }
      if (cat === "safe") profile.safeExtensions.push(ext);
      else if (cat === "protected") profile.protectedExtensions.push(ext);
      else profile.unsafeExtensions.push(ext);
    }
    // ④ 交叉验证找最佳组合（无 unsafe 扩展名时无需 bestCombo，全部直写即可）
    if (profile.unsafeExtensions.length && profile.availableProcesses.length && profile.safeExtensions.length) {
      const unsafeExt = profile.unsafeExtensions[0];
      let found = null;
      for (const ext of profile.safeExtensions) {
        for (const proc of profile.availableProcesses) {
          try {
            if (crossValidateCombo(ext, proc.id, unsafeExt, probeDir)) { found = { extension: ext, process: proc.id }; break; }
          } catch (e) { /* 继续下一组合 */ }
        }
        if (found) break;
      }
      profile.bestCombo = found;
    }
  } catch (e) {
    profile.detectError = e.message; // 整体探测失败也返回结构完整 profile
  } finally {
    if (probeDir) { try { fs.rmSync(probeDir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ } }
  }
  return profile;
}

// 内存中缓存的活动 profile（避免每次写入都读盘/探测）
let activeProfile = null;

/**
 * 获取当前环境 profile（懒加载）：优先内存，其次磁盘缓存（校验 machineId/有效期），
 * 最后执行完整探测并落盘缓存。任何环节失败都返回结构完整的降级 profile，绝不阻断工具调用。
 */
function getProfile() {
  if (activeProfile) return activeProfile;
  const cached = loadProfileCache();
  if (cached) { activeProfile = cached; return activeProfile; }
  try {
    activeProfile = detectEnvironment();
    saveProfileCache(activeProfile);
  } catch (e) {
    // 探测整体异常时的兜底 profile：全部直写（保持 1.6.0 原始行为）
    activeProfile = {
      version: PROFILE_CACHE_VERSION, machineId: getMachineId(), detectedAt: new Date().toISOString(),
      safeExtensions: [], protectedExtensions: [], unsafeExtensions: [],
      encryptedExtensions: [], userProtectedExtensions: [], postWriteDetectionEnabled: true,
      availableProcesses: [], byteReader: null, bestCombo: null, detectError: e.message,
    };
  }
  // 防御：任何来源的 profile 都补齐 v2 字段（防手工编辑缓存/未来降级路径遗漏）
  if (!Array.isArray(activeProfile.encryptedExtensions)) activeProfile.encryptedExtensions = [];
  if (!Array.isArray(activeProfile.userProtectedExtensions)) activeProfile.userProtectedExtensions = [];
  if (activeProfile.postWriteDetectionEnabled === undefined) activeProfile.postWriteDetectionEnabled = true;
  return activeProfile;
}

/**
 * 查询扩展名分类（写入前调用）：先查 profile 已知列表；未知扩展名按需即时探测，
 * 结果并入 profile 并 best-effort 持久化（同一扩展名只探测一次）。
 * targetDir 为目标文件所在目录：加密策略可能按目录范围生效（如系统临时目录常被排除），
 * 按需探测优先在目标目录内进行（探测文件立即删除），不可写时回退系统临时目录。
 */
function classifyExtForWrite(ext, targetDir) {
  const p = getProfile();
  if (p.safeExtensions.indexOf(ext) !== -1) return "safe";
  if (p.protectedExtensions.indexOf(ext) !== -1) return "protected";
  if (p.unsafeExtensions.indexOf(ext) !== -1) return "unsafe";
  let cat = "safe"; // 探测异常时默认直写（保持原始行为）
  // 探测目录：优先目标目录（策略按目录生效时结果才准确），不可写则回退 os.tmpdir()
  let probeDir = null;
  if (targetDir) {
    try { fs.accessSync(targetDir, fs.constants.W_OK); probeDir = targetDir; } catch (e) { /* 回退 tmpdir */ }
  }
  try {
    cat = classifyExtension(ext, p.byteReader, probeDir);
  } catch (e) { /* 探测失败按 safe 直写处理 */ }
  const listKey = cat + "Extensions";
  if (Array.isArray(p[listKey]) && p[listKey].indexOf(ext) === -1) {
    p[listKey].push(ext);
    saveProfileCache(p);
  }
  return cat;
}

/**
 * 写入后实时检测目标文件的磁盘真实状态，并按结果更新扩展名分类（1.8.0 新增）。
 * 动机：启动探测只能给出扩展名的先验分类，且 Node.js 白名单读回无法区分
 * 「TSD 真受控」与「策略动态变化/目录级差异导致的伪受控」。写入后用外部进程
 * 读磁盘原始字节是最可靠的实测判据，可即时纠正误分类：
 *   - 磁盘字节 == 写入内容前缀 → 磁盘明文 → 该扩展名归入 safe
 *   - 磁盘字节命中 %TSD 魔数   → 磁盘密文 → 该扩展名归入 encrypted
 * 返回 { diskPlaintext, category: "safe"|"encrypted"|"unknown" }；
 * 无字节读取器/无扩展名/检测异常时返回 unknown 且不改动分类。
 */
function detectDiskStateAfterWrite(filePath, expectedContent) {
  try {
    const profile = getProfile();
    const ext = path.extname(filePath).toLowerCase();
    if (!ext || !profile.byteReader) return { diskPlaintext: true, category: "unknown" };
    const hex = externalReadHexPrefix(profile.byteReader, filePath, 16);
    if (hex === null) return { diskPlaintext: true, category: "unknown" };
    const expectedHex = Buffer.from(expectedContent, "utf-8").subarray(0, 16).toString("hex");
    const isTsd = hex.slice(0, 8) === TSD_MAGIC_HEX;
    if (!isTsd && hex === expectedHex) {
      updateExtCategory(ext, "safe");
      return { diskPlaintext: true, category: "safe" };
    }
    if (isTsd) {
      updateExtCategory(ext, "encrypted");
      return { diskPlaintext: false, category: "encrypted" };
    }
    return { diskPlaintext: true, category: "unknown" };
  } catch (e) {
    return { diskPlaintext: true, category: "unknown" };
  }
}

/**
 * 根据写入后的磁盘实测状态更新扩展名分类，并持久化到缓存（1.8.0 新增）。
 * 从全部分类列表中移除该扩展名后写入目标列表：
 *   safe      → safeExtensions（直写，磁盘明文）
 *   encrypted → encryptedExtensions（磁盘密文，后续写入走 safeWrite 保持明文）
 * 用户手动标注（userProtectedExtensions）优先级最高，自动重分类不会覆盖
 * （标注为 protected 的扩展名不会被自动改判；标注为 unsafe 的扩展名已锁定
 * 走 safeWrite，实测明文时也不回改，由用户用 mark_extension clear 解除）。
 */
function updateExtCategory(ext, newCategory) {
  const p = getProfile();
  if (!ext) return;
  // 用户手动标注优先：protected 锁定保持加密，自动检测不得改判
  if (Array.isArray(p.userProtectedExtensions) && p.userProtectedExtensions.indexOf(ext) !== -1) return;
  for (const key of ["safeExtensions", "protectedExtensions", "unsafeExtensions", "encryptedExtensions"]) {
    const arr = p[key];
    if (Array.isArray(arr)) {
      const idx = arr.indexOf(ext);
      if (idx !== -1) arr.splice(idx, 1);
    }
  }
  const listKey = newCategory === "safe" ? "safeExtensions" : "encryptedExtensions";
  if (!Array.isArray(p[listKey])) p[listKey] = [];
  if (p[listKey].indexOf(ext) === -1) p[listKey].push(ext);
  saveProfileCache(p);
}

/**
 * 写入后发现磁盘为密文时的拯救流程（1.8.0 新增）：
 * 用 safeWrite 将同一份内容重新落盘为明文。返回 safeWriteFile 的结果。
 * 调用方需保证已确认磁盘为密文（detectDiskStateAfterWrite.diskPlaintext === false）。
 */
function rescueToPlaintext(filePath, content) {
  return safeWriteFile(filePath, content);
}

/**
 * 写入策略决策（1.8.0 版）：优先级从高到低——
 *   1. userProtectedExtensions（用户标注保持加密）→ direct 直写
 *   2. encryptedExtensions（写入后实测磁盘密文）→ safe（safeWrite 保持明文）
 *   3. unsafeExtensions（启动探测 unsafe）→ safe（safeWrite 保持明文）
 *   4. 已知 safe/protected → direct 直写
 *   5. 未知扩展名 → direct_then_verify（先直写，写后实测磁盘状态并自动重分类/纠正）
 */
function decideWriteStrategy(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (!ext) return { mode: "direct", category: "none" };
  try {
    const p = getProfile();
    if (Array.isArray(p.userProtectedExtensions) && p.userProtectedExtensions.indexOf(ext) !== -1) {
      return { mode: "direct", category: "user_protected" };
    }
    if (Array.isArray(p.encryptedExtensions) && p.encryptedExtensions.indexOf(ext) !== -1) {
      return { mode: "safe", category: "encrypted" };
    }
    if (Array.isArray(p.unsafeExtensions) && p.unsafeExtensions.indexOf(ext) !== -1) {
      return { mode: "safe", category: "unsafe" };
    }
    if (p.safeExtensions.indexOf(ext) !== -1) return { mode: "direct", category: "safe" };
    if (p.protectedExtensions.indexOf(ext) !== -1) return { mode: "direct", category: "protected" };
    return { mode: "direct_then_verify", category: "unknown" };
  } catch (e) {
    return { mode: "direct", category: "unknown" };
  }
}

/**
 * 构造 safeWrite 可用组合列表：bestCombo 优先，其后为全部 safe扩展名 × 可用进程 的笛卡尔积（去重）。
 */
function buildWriteCombos(profile) {
  const combos = [];
  if (profile.bestCombo) combos.push(profile.bestCombo);
  for (const ext of profile.safeExtensions) {
    for (const proc of profile.availableProcesses) {
      combos.push({ extension: ext, process: proc.id });
    }
  }
  const seen = new Set();
  return combos.filter((c) => {
    const k = c.extension + "|" + c.process;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * 验证目标文件已按期望明文落盘：Node 读回与写入内容一致即视为明文
 * （unsafe 扩展名若被透明加密成密文，Node 读回必不一致）。
 * 有字节读取器时再叠加磁盘原始字节对比（双保险，防边缘情况）。
 */
function verifyPlaintextOnDisk(targetPath, expectedContent, profile) {
  try {
    if (fs.readFileSync(targetPath, "utf-8") !== expectedContent) return false;
  } catch (e) {
    return false;
  }
  if (profile && profile.byteReader) {
    const hex = externalReadHexPrefix(profile.byteReader, targetPath, 16);
    if (hex !== null) {
      const expectedHex = Buffer.from(expectedContent, "utf-8").subarray(0, 16).toString("hex");
      if (hex !== expectedHex || hex.slice(0, 8) === TSD_MAGIC_HEX) return false;
    }
  }
  return true;
}

/**
 * safeWrite：把内容以明文落盘到 unsafe 扩展名目标。
 * 流程（按组合逐个尝试，bestCombo 优先）：
 *   1. fs.writeFileSync 写入 targetPath + 安全扩展名 的临时文件（磁盘明文）
 *   2. 用该组合的外部进程复制临时文件到 targetPath（非白名单进程不触发透明加密）
 *   3. 校验 targetPath 磁盘字节为明文
 *   4. 清理临时文件
 * 返回 { ok, via:{extension,process}, error }；全部组合失败返回 { ok:false, error }，
 * 由调用方决定是否回退直写（不重删 targetPath，避免破坏已有文件）。
 */
function safeWriteFile(targetPath, content) {
  const profile = getProfile();
  const combos = buildWriteCombos(profile);
  if (!combos.length) {
    return { ok: false, error: "无可用组合（未探测到 safe 扩展名或可用外部进程）" };
  }
  const parent = path.dirname(targetPath);
  const errors = [];
  for (const combo of combos) {
    const tmpPath = targetPath + combo.extension;
    try {
      if (parent && !fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
      fs.writeFileSync(tmpPath, content, "utf-8");
      externalCopyFile(combo.process, tmpPath, targetPath);
      if (verifyPlaintextOnDisk(targetPath, content, profile)) {
        return { ok: true, via: combo };
      }
      errors.push(combo.process + "+" + combo.extension + ": 落盘校验非明文");
    } catch (e) {
      errors.push(combo.process + "+" + combo.extension + ": " + e.message);
    } finally {
      try { fs.rmSync(tmpPath, { force: true }); } catch (e) { /* 忽略 */ }
    }
  }
  return { ok: false, error: errors.join("；") || "全部组合失败" };
}

/**
 * safeCopy 变体：供 copy_path / move_path 使用，把「已有源文件」复制到 unsafe 扩展名目标。
 * 经白名单进程 cpSync 读出明文写入安全扩展名临时文件，再由外部进程复制到目标。
 * 用 Buffer 对比验证（二进制安全）。返回结构同 safeWriteFile。
 */
function safeCopyFileTo(source, targetPath) {
  const profile = getProfile();
  const combos = buildWriteCombos(profile);
  if (!combos.length) {
    return { ok: false, error: "无可用组合（未探测到 safe 扩展名或可用外部进程）" };
  }
  const parent = path.dirname(targetPath);
  const errors = [];
  for (const combo of combos) {
    const tmpPath = targetPath + combo.extension;
    try {
      if (parent && !fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
      fs.cpSync(source, tmpPath, { force: true });
      externalCopyFile(combo.process, tmpPath, targetPath);
      // 读回对比（Buffer 级）：源经白名单读为明文，目标一致即明文落盘
      let ok = false;
      try { ok = fs.readFileSync(targetPath).equals(fs.readFileSync(source)); } catch (e) { /* 保持 false */ }
      if (ok) return { ok: true, via: combo };
      errors.push(combo.process + "+" + combo.extension + ": 落盘校验不一致");
    } catch (e) {
      errors.push(combo.process + "+" + combo.extension + ": " + e.message);
    } finally {
      try { fs.rmSync(tmpPath, { force: true }); } catch (e) { /* 忽略 */ }
    }
  }
  return { ok: false, error: errors.join("；") || "全部组合失败" };
}

/**
 * 编辑写回统一入口（edit_file 用）：unsafe/encrypted 扩展名走 safeWrite 保持磁盘明文，
 * 其余直写。safeWrite 失败回退直写并标记 degraded（附带原因供调用方告警）。
 * direct_then_verify（未知扩展名）与 direct 直写后执行写入后磁盘实测：
 * 发现密文则自动重分类并立即用 safeWrite 重写为明文（autoCorrected 标记）。
 * 返回 { ok, via, degraded, autoCorrected, correctedTo, error }。
 */
function writeBackWithStrategy(filePath, payload) {
  const decision = decideWriteStrategy(filePath);
  if (decision.mode === "safe") {
    const r = safeWriteFile(filePath, payload);
    if (r.ok) return { ok: true, via: r.via };
    fs.writeFileSync(filePath, payload, "utf-8"); // 全部组合失败：回退直写并告警
    return { ok: true, degraded: true, error: r.error };
  }
  fs.writeFileSync(filePath, payload, "utf-8");
  // 写入后实测：未知扩展名（direct_then_verify）必测；已知 safe/protected 也复测
  // （目录级策略差异或管理员调整策略时，启动探测结论可能已过期）。
  // user_protected（用户手动标注保持加密）明确跳过：用户意图优先，不做自动纠正；
  // 无字节读取器的环境检测必返回 unknown，自然无开销。
  const p = getProfile();
  if (p.postWriteDetectionEnabled && decision.category !== "user_protected") {
    const ds = detectDiskStateAfterWrite(filePath, payload);
    if (!ds.diskPlaintext) {
      const sw = rescueToPlaintext(filePath, payload);
      if (sw.ok) {
        return { ok: true, autoCorrected: true, correctedTo: ds.category, via: sw.via };
      }
      return { ok: true, degraded: true, error: "写入后磁盘为密文且 safeWrite 纠正失败（" + sw.error + "）" };
    }
  }
  return { ok: true };
}

/**
 * 生成 profile 概要文本（encryption_profile / refresh_profile / check_status 共用）。
 */
function formatProfileSummary(p) {
  const fmt = (arr) => arr.length ? arr.join(" ") : "（无）";
  const procs = p.availableProcesses.map((x) => x.id).join(", ") || "（无）";
  const lines = [
    "机器指纹 machineId: " + p.machineId,
    "探测时间: " + p.detectedAt,
    "safe 扩展名（磁盘明文，直写）: " + fmt(p.safeExtensions),
    "protected 扩展名（磁盘密文/白名单可解密，直写）: " + fmt(p.protectedExtensions),
    "unsafe 扩展名（磁盘密文/不可解密，走 safeWrite）: " + fmt(p.unsafeExtensions),
    "encrypted 扩展名（写入后实测磁盘密文，走 safeWrite）: " + fmt(p.encryptedExtensions || []),
    "用户标注保持加密 userProtected: " + fmt(p.userProtectedExtensions || []),
    "写入后实时检测: " + (p.postWriteDetectionEnabled !== false ? "开启" : "关闭"),
    "可用外部进程: " + procs,
    "磁盘字节读取器: " + (p.byteReader || "（无，退化为大小+读回对比）"),
    "最佳组合 bestCombo: " + (p.bestCombo ? p.bestCombo.process + " + " + p.bestCombo.extension : "（无：无 unsafe 扩展名或无可用进程）"),
    "缓存文件: " + PROFILE_CACHE_PATH,
  ];
  if (p.detectError) lines.push("探测异常: " + p.detectError);
  return lines.join("\n");
}

// 注册 mark_extension 工具（手动标注扩展名写入策略）
server.tool(
  "mark_extension",
  "手动标注扩展名的写入策略。protected=保持TSD加密直写（如 .java 这类需要保持加密状态的文档）；unsafe=强制走 safeWrite 保持明文（如 .scss）；clear=清除标注恢复自动探测。标注优先级高于自动探测与写入后重分类。",
  {
    extension: z.string().describe("扩展名，如 .java（可不带点，自动补全并转小写）"),
    category: z.enum(["protected", "unsafe", "clear"]).describe("protected=直写保持加密；unsafe=走safeWrite保持明文；clear=清除手动标注"),
  },
  async ({ extension, category }) => {
    try {
      const p = getProfile();
      const ext = extension.startsWith(".") ? extension.toLowerCase() : "." + extension.toLowerCase();
      if (!Array.isArray(p.userProtectedExtensions)) p.userProtectedExtensions = [];
      const removeFrom = (arr, v) => { const i = arr.indexOf(v); if (i !== -1) arr.splice(i, 1); };
      if (category === "protected") {
        if (p.userProtectedExtensions.indexOf(ext) === -1) p.userProtectedExtensions.push(ext);
        // 保持加密的扩展名不应再走 safeWrite：从 encrypted/unsafe 自动列表移除
        if (Array.isArray(p.encryptedExtensions)) removeFrom(p.encryptedExtensions, ext);
        if (Array.isArray(p.unsafeExtensions)) removeFrom(p.unsafeExtensions, ext);
        if (Array.isArray(p.safeExtensions)) removeFrom(p.safeExtensions, ext);
        saveProfileCache(p);
        return { content: [{ type: "text", text: "✅ 已标注 " + ext + " 为 protected（保持加密）：后续写入直接直写，由加密软件加密落盘；写入后检测对该扩展名自动跳过。" }] };
      }
      if (category === "unsafe") {
        removeFrom(p.userProtectedExtensions, ext);
        if (!Array.isArray(p.encryptedExtensions)) p.encryptedExtensions = [];
        if (p.encryptedExtensions.indexOf(ext) === -1) p.encryptedExtensions.push(ext);
        if (Array.isArray(p.safeExtensions)) removeFrom(p.safeExtensions, ext);
        saveProfileCache(p);
        return { content: [{ type: "text", text: "✅ 已标注 " + ext + " 为 unsafe（保持明文）：后续写入一律走 safeWrite 保持磁盘明文。" }] };
      }
      // clear：仅移除手动标注，自动分类列表保持现状
      removeFrom(p.userProtectedExtensions, ext);
      saveProfileCache(p);
      return { content: [{ type: "text", text: "✅ 已清除 " + ext + " 的手动标注，恢复自动探测/写入后检测分类。" }] };
    } catch (e) {
      return { content: [{ type: "text", text: "❌ 标注失败: " + e.message }], isError: true };
    }
  }
);

// 注册 encryption_profile 工具（查看环境探测结果）
server.tool(
  "encryption_profile",
  "查看当前加密环境探测结果：safe/protected/unsafe 三类扩展名列表、可用外部进程、最佳写入组合（bestCombo）、机器指纹与缓存位置。结果缓存于 ~/.mcp-encryption-profile.json，换电脑自动重探。",
  {},
  { readOnlyHint: true },
  async () => {
    try {
      const p = getProfile();
      return { content: [{ type: "text", text: "加密环境探测结果（来自" + (loadProfileCache() ? "缓存" : "本次探测") + "）:\n" + formatProfileSummary(p) }] };
    } catch (e) {
      return { content: [{ type: "text", text: "❌ 获取探测结果失败: " + e.message }], isError: true };
    }
  }
);

// 注册 refresh_profile 工具（强制重新探测并更新缓存）
server.tool(
  "refresh_profile",
  "强制重新执行环境探测（扩展名分类 + 外部进程 + 交叉验证）并更新缓存。当加密软件策略变更、切换项目目录策略、或怀疑缓存过期时使用。探测过程在系统临时目录写入临时文件，不污染用户目录。",
  {},
  async () => {
    try {
      activeProfile = detectEnvironment();
      saveProfileCache(activeProfile);
      return { content: [{ type: "text", text: "✅ 已重新探测并更新缓存:\n" + formatProfileSummary(activeProfile) }] };
    } catch (e) {
      return { content: [{ type: "text", text: "❌ 重新探测失败: " + e.message }], isError: true };
    }
  }
);

// 注册 read_file 工具
server.tool(
  "read_file",
  "读取指定路径的文件内容（明文）。加密软件环境下，Node.js 进程作为白名单可自动解密读取明文。适用于读取代码、配置、文档等文本文件。超大文件自动截断（提示改用 read_file_partial 分页读取）。替代内置 Read 工具。",
  { path: z.string().describe("文件路径，支持相对路径或绝对路径（相对路径以 MCP Server 启动目录为基准，建议用绝对路径）") },
  { readOnlyHint: true },
  async ({ path: filePath }) => {
    const result = readFileContent(filePath, READ_MAX_CHARS);
    if (result.ok) {
      let text = result.content;
      if (result.truncated) {
        // 截断时 totalChars 不可得（避免为报总数而全量读取），用已读明文字节数描述体量
        text += "\n\n⚠️ 文件较大，已截断为前 " + result.content.length + " 字符（至少 " + result.bytesRead + " 字节）。请改用 read_file_partial 分页读取后续内容。";
      }
      return { content: [{ type: "text", text }] };
    } else {
      return { content: [{ type: "text", text: "❌ " + result.error }], isError: true };
    }
  }
);

// 注册 read_files 工具（批量读取）
server.tool(
  "read_files",
  "批量读取多个文件的内容（明文）。paths 推荐传字符串数组（MCP 原生支持）；兼容旧版的英文逗号分隔字符串（注意：Windows 路径可合法包含逗号，含逗号路径必须用数组形式）。单文件超限自动截断。加密软件环境下通过 Node.js 白名单进程自动解密。",
  {
    paths: z.union([z.array(z.string()), z.string()]).describe("文件路径列表：字符串数组（推荐）或英文逗号分隔的字符串（兼容旧版）"),
  },
  { readOnlyHint: true },
  async ({ paths }) => {
    // 兼容两种入参：数组直接用；字符串按逗号切分（旧版行为，含逗号路径应改用数组）
    const pathList = Array.isArray(paths)
      ? paths.map((p) => String(p).trim()).filter(Boolean)
      : String(paths).split(",").map((p) => p.trim()).filter(Boolean);
    if (!pathList.length) {
      return { content: [{ type: "text", text: "❌ 未提供任何文件路径" }], isError: true };
    }
    const results = [];
    let okCount = 0;
    for (const p of pathList) {
      const result = readFileContent(p, READ_MAX_CHARS);
      if (result.ok) {
        okCount++;
        let body = result.content;
        if (result.truncated) {
          body += "\n\n⚠️ [单文件已截断为前 " + result.content.length + " 字符，如需后续内容请用 read_file_partial]";
        }
        results.push("========== 文件: " + p + " ==========\n" + body);
      } else {
        results.push("========== 文件: " + p + " 【读取失败】 ==========\n❌ " + result.error);
      }
    }
    // 全部失败时置错误标记，避免 Agent 误判批量读取成功
    const allFailed = okCount === 0;
    return {
      content: [{ type: "text", text: results.join("\n\n") }],
      ...(allFailed ? { isError: true } : {}),
    };
  }
);

// 注册 read_file_partial 工具（局部读取，按字符数或行号范围）
server.tool(
  "read_file_partial",
  "局部读取文件内容（明文）。支持两种模式：①按字符数读取前N个字符；②按行号读取指定行或行范围（如第10行、第5-20行）。加密软件环境下同样通过 Node.js 白名单进程自动解密。适用于大文件预览、定位特定行内容等场景。",
  {
    path: z.string().describe("文件路径，支持相对路径或绝对路径"),
    mode: z.enum(["chars", "lines"]).describe("读取模式：chars=按字符数读取前N个字符；lines=按行号读取指定行或行范围"),
    charCount: z.number().int().positive().optional().describe("mode=chars 时必填，读取前N个字符"),
    startLine: z.number().int().min(1).optional().describe("mode=lines 时必填，起始行号（从1开始）"),
    endLine: z.number().int().min(1).optional().describe("mode=lines 时可选，结束行号（含）。不传则只读取 startLine 一行"),
  },
  { readOnlyHint: true },
  async ({ path: filePath, mode, charCount, startLine, endLine }) => {
    // chars 模式走预算读取（只读需要的字节），lines 模式需完整行结构仍全量读
    const result = mode === "chars"
      ? (charCount === undefined
          ? null
          : readFileContent(filePath, charCount))
      : readFileContent(filePath);
    if (mode === "chars" && result === null) {
      return { content: [{ type: "text", text: "❌ mode=chars 时必须提供 charCount 参数" }], isError: true };
    }
    if (!result.ok) {
      return { content: [{ type: "text", text: "❌ " + result.error }], isError: true };
    }
    const content = result.content;
    // chars 模式下预算读取可能已截断在 charCount 处，此时 totalChars 不可知，
    // 报告为「至少」；未截断（文件小于预算）则精确
    const totalChars = mode === "chars" && result.truncated ? null : result.totalChars;
    const totalCharsText = totalChars === null ? "≥" + content.length : String(totalChars);

    if (mode === "chars") {
      let end = charCount;
      // 避免把代理对（emoji/生僻字）切成两半产生孤立代理项乱码：落在高位代理上时右移一位
      if (end < content.length) {
        const code = content.charCodeAt(end - 1);
        if (code >= 0xd800 && code <= 0xdbff) end++;
      }
      const slice = content.slice(0, end);
      const header = "📄 文件: " + filePath + "\n模式: 前 " + charCount + " 字符（共 " + totalCharsText + " 字符）\n";
      const footer = end < content.length || result.truncated
        ? "\n\n...(已截断，还有内容未显示，可用更大的 charCount 继续读取)"
        : "";
      return { content: [{ type: "text", text: header + "──────────────────────\n" + slice + footer }] };
    }

    // mode === "lines"
    if (startLine === undefined) {
      return { content: [{ type: "text", text: "❌ mode=lines 时必须提供 startLine 参数" }], isError: true };
    }
    let lines = content.split(/\r?\n/);
    // 文件以换行结尾时 split 产生尾部空元素，与编辑器行号语义不符（100行文件不应显示101行）
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    const totalLines = lines.length;
    const sLine = startLine;
    const eLine = endLine !== undefined ? endLine : startLine;
    if (eLine < sLine) {
      return { content: [{ type: "text", text: "❌ endLine 不能小于 startLine" }], isError: true };
    }
    // 起始行超出总行数时明确报错，而不是返回倒挂的空区间
    if (sLine > totalLines) {
      return { content: [{ type: "text", text: "❌ startLine " + sLine + " 超出文件总行数 " + totalLines + "（文件: " + filePath + "）" }], isError: true };
    }
    // 行号从1开始，数组索引从0开始
    const startIdx = Math.max(0, sLine - 1);
    const endIdx = Math.min(totalLines, eLine); // slice 不含 endIdx，所以用 eLine（因为已经 +1 偏移）
    const selected = lines.slice(startIdx, endIdx);
    // 为每行添加行号前缀
    const numbered = selected.map((line, i) => {
      const lineNo = startIdx + i + 1;
      return String(lineNo).padStart(6, " ") + " | " + line;
    });
    const actualStart = startIdx + 1;
    const actualEnd = startIdx + selected.length;
    const header = "📄 文件: " + filePath + "\n模式: 第 " + actualStart + " - " + actualEnd + " 行（共 " + totalLines + " 行）\n";
    const footer = eLine > totalLines ? "\n\n⚠️ 请求的结束行 " + eLine + " 超出文件总行数 " + totalLines + "，已自动截断" : "";
    return { content: [{ type: "text", text: header + "──────────────────────\n" + numbered.join("\n") + footer }] };
  }
);

// 注册 write_file 工具（加密软件环境下安全写回）
server.tool(
  "write_file",
  "将内容写入指定路径（明文）。支持追加模式（mode=append）与覆盖模式（默认）；覆盖已有文件时行尾风格自动跟随原文件（避免制造混合行尾）、已有 BOM 自动保留。加密软件环境下，Node.js 白名单进程写入会自动加密落盘，适用于安全写回加密文件。替代内置 Write 工具。",
  {
    path: z.string().describe("文件路径，支持相对路径或绝对路径（相对路径以 MCP Server 启动目录为基准，建议用绝对路径）"),
    content: z.string().describe("写入的文件内容（明文）"),
    mode: z.enum(["overwrite", "append"]).optional().describe("写入模式：overwrite=覆盖（默认）；append=追加到文件末尾"),
    eol: z.enum(["auto", "lf", "crlf"]).optional().describe("行尾风格：auto=跟随已有文件（默认，新文件用 LF）；lf=强制 LF；crlf=强制 CRLF"),
  },
  async ({ path: filePath, content, mode, eol }) => {
    try {
      const writeMode = mode === "append" ? "append" : "overwrite";
      let finalContent = content;
      // 覆盖/追加已有文件时：读取原文件元信息（BOM 与主导行尾）做适配，
      // 单次 readFileContent(prefix 4KB 嗅探 + 全量) 避免重复 IO
      if (fs.existsSync(filePath)) {
        const prev = readFileContent(filePath);
        if (prev.ok) {
          if (writeMode === "overwrite" && prev.hasBom) finalContent = "\uFEFF" + finalContent;
          if (eol !== "lf" && eol !== "crlf") {
            // eol=auto（默认）：内容行尾跟随原文件主导风格（双向转换），
            // 避免 CRLF 文件被追加 LF 内容或 LF 文件被写入 CRLF 内容产生混行
            const prevEol = detectEol(prev.content);
            finalContent = normalizeEol(finalContent, prevEol);
          }
        }
      }
      if (eol === "lf") finalContent = normalizeEol(finalContent, "\n");
      if (eol === "crlf") finalContent = normalizeEol(finalContent, "\r\n");
      // 自动创建父目录，避免新文件路径不存在时直接报错
      const parent = path.dirname(filePath);
      if (parent && !fs.existsSync(parent)) {
        fs.mkdirSync(parent, { recursive: true });
      }
      // 环境自适应：unsafe/encrypted 扩展名直写会被透明加密，必须走 safeWrite
      //（安全扩展名临时文件 + 外部进程复制）保证磁盘明文；未知扩展名先直写，
      // 写入后用外部进程实测磁盘状态，发现密文自动重分类并立即纠正为明文
      const decision = decideWriteStrategy(filePath);
      if (decision.mode === "safe") {
        let payload = finalContent;
        if (writeMode === "append" && fs.existsSync(filePath)) {
          // 追加模式：外部进程只做整文件复制，需先合并原内容再整体中转落盘
          const prevFull = readFileContent(filePath);
          if (!prevFull.ok) {
            return { content: [{ type: "text", text: "❌ 追加失败：目标扩展名为 unsafe 且原文件无法读出明文（可能已处于不可解密状态）: " + filePath + "\n" + prevFull.error }], isError: true };
          }
          payload = (prevFull.hasBom ? "\uFEFF" : "") + prevFull.content + finalContent;
        }
        const r = safeWriteFile(filePath, payload);
        if (r.ok) {
          return { content: [{ type: "text", text: "✅ 写入成功" + (writeMode === "append" ? "（追加）" : "") + ": " + filePath + "\nℹ️ 目标扩展名为 " + decision.category + "（写入会加密），已走 safeWrite 明文落盘（" + r.via.process + " + " + r.via.extension + "）" }] };
        }
        // 全部组合失败：回退直写并明确告警（兜底行为，保证内容至少落盘）
        fs.writeFileSync(filePath, payload, { encoding: "utf-8", flag: "w" });
        return { content: [{ type: "text", text: "⚠️ 已写入但磁盘可能为不可解密密文：目标扩展名为 " + decision.category + " 且 safeWrite 全部组合失败（" + r.error + "），已回退直接写入: " + filePath }], isError: true };
      }
      fs.writeFileSync(filePath, finalContent, { encoding: "utf-8", flag: writeMode === "append" ? "a" : "w" });
      // 写入后实测：未知扩展名必测，已知 safe/protected 也复测（策略可能按目录生效或被调整）；
      // 用户手动标注 protected 的扩展名跳过（用户意图优先）。发现密文自动重分类并纠正为明文
      const wfProfile = getProfile();
      if (wfProfile.postWriteDetectionEnabled && decision.category !== "user_protected") {
        const ds = detectDiskStateAfterWrite(filePath, finalContent);
        if (!ds.diskPlaintext) {
          const sw = rescueToPlaintext(filePath, finalContent);
          if (sw.ok) {
            return { content: [{ type: "text", text: "✅ 写入成功" + (writeMode === "append" ? "（追加）" : "") + ": " + filePath + "\nℹ️ 首次探测到该扩展名写入后磁盘为密文，已自动重分类并转为 safeWrite 明文落盘（" + sw.via.process + " + " + sw.via.extension + "），后续该扩展名将直接走 safeWrite" }] };
          }
          return { content: [{ type: "text", text: "⚠️ 写入后磁盘为密文且自动纠正失败（" + sw.error + "），文件当前可能为密文: " + filePath }], isError: true };
        }
      }
      return { content: [{ type: "text", text: "✅ 写入成功" + (writeMode === "append" ? "（追加）" : "") + ": " + filePath }] };
    } catch (e) {
      return { content: [{ type: "text", text: "❌ 写入失败: " + e.message }], isError: true };
    }
  }
);

/**
 * 检测文本的主导换行风格：CRLF 数量多于孤立 LF 时返回 "\r\n"，否则返回 "\n"。
 */
function detectEol(text) {
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/\n/g) || []).length - crlf;
  return crlf > lf ? "\r\n" : "\n";
}

/**
 * 将文本换行符统一为目标风格 eol（先归一为 \n 再输出，避免 CRLF 被二次转换）。
 */
function normalizeEol(text, eol) {
  return text.replace(/\r\n?/g, "\n").replace(/\n/g, eol);
}

/**
 * 换行符不敏感的替换兜底：文件为 CRLF 而 oldString 为 LF（或相反）时仍可命中。
 * 原理：把原文与 oldString 的换行均归一为 \n 后匹配，并用索引映射表把命中位置
 * 换算回原文位置，未命中区域逐字节保持原样；replacement 由调用方预先按文件
 * 主导换行风格归一。返回 { updated, count }，无命中返回 null。
 */
function eolInsensitiveReplace(original, oldString, replacement, replaceAll, ignoreCase) {
  const parts = [];
  const map = [];
  for (let i = 0; i < original.length; i++) {
    if (original.charCodeAt(i) === 13) {
      // \r 与 \r\n 均折叠为一个 \n，并记录该换行在原文中的起点
      parts.push("\n");
      map.push(i);
      if (original.charCodeAt(i + 1) === 10) i++;
    } else {
      parts.push(original[i]);
      map.push(i);
    }
  }
  map.push(original.length);
  const norm = parts.join("");
  const normNeedle = oldString.replace(/\r\n?/g, "\n");
  if (!normNeedle) return null;
  const hay = ignoreCase ? norm.toLowerCase() : norm;
  const needle = ignoreCase ? normNeedle.toLowerCase() : normNeedle;
  const positions = [];
  let idx = 0;
  while ((idx = hay.indexOf(needle, idx)) !== -1) {
    positions.push(idx);
    idx += needle.length;
  }
  if (!positions.length) return null;
  let updated = original;
  // 从后往前替换，避免前面的替换使后面的原始索引失效
  const targets = replaceAll ? positions : [positions[0]];
  for (let i = targets.length - 1; i >= 0; i--) {
    const p = targets[i];
    const start = map[p];
    const end = map[p + normNeedle.length];
    updated = updated.slice(0, start) + replacement + updated.slice(end);
  }
  return { updated, count: positions.length };
}

/**
 * 匹配失败时的相似行诊断：在文件中找出与 oldString 首行（或整体）最相似的行，
 * 输出行号与原文，帮助 Agent 快速定位「看起来一样实际差个空白/字符」的位置。
 * 诊断方式：按公共 8-gram 计数相似度（无依赖的轻量实现），返回最多 3 条候选。
 */
function diagnoseNoMatch(original, oldString) {
  // 取 oldString 的首行做行级比对（多数失败源于首行定位错误）
  const firstLine = oldString.split(/\r?\n/)[0].trim();
  if (!firstLine || firstLine.length < 6) return "";
  const grams = new Set();
  const N = 8;
  for (let i = 0; i + N <= firstLine.length; i++) grams.add(firstLine.slice(i, i + N));
  if (!grams.size) return "";
  const lines = original.split(/\r?\n/);
  let best = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    let hit = 0;
    for (let j = 0; j + N <= line.length; j++) {
      if (grams.has(line.slice(j, j + N))) hit++;
    }
    const denom = Math.max(grams.size, Math.ceil(line.trim().length / N));
    const sim = hit / denom;
    if (sim > 0.25) best.push({ line: i + 1, sim, text: line.trim().slice(0, 120) });
  }
  best.sort((a, b) => b.sim - a.sim);
  best = best.slice(0, 3);
  if (!best.length) return "";
  return "\n可能相关的行（相似度排序，请对照检查空白/缩进/字符差异）:\n" +
    best.map((b) => "  第 " + b.line + " 行 (相似度 " + Math.round(b.sim * 100) + "%): " + b.text).join("\n");
}

/**
 * 对文本应用一次替换（edit_file 单次模式与批量模式的每个条目共用）。
 * 两级匹配：①字节级精确匹配 ②换行归一化兜底（CRLF/LF 差异）。
 * 返回 { ok, updated, count, eolAdapted, error, diagnose }；失败时 error 带原因，
 * diagnose 带相似行诊断（仅字符串模式且完全无命中时提供）。
 */
function applySingleEdit(original, oldString, newString, useRegex, replaceAll, ignoreCase) {
  // 替换文本统一按文件主导行尾风格写入（调用方已归一 newString）
  let matcher = null;
  if (useRegex) {
    try {
      // 正则模式默认附加 m 标志：^/$ 按行锚定（Agent 常用行级正则习惯），JS 无内联标志无法由调用方自行开启
      matcher = new RegExp(oldString, ((replaceAll ? "g" : "") + "m" + (ignoreCase ? "i" : "")));
    } catch (e) {
      return { ok: false, error: "正则表达式无效: " + e.message };
    }
  }
  if (useRegex) {
    // 计数与替换均带 m 标志，保持与构造 matcher 时一致
    const globalMatcher = new RegExp(matcher.source, "gm" + (ignoreCase ? "i" : ""));
    const matches = original.match(globalMatcher);
    const count = matches ? matches.length : 0;
    if (count === 0) return { ok: false, error: "正则未匹配到内容", count: 0 };
    const replaceMatcher = replaceAll ? globalMatcher : new RegExp(matcher.source, "m" + (ignoreCase ? "i" : ""));
    return { ok: true, updated: original.replace(replaceMatcher, newString), count, eolAdapted: false };
  }
  if (oldString === "") {
    return { ok: false, error: "oldString 不能为空字符串" };
  }
  // 第一优先：原样精确匹配（字节级一致，最安全）
  const hay = ignoreCase ? original.toLowerCase() : original;
  const needle = ignoreCase ? oldString.toLowerCase() : oldString;
  let idx = 0, exactCount = 0;
  while ((idx = hay.indexOf(needle, idx)) !== -1) { exactCount++; idx += needle.length; }
  if (exactCount > 0) {
    let updated;
    if (replaceAll) {
      const esc = oldString.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // 用函数替换避免 newString 中的 $& $1 等被误解析为替换模式
      updated = original.replace(new RegExp(esc, ignoreCase ? "gi" : "g"), () => newString);
    } else {
      const pos = hay.indexOf(needle);
      updated = original.slice(0, pos) + newString + original.slice(pos + oldString.length);
    }
    return { ok: true, updated, count: exactCount, eolAdapted: false };
  }
  // 第二优先：换行符兼容匹配。文件是 CRLF 而 oldString 用 LF（或相反）时，
  // 字节级比对必然失败，归一换行后再匹配，命中即记为换行适配替换
  const adapted = eolInsensitiveReplace(original, oldString, newString, replaceAll, ignoreCase);
  if (adapted) {
    return { ok: true, updated: adapted.updated, count: adapted.count, eolAdapted: true };
  }
  return { ok: false, error: "未找到匹配内容", count: 0, diagnose: diagnoseNoMatch(original, oldString) };
}

// 注册 edit_file 工具（精确替换，替代受加密影响的 Edit/MultiEdit）
server.tool(
  "edit_file",
  "对文件内容做精确字符串或正则替换后写回（明文）。支持两种形态：①单次替换（oldString/newString）；②批量原子编辑（edits 数组，按序应用，任一条目失败则整体不写盘，避免半改状态）。字符串匹配自动兼容 CRLF/LF 换行差异，替换文本行尾自动跟随文件主导风格。加密软件环境下内置 Edit/MultiEdit 直写会破坏加密，本工具用 Node.js fs 读改写，自动加密落盘。替代内置 Edit/MultiEdit 工具。",
  {
    path: z.string().describe("文件路径，支持相对路径或绝对路径"),
    oldString: z.string().optional().describe("单次模式必填：要被替换的原字符串。useRegex=true 时作为正则表达式"),
    newString: z.string().optional().describe("单次模式必填：替换后的字符串。正则模式下可用 $1 $2 等捕获组引用"),
    edits: z.array(z.object({
      oldString: z.string().describe("要被替换的原字符串（批量条目，不支持正则）"),
      newString: z.string().describe("替换后的字符串（批量条目）"),
      replaceAll: z.boolean().optional().describe("是否替换全部匹配项，默认 false 仅替换第一处"),
    })).optional().describe("批量原子编辑模式：多个替换按序应用，任一条目未匹配则整体不写盘。适合一次完成多处修改（替代 MultiEdit）"),
    useRegex: z.boolean().optional().describe("单次模式：是否将 oldString 当作正则表达式，默认 false（纯字符串匹配）"),
    replaceAll: z.boolean().optional().describe("单次模式：是否替换全部匹配项，默认 false 仅替换第一处"),
    ignoreCase: z.boolean().optional().describe("是否忽略大小写，默认 false。仅在非正则的字符串模式下生效"),
  },
  async ({ path: filePath, oldString, newString, edits, useRegex, replaceAll, ignoreCase }) => {
    try {
      // readFileContent 会剥离 BOM 并记录，写回时补回，避免 oldString 匹配首行失败
      const readResult = readFileContent(filePath);
      if (!readResult.ok) {
        return { content: [{ type: "text", text: "❌ " + readResult.error }], isError: true };
      }
      let original = readResult.content;
      const hasBom = readResult.hasBom;
      // 非 UTF-8 防护：GBK 等编码按 UTF-8 读入会产生大量 U+FFFD，此时做任何替换再写回，
      // 原始字节信息会永久丢失（不可逆损坏）。检测到即拒绝编辑并明确提示。
      if (isLikelyNonUtf8(original)) {
        return {
          content: [{ type: "text", text: "❌ 文件疑似非 UTF-8 编码（GBK 等），按 UTF-8 读取出现大量乱码替换字符，继续编辑写回会不可逆损坏文件，已拒绝操作: " + filePath + "\n建议：先确认文件编码，转换为 UTF-8 后再编辑。" }],
          isError: true,
        };
      }
      // 形态分派：edits 数组走批量原子模式；否则要求 oldString/newString 成对
      const isBatch = Array.isArray(edits) && edits.length > 0;
      if (!isBatch && (oldString === undefined || newString === undefined)) {
        return { content: [{ type: "text", text: "❌ 参数缺失：请提供 oldString+newString（单次替换），或 edits 数组（批量原子编辑）" }], isError: true };
      }
      // 文件主导换行风格：所有替换文本统一转成该风格（CRLF 文件写入 CRLF，保持风格统一）
      const fileEol = detectEol(original);
      const toFileEol = (s) => normalizeEol(s, fileEol);

      // ---------- 批量原子模式：先全部校验再统一写盘，杜绝半改状态 ----------
      if (isBatch) {
        let content = original;
        let total = 0;
        const applied = [];
        // 全部条目按序在内存中应用；任一失败立即返回，文件保持原样
        for (let i = 0; i < edits.length; i++) {
          const item = edits[i];
          const r = applySingleEdit(content, item.oldString, toFileEol(item.newString), false, item.replaceAll === true, false);
          if (!r.ok) {
            return {
              content: [{
                type: "text",
                text: "❌ 批量编辑第 " + (i + 1) + "/" + edits.length + " 条失败: " + r.error + "\n已中止，文件未做任何修改（原子模式，前面条目也不会写入）: " + filePath +
                  (r.diagnose || "") +
                  "\n提示：批量条目按顺序应用，前面条目的 newString 会改变后续条目的匹配环境，请按文件现状顺序构造。",
              }],
              isError: true,
            };
          }
          if (r.updated === content) {
            return {
              content: [{ type: "text", text: "❌ 批量编辑第 " + (i + 1) + "/" + edits.length + " 条替换后内容无变化（newString 与原文相同），已中止: " + filePath }],
              isError: true,
            };
          }
          content = r.updated;
          total += r.count;
          applied.push("#" + (i + 1) + " 替换 " + (item.replaceAll === true ? r.count : 1) + "/" + r.count + " 处");
        }
        if (content === original) {
          return { content: [{ type: "text", text: "⚠️ 批量编辑应用后内容无变化，文件未修改: " + filePath }] };
        }
        // 环境自适应：unsafe/encrypted 扩展名走 safeWrite 保持磁盘明文（失败回退直写并告警）；
        // 未知扩展名直写后实测磁盘状态，发现密文自动重分类并纠正
        const wb = writeBackWithStrategy(filePath, (hasBom ? "\uFEFF" : "") + content);
        let wbNote = "";
        if (wb.via && !wb.autoCorrected) wbNote = "\nℹ️ 目标扩展名写入会加密，已走 safeWrite 明文落盘（" + wb.via.process + " + " + wb.via.extension + "）";
        if (wb.autoCorrected) wbNote = "\nℹ️ 写入后实测磁盘为密文，已自动重分类该扩展名并用 safeWrite 重写为明文（" + wb.via.process + " + " + wb.via.extension + "）";
        if (wb.degraded) wbNote = "\n⚠️ 目标扩展名写入会加密且 safeWrite 失败（" + wb.error + "），已回退直接写入，磁盘可能为不可解密密文";
        return {
          content: [{ type: "text", text: "✅ 批量编辑成功: " + filePath + "\n共 " + edits.length + " 条，" + total + " 处替换\n" + applied.join("\n") + wbNote }],
        };
      }

      // ---------- 单次模式（原行为） ----------
      const normalizedNew = toFileEol(newString);
      const r = applySingleEdit(original, oldString, normalizedNew, useRegex === true, replaceAll === true, ignoreCase === true);
      if (!r.ok) {
        return {
          content: [{ type: "text", text: "⚠️ " + r.error + "，文件未修改。请检查 oldString（或正则）是否正确: " + filePath + (r.diagnose || "") + "\n提示：换行风格（CRLF/LF）已自动兼容；重点检查空格、缩进、字符是否与原文完全一致。" }],
          isError: true,
        };
      }
      const count = r.count;
      const updated = r.updated;
      let warning = "";
      if (r.eolAdapted) {
        warning = "\nℹ️ 换行符已自动适配：oldString 与文件换行风格不一致（CRLF/LF），已按换行归一化匹配完成替换。";
      }
      if (!replaceAll && count > 1) {
        warning += "\n⚠️ 注意：共匹配 " + count + " 处，但 replaceAll=false 仅替换了第一处。如需全部替换请设 replaceAll=true。";
      }
      if (updated === original) {
        return { content: [{ type: "text", text: "⚠️ 替换后内容无变化，文件未修改: " + filePath }] };
      }
      // 原文件带 BOM 时补回，保持文件编码特征不变（部分 Windows 软件依赖 BOM）
      // 环境自适应：unsafe/encrypted 扩展名走 safeWrite 保持磁盘明文（失败回退直写并告警）；
      // 未知扩展名直写后实测磁盘状态，发现密文自动重分类并纠正
      const wbSingle = writeBackWithStrategy(filePath, (hasBom ? "\uFEFF" : "") + updated);
      if (wbSingle.via && !wbSingle.autoCorrected) warning += "\nℹ️ 目标扩展名写入会加密，已走 safeWrite 明文落盘（" + wbSingle.via.process + " + " + wbSingle.via.extension + "）";
      if (wbSingle.autoCorrected) warning += "\nℹ️ 写入后实测磁盘为密文，已自动重分类该扩展名并用 safeWrite 重写为明文（" + wbSingle.via.process + " + " + wbSingle.via.extension + "）";
      if (wbSingle.degraded) warning += "\n⚠️ 目标扩展名写入会加密且 safeWrite 失败（" + wbSingle.error + "），已回退直接写入，磁盘可能为不可解密密文";
      return {
        content: [{ type: "text", text: "✅ 替换成功: " + filePath + "\n替换 " + (replaceAll ? count : 1) + "/" + count + " 处" + warning }],
      };
    } catch (e) {
      if (e.code === "ENOENT") {
        return { content: [{ type: "text", text: "❌ 文件不存在: " + filePath }], isError: true };
      }
      return { content: [{ type: "text", text: "❌ 替换失败: " + e.message }], isError: true };
    }
  }
);

// 注册 search_files 工具（内容搜索，替代受加密影响的 Grep）
server.tool(
  "search_files",
  "在指定目录递归搜索文件内容（明文）。支持 include glob 过滤（*.java 或 **/*.js 均可，多个用逗号分隔）；自动跳过二进制文件、超大文件（>5MB）、常见依赖/构建目录与隐藏文件（如 .env）。加密软件环境下内置 Grep(ripgrep) 只能读到密文搜不到内容，本工具用 Node.js fs 读取后正则匹配。替代内置 Grep 工具。注意：逐行匹配，不支持跨行正则。",
  {
    pattern: z.string().describe("正则表达式（如 log.*Error、function\\s+\\w+），按行匹配，不支持跨行"),
    path: z.string().describe("搜索根目录（或单个文件），支持相对路径或绝对路径"),
    include: z.string().optional().describe("glob 过滤，多个用逗号分隔。支持文件名（*.java）与带目录通配的形式（src/**/*.js、**/*.test.ts）"),
    exclude: z.string().optional().describe("额外排除的目录名，逗号分隔（默认已排除 node_modules/.git/target/build/dist 等）"),
    ignoreCase: z.boolean().optional().describe("是否忽略大小写，默认 false"),
    onlyMatching: z.boolean().optional().describe("是否只输出匹配部分（非整行），默认 false 输出整行"),
    maxResults: z.number().int().positive().optional().describe("最大返回匹配数（正整数），默认 200。超过会在末尾提示被截断"),
  },
  { readOnlyHint: true },
  async ({ pattern, path: rootDir, include, exclude, ignoreCase, onlyMatching, maxResults }) => {
    try {
      // 修正：忽略大小写时需同时携带 g 与 i 标志，否则 ignoreCase 参数失效
      const flags = ignoreCase ? "gi" : "g";
      let regex;
      try {
        regex = new RegExp(pattern, flags);
      } catch (e) {
        return { content: [{ type: "text", text: "❌ 正则表达式无效: " + e.message }], isError: true };
      }
      const includeList = include
        ? include.split(",").map((s) => s.trim()).filter(Boolean)
        : null;
      // include glob 匹配：对「相对根目录的 posix 路径」做全路径匹配，
      // 同时兼容 basename 命中，**/*.js 与 src/**/*.js 均可正确工作
      const includeRegexes = includeList
        ? includeList.map((pat) => ({ pat, re: globToRegex(pat.replace(/\\/g, "/")) }))
        : null;
      const matchesInclude = (full) => {
        if (!includeRegexes) return true;
        const rel = path.relative(rootDir, full).replace(/\\/g, "/");
        return includeRegexes.some(({ re }) => re.test(rel));
      };
      // 默认忽略目录：依赖/构建产物/IDE 缓存，可经 exclude 追加
      const DEFAULT_IGNORE = ["node_modules", ".git", "target", "build", "dist", ".idea", ".vscode", ".svn", "bin", "obj", "out", "vendor"];
      const excludeSet = new Set(DEFAULT_IGNORE);
      if (exclude) {
        for (const name of exclude.split(",").map((s) => s.trim()).filter(Boolean)) excludeSet.add(name);
      }
      const limit = maxResults || 200;
      const results = [];
      let truncated = false;
      let scanned = 0;
      let skippedBinary = 0;
      let skippedLarge = 0;
      let matchedFiles = 0;
      // 对单个文件做内容匹配, 复用与目录遍历相同的行级逻辑
      const scanFile = (full, size) => {
        if (!matchesInclude(full)) return;
        scanned++;
        // 超大文件直接跳过：minified 产物/大日志读入+正则可能卡死同步 server
        if (size > SCAN_MAX_BYTES) { skippedLarge++; return; }
        let content;
        try {
          // 真首块嗅探：只读前 8KB 判二进制，避免为嗅探而整读大文件
          const sniff = readFilePrefix(full, BINARY_SNIFF_BYTES);
          if (!sniff.ok) return;
          if (isBinaryBuffer(sniff.firstBytes)) { skippedBinary++; return; }
          if (sniff.isTruncated) {
            // 文件大于嗅探预算：余量部分整体读取后拼接（5MB 上限保证内存可控）
            content = sniff.text + fs.readFileSync(full, "utf-8").slice(sniff.text.length);
          } else {
            // 文件整体在预算内：首块即全文，避免第二次 IO
            content = sniff.text;
          }
        } catch (e) {
          return;
        }
        const lines = content.split(/\r?\n/);
        let fileHit = false;
        for (let i = 0; i < lines.length; i++) {
          if (truncated) break;
          const line = lines[i];
          if (onlyMatching) {
            // onlyMatching 模式：输出一行内的所有匹配片段（原实现仅取第一个）
            regex.lastIndex = 0;
            let m;
            while ((m = regex.exec(line)) !== null) {
              if (!fileHit) { fileHit = true; matchedFiles++; }
              results.push(full + ":" + (i + 1) + ":" + m[0]);
              if (results.length >= limit) { truncated = true; break; }
              // 防止零宽匹配导致死循环
              if (m.index === regex.lastIndex) regex.lastIndex++;
            }
          } else {
            // 整行模式：一行只输出一条
            regex.lastIndex = 0;
            if (regex.exec(line)) {
              if (!fileHit) { fileHit = true; matchedFiles++; }
              results.push(full + ":" + (i + 1) + ":" + line);
              if (results.length >= limit) { truncated = true; }
            }
          }
        }
      };
      const walk = (dir) => {
        if (truncated) return;
        let entries;
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch (e) {
          return;
        }
        for (const entry of entries) {
          if (truncated) return;
          // 隐藏文件/目录默认跳过（.env/.gitignore 等可能含密钥，且多为配置噪音）
          if (entry.name.startsWith(".")) continue;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            if (excludeSet.has(entry.name)) continue;
            walk(full);
          } else if (entry.isFile()) {
            let size = 0;
            try { size = fs.statSync(full).size; } catch (e) { /* stat 失败按 0 处理，交给 readFileSync 报错 */ }
            scanFile(full, size);
          }
        }
      };
      // path 既可能是目录也可能是单个文件: 文件直接搜, 目录递归遍历
      // 修复: 旧实现无视 path 类型一律 readdirSync, 传入文件路径时 ENOTDIR 被吞,
      //       静默返回"扫描 0 个文件", 误导调用方以为无匹配
      let stat;
      try {
        stat = fs.statSync(rootDir);
      } catch (e) {
        if (e.code === "ENOENT") {
          return { content: [{ type: "text", text: "❌ 路径不存在: " + rootDir }], isError: true };
        }
        return { content: [{ type: "text", text: "❌ 无法访问路径: " + e.message }], isError: true };
      }
      if (stat.isFile()) {
        scanFile(rootDir, stat.size);
      } else if (stat.isDirectory()) {
        walk(rootDir);
      }
      let text = results.join("\n");
      if (results.length === 0) {
        let parts = ["未找到匹配项（扫描 " + scanned + " 个文件，根目录: " + rootDir + "）"];
        if (skippedBinary) parts.push("跳过二进制文件 " + skippedBinary + " 个");
        if (skippedLarge) parts.push("跳过超大文件(" + (SCAN_MAX_BYTES / 1024 / 1024) + "MB+) " + skippedLarge + " 个");
        text = parts.join("，");
      } else {
        text = "找到 " + results.length + " 处匹配（" + matchedFiles + " 个文件，扫描 " + scanned + " 个文件）:\n" + text;
        if (truncated) text += "\n... 结果已达上限 " + limit + "，被截断。可通过 maxResults 调大。";
        if (skippedBinary || skippedLarge) {
          text += "\nℹ️ 已跳过: 二进制文件 " + skippedBinary + " 个，超大文件 " + skippedLarge + " 个。";
        }
      }
      return { content: [{ type: "text", text }] };
    } catch (e) {
      return { content: [{ type: "text", text: "❌ 搜索失败: " + e.message }], isError: true };
    }
  }
);

// 注册 create_directory 工具（递归创建目录）
server.tool(
  "create_directory",
  "递归创建目录（类似 mkdir -p）。加密软件环境下，Node.js 白名单进程操作目录同样安全。",
  { path: z.string().describe("要创建的目录路径，支持相对路径或绝对路径") },
  async ({ path: dirPath }) => {
    try {
      fs.mkdirSync(dirPath, { recursive: true });
      return { content: [{ type: "text", text: "✅ 目录已创建（或已存在）: " + dirPath }] };
    } catch (e) {
      return { content: [{ type: "text", text: "❌ 创建目录失败: " + e.message }], isError: true };
    }
  }
);

// 注册 file_info 工具（查询文件/目录信息）
server.tool(
  "file_info",
  "查询文件或目录的信息：是否存在、类型、大小、修改时间、符号链接等。注意：加密环境下 stat.size 反映的是密文字节数（与明文不一致），文件场景请以 sizePlaintext（明文字节数）为准。",
  { path: z.string().describe("文件或目录路径，支持相对路径或绝对路径") },
  { readOnlyHint: true },
  async ({ path: filePath }) => {
    try {
      // 用 lstat 不跟随符号链接：坏链接可区分「链接存在但目标丢失」与「真不存在」
      const lstat = fs.lstatSync(filePath);
      const isSymlink = lstat.isSymbolicLink();
      let stat = lstat;
      let targetInfo = null;
      if (isSymlink) {
        try {
          stat = fs.statSync(filePath); // 跟随链接取真实目标信息
          targetInfo = stat.isDirectory() ? "directory" : "file";
        } catch (e) {
          targetInfo = "broken（目标不存在）";
        }
      }
      const info = {
        path: filePath,
        exists: true,
        type: isSymlink ? "symlink" : lstat.isDirectory() ? "directory" : "file",
        ...(isSymlink ? { symlinkTarget: fs.readlinkSync(filePath), targetType: targetInfo } : {}),
        // 密文字节数：加密环境下的磁盘占用，与明文大小不一致
        sizeOnDisk: stat.size,
        // 明文字节数：仅普通文件场景提供；读取失败（非 UTF-16 拒绝/权限等）置 null 而非误导性的 0
        sizePlaintext: !isSymlink && !lstat.isDirectory()
          ? (() => { const r = readFileContent(filePath); return r.ok ? r.size : null; })()
          : null,
        modifiedTime: stat.mtime.toISOString(),
        createdTime: stat.birthtime.toISOString(),
      };
      return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
    } catch (e) {
      if (e.code === "ENOENT") {
        return { content: [{ type: "text", text: JSON.stringify({ path: filePath, exists: false }, null, 2) }] };
      }
      return { content: [{ type: "text", text: "❌ 查询失败: " + e.message }], isError: true };
    }
  }
);

// 注册 check_status 工具
server.tool(
  "check_status",
  "检查文件操作工具的运行状态。可选提供 path 参数做实测：真实读取该文件验证 Node.js 白名单解密能力（读到明文返回成功；不传则只做基础心跳检查，不验证解密）。",
  {
    path: z.string().optional().describe("可选。提供时实际读取该文件验证明文可读性（建议传一个已知的加密文件）"),
  },
  { readOnlyHint: true },
  async ({ path: filePath }) => {
    let base = "✅ read-file-server 运行中\n平台: Node.js " + process.version + "\n版本: " + pkg.version + "\n功能: 通过 Node.js fs 读写文件明文（加密软件白名单中的 Node.js 进程自动解密/加密）";
    // 环境自适应 profile 概要（懒加载，首次调用触发探测或读缓存）
    try {
      const prof = getProfile();
      base += "\n环境探测: safe=" + prof.safeExtensions.length + " 个, protected=" + prof.protectedExtensions.length + " 个, unsafe=" + prof.unsafeExtensions.length + " 个, encrypted=" + (prof.encryptedExtensions || []).length + " 个, 用户标注=" + (prof.userProtectedExtensions || []).length + " 个 | 可用进程: " + (prof.availableProcesses.map((x) => x.id).join(",") || "无") + " | bestCombo: " + (prof.bestCombo ? prof.bestCombo.process + "+" + prof.bestCombo.extension : "无") + "\n详情可用 encryption_profile 工具查看";
    } catch (e) {
      base += "\n环境探测: 失败（" + e.message + "），写工具按原始直写行为运行";
    }
    if (filePath === undefined) {
      base += "\n提示: 传入 path 参数可实测解密能力（本次未做实测）";
      return { content: [{ type: "text", text: base }] };
    }
    // 实测模式：真实读一次文件，验证白名单解密链路
    const result = readFileContent(filePath, 200);
    if (result.ok) {
      return {
        content: [{
          type: "text",
          text: base + "\n\n实测: 已成功读取 " + filePath + "（前 " + Math.min(result.content.length, 200) + " 字符，明文大小 " + result.size + " 字节）\n结论: Node.js 解密能力正常。",
        }],
      };
    } else {
      return {
        content: [{ type: "text", text: base + "\n\n实测: 读取 " + filePath + " 失败 -- " + result.error + "\n结论: Node.js 可能不在加密软件白名单，请联系管理员将 node.exe 加入白名单。" }],
        isError: true,
      };
    }
  }
);

// 注册 list_directory 工具（列目录，替代内置 LS）
server.tool(
  "list_directory",
  "列出指定目录的内容（文件与子目录清单），加密环境下替代内置 LS / bash ls。每项含名称、类型（file/directory/symlink）、大小与修改时间；默认不显示隐藏项。",
  {
    path: z.string().describe("目录路径，支持相对路径或绝对路径"),
    showHidden: z.boolean().optional().describe("是否包含以 . 开头的隐藏项，默认 false"),
  },
  { readOnlyHint: true },
  async ({ path: dirPath, showHidden }) => {
    try {
      const stat = fs.statSync(dirPath);
      if (!stat.isDirectory()) {
        return { content: [{ type: "text", text: "❌ 路径不是目录: " + dirPath }], isError: true };
      }
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      const lines = [];
      for (const entry of entries) {
        if (!showHidden && entry.name.startsWith(".")) continue;
        const full = path.join(dirPath, entry.name);
        let type = "file";
        let size = "";
        let mtime = "";
        try {
          const st = fs.lstatSync(full);
          if (st.isSymbolicLink()) type = "symlink";
          else if (st.isDirectory()) type = "directory";
          // 注意：size 为密文字节数（加密环境），仅供参考
          size = st.isDirectory() ? "-" : String(st.size);
          mtime = st.mtime.toISOString().replace("T", " ").slice(0, 19);
        } catch (e) { /* stat 失败时保留默认值 */ }
        lines.push(String(type === "directory" ? "DIR " : "FILE").padEnd(5) + " " + size.padStart(10) + "  " + mtime + "  " + entry.name);
      }
      const header = "目录: " + dirPath + "（共 " + lines.length + " 项" + (showHidden ? "" : "，不含隐藏项") + "）";
      return { content: [{ type: "text", text: lines.length ? header + "\n" + lines.join("\n") : header + "\n（空目录或全部被隐藏项过滤）" }] };
    } catch (e) {
      if (e.code === "ENOENT") {
        return { content: [{ type: "text", text: "❌ 目录不存在: " + dirPath }], isError: true };
      }
      return { content: [{ type: "text", text: "❌ 列目录失败: " + e.message }], isError: true };
    }
  }
);

// 注册 find_files 工具（按文件名 glob 查找，替代内置 Glob）
server.tool(
  "find_files",
  "按文件名 glob 模式递归查找文件/目录（如 *.test.js、**/*.java、src/**/*.ts），加密环境下替代内置 Glob / bash find。默认跳过 node_modules、.git 等依赖与构建目录。",
  {
    pattern: z.string().describe("glob 模式，如 *.java、**/*.test.js、src/**/*.ts。* 不跨目录，** 跨目录"),
    path: z.string().describe("搜索根目录，支持相对路径或绝对路径"),
    maxResults: z.number().int().positive().optional().describe("最大返回条数（正整数），默认 500"),
  },
  { readOnlyHint: true },
  async ({ pattern, path: rootDir, maxResults }) => {
    try {
      const limit = maxResults || 500;
      const regex = globToRegex(pattern.replace(/\\/g, "/"));
      const results = [];
      let truncated = false;
      // 与 search_files 一致的默认忽略列表，另含隐藏目录
      const IGNORE = ["node_modules", ".git", "target", "build", "dist", ".idea", ".vscode", ".svn", "bin", "obj", "out", "vendor"];
      const walk = (dir) => {
        if (truncated) return;
        let entries;
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch (e) {
          return;
        }
        for (const entry of entries) {
          if (truncated) return;
          if (entry.name.startsWith(".")) continue;
          const full = path.join(dir, entry.name);
          const rel = path.relative(rootDir, full).replace(/\\/g, "/");
          if (regex.test(rel)) {
            results.push((entry.isDirectory() ? "DIR  " : "FILE ") + full);
            if (results.length >= limit) { truncated = true; return; }
          }
          if (entry.isDirectory()) {
            if (!IGNORE.includes(entry.name)) walk(full);
          }
        }
      };
      let stat;
      try {
        stat = fs.statSync(rootDir);
      } catch (e) {
        if (e.code === "ENOENT") {
          return { content: [{ type: "text", text: "❌ 路径不存在: " + rootDir }], isError: true };
        }
        return { content: [{ type: "text", text: "❌ 无法访问路径: " + e.message }], isError: true };
      }
      // 根路径本身也参与匹配（如 pattern 恰好等于根目录名）
      if (!stat.isDirectory()) {
        return { content: [{ type: "text", text: "❌ 路径不是目录: " + rootDir }], isError: true };
      }
      walk(rootDir);
      let text;
      if (results.length === 0) {
        text = "未找到匹配 " + pattern + " 的文件（根目录: " + rootDir + "）";
      } else {
        text = "找到 " + results.length + " 个匹配（根目录: " + rootDir + "）:\n" + results.join("\n");
        if (truncated) text += "\n... 结果已达上限 " + limit + "，被截断。可通过 maxResults 调大。";
      }
      return { content: [{ type: "text", text }] };
    } catch (e) {
      return { content: [{ type: "text", text: "❌ 查找失败: " + e.message }], isError: true };
    }
  }
);

// 注册 copy_path 工具（复制文件/目录，替代 bash cp）
server.tool(
  "copy_path",
  "复制文件或目录（目录递归复制）。加密环境下必须经 Node.js 白名单进程复制（bash cp 产出密文/双重加密文件，在白名单视图下即损坏）。目标已存在时：文件被覆盖，目录合并。",
  {
    source: z.string().describe("源路径（文件或目录）"),
    destination: z.string().describe("目标路径。目标已存在时文件覆盖、目录合并；不存在时自动创建"),
  },
  async ({ source, destination }) => {
    try {
      // 单次 stat 消除 existsSync+statSync 双调用的竞态窗口
      let srcStat;
      try {
        srcStat = fs.statSync(source);
      } catch (e) {
        if (e.code === "ENOENT") {
          return { content: [{ type: "text", text: "❌ 源路径不存在: " + source }], isError: true };
        }
        throw e;
      }
      // 目标为已存在目录时，将源合并/放入目标目录下（与 bash cp 的自然预期一致）
      let finalDest = destination;
      let destDirStat = null;
      try {
        destDirStat = fs.statSync(destination);
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
      if (destDirStat && destDirStat.isDirectory() && path.basename(source)) {
        finalDest = path.join(destination, path.basename(source));
      }
      let destStat = null;
      try {
        destStat = fs.statSync(finalDest);
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
      // 类型冲突检查：文件 -> 已有目录 或 目录 -> 已有文件，均直接报错避免误操作
      if (srcStat.isFile() && destStat && destStat.isDirectory()) {
        return { content: [{ type: "text", text: "❌ 无法复制：源是文件但目标是已存在的目录: " + finalDest }], isError: true };
      }
      if (srcStat.isDirectory() && destStat && destStat.isFile()) {
        return { content: [{ type: "text", text: "❌ 无法复制：源是目录但目标是已存在的文件: " + finalDest }], isError: true };
      }
      // 环境自适应：文件目标扩展名为 unsafe/encrypted 时，cpSync 直写会产生密文，
      // 改走 safeCopy（安全扩展名中转 + 外部进程落盘）；目录暂不逐个处理，维持原行为。
      // 未知扩展名直写后实测磁盘状态（仅对有内容的源文件），发现密文自动重分类并纠正
      const copyDecision = srcStat.isFile() ? decideWriteStrategy(finalDest) : null;
      if (srcStat.isFile() && copyDecision.mode === "safe") {
        const sc = safeCopyFileTo(source, finalDest);
        if (sc.ok) {
          return { content: [{ type: "text", text: "✅ 复制成功: " + source + " -> " + finalDest + "\nℹ️ 目标扩展名为 " + copyDecision.category + "（写入会加密），已走 safeCopy 明文落盘（" + sc.via.process + " + " + sc.via.extension + "）" }] };
        }
        // 全部组合失败：回退 cpSync 直写并告警
        fs.cpSync(source, finalDest, { force: true });
        return { content: [{ type: "text", text: "⚠️ 已复制但磁盘可能为不可解密密文：目标扩展名为 " + copyDecision.category + " 且 safeCopy 全部组合失败（" + sc.error + "），已回退直接复制: " + finalDest }], isError: true };
      }
      fs.cpSync(source, finalDest, { recursive: srcStat.isDirectory(), force: true });
      if (srcStat.isFile() && copyDecision && copyDecision.category !== "user_protected" && srcStat.size > 0) {
        const cpProfile = getProfile();
        if (cpProfile.postWriteDetectionEnabled) {
          const ds = detectDiskStateAfterWrite(finalDest, fs.readFileSync(finalDest, "utf-8"));
          if (!ds.diskPlaintext) {
            const sc2 = safeCopyFileTo(source, finalDest);
            if (sc2.ok) {
              return { content: [{ type: "text", text: "✅ 复制成功: " + source + " -> " + finalDest + "\nℹ️ 复制后实测磁盘为密文，已自动重分类该扩展名并用 safeCopy 重写为明文（" + sc2.via.process + " + " + sc2.via.extension + "）" }] };
            }
            return { content: [{ type: "text", text: "⚠️ 复制后磁盘为密文且自动纠正失败（" + sc2.error + "），目标文件可能为密文: " + finalDest }], isError: true };
          }
        }
      }
      return { content: [{ type: "text", text: "✅ 复制成功: " + source + " -> " + finalDest + (srcStat.isDirectory() ? "（递归目录）" : "") }] };
    } catch (e) {
      return { content: [{ type: "text", text: "❌ 复制失败: " + e.message }], isError: true };
    }
  }
);

// 注册 move_path 工具（移动/重命名，替代 bash mv）
server.tool(
  "move_path",
  "移动或重命名文件/目录。同盘符用 rename（原子操作），跨盘符自动回退为复制后删除源。加密环境下替代 bash mv。",
  {
    source: z.string().describe("源路径（文件或目录）"),
    destination: z.string().describe("目标路径。目标已存在的目录则移入其下；目标已存在的文件则覆盖"),
  },
  async ({ source, destination }) => {
    try {
      // 单次 stat 消除双调用竞态
      let srcStat;
      try {
        srcStat = fs.statSync(source);
      } catch (e) {
        if (e.code === "ENOENT") {
          return { content: [{ type: "text", text: "❌ 源路径不存在: " + source }], isError: true };
        }
        throw e;
      }
      let finalDest = destination;
      // 目标为已存在目录时移入其下（与 bash mv 预期一致）
      try {
        const st = fs.statSync(destination);
        if (st.isDirectory()) finalDest = path.join(destination, path.basename(source));
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
      // 环境自适应：文件目标扩展名为 unsafe/encrypted 时，rename 会把源文件的磁盘状态
      // 原样带到加密扩展名上（密文改名后无法解密），改走 safeCopy 明文落盘后删源。
      // 未知扩展名 rename 后实测磁盘状态（仅非空文件），发现密文自动重分类并纠正
      const moveDecision = srcStat.isFile() ? decideWriteStrategy(finalDest) : null;
      if (srcStat.isFile() && moveDecision.mode === "safe") {
        const sm = safeCopyFileTo(source, finalDest);
        if (sm.ok) {
          fs.rmSync(source, { force: true });
          return { content: [{ type: "text", text: "✅ 移动成功: " + source + " -> " + finalDest + "\nℹ️ 目标扩展名为 " + moveDecision.category + "（写入会加密），已走 safeCopy 明文落盘（" + sm.via.process + " + " + sm.via.extension + "）并删除源" }] };
        }
        // safeCopy 失败则继续走下方 rename 原逻辑（保持兜底行为）
      }
      let moved = false;
      let moveNote = "";
      try {
        fs.renameSync(source, finalDest);
        moved = true;
      } catch (e) {
        if (e.code === "EXDEV") {
          // 跨盘符：rename 不可用，回退为 cp + rm
          fs.cpSync(source, finalDest, { recursive: srcStat.isDirectory(), force: true });
          fs.rmSync(source, { recursive: srcStat.isDirectory(), force: true });
          moved = true;
          moveNote = "（跨盘符，复制后删除源）";
        } else {
          throw e;
        }
      }
      // rename 是否触发透明加密因加密软件实现而异：实测目标磁盘状态，
      // 密文则用 safeCopy 纠正（此时源已不存在，从目标读回明文经临时文件中转重写）
      if (srcStat.isFile() && moveDecision && moveDecision.category !== "user_protected" && srcStat.size > 0) {
        const mvProfile = getProfile();
        if (mvProfile.postWriteDetectionEnabled) {
          const ds = detectDiskStateAfterWrite(finalDest, fs.readFileSync(finalDest, "utf-8"));
          if (!ds.diskPlaintext) {
            const sm2 = safeCopyFileTo(finalDest, finalDest);
            if (sm2.ok) {
              return { content: [{ type: "text", text: "✅ 移动成功" + moveNote + ": " + source + " -> " + finalDest + "\nℹ️ 移动后实测磁盘为密文，已自动重分类该扩展名并用 safeCopy 重写为明文（" + sm2.via.process + " + " + sm2.via.extension + "）" }] };
            }
            return { content: [{ type: "text", text: "⚠️ 移动后磁盘为密文且自动纠正失败（" + sm2.error + "），目标文件可能为密文: " + finalDest }], isError: true };
          }
        }
      }
      return { content: [{ type: "text", text: "✅ 移动成功" + moveNote + ": " + source + " -> " + finalDest }] };
    } catch (e) {
      if (e.code === "ENOENT") {
        return { content: [{ type: "text", text: "❌ 源路径不存在: " + source }], isError: true };
      }
      return { content: [{ type: "text", text: "❌ 移动失败: " + e.message }], isError: true };
    }
  }
);

// 注册 remove_path 工具（删除文件/目录，替代 bash rm）
server.tool(
  "remove_path",
  "删除文件或目录（目录默认递归删除，不可恢复，请谨慎使用）。加密环境下替代 bash rm。可选 recursive=false 时目录必须为空才可删除。",
  {
    path: z.string().describe("要删除的文件或目录路径"),
    recursive: z.boolean().optional().describe("目录是否递归删除，默认 true。false 时目录非空会报错"),
  },
  async ({ path: targetPath, recursive }) => {
    try {
      const stat = fs.statSync(targetPath);
      if (stat.isDirectory()) {
        // 递归删除前统计内容数量，写入结果让调用方有迹可查
        let count = 0;
        try {
          count = fs.readdirSync(targetPath).length;
        } catch (e) { /* 统计失败不影响删除 */ }
        fs.rmSync(targetPath, { recursive: recursive !== false, force: false });
        return { content: [{ type: "text", text: "✅ 已删除目录" + (recursive !== false && count ? "（含 " + count + " 项内容）" : "") + ": " + targetPath }] };
      }
      fs.rmSync(targetPath, { force: false });
      return { content: [{ type: "text", text: "✅ 已删除文件: " + targetPath }] };
    } catch (e) {
      if (e.code === "ENOENT") {
        return { content: [{ type: "text", text: "❌ 路径不存在: " + targetPath }], isError: true };
      }
      if (e.code === "ENOTEMPTY" || e.code === "EISDIR" || e.code === "ERR_FS_EISDIR") {
        // rmSync 对非空目录且 recursive=false 在 Linux 抛 ENOTEMPTY，Windows 新版 Node 抛 ERR_FS_EISDIR
        return { content: [{ type: "text", text: "❌ 目录非空，需 recursive=true（默认）才能递归删除: " + targetPath }], isError: true };
      }
      return { content: [{ type: "text", text: "❌ 删除失败: " + e.message }], isError: true };
    }
  }
);

// 启动服务
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
