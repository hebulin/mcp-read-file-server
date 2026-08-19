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
 */
const fs = require("fs");
const path = require("path");
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
      fs.writeFileSync(filePath, finalContent, { encoding: "utf-8", flag: writeMode === "append" ? "a" : "w" });
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

// 注册 edit_file 工具（精确替换，替代受加密影响的 Edit/MultiEdit）
server.tool(
  "edit_file",
  "对文件内容做精确字符串或正则替换后写回（明文）。字符串匹配自动兼容 CRLF/LF 换行差异，替换文本行尾自动跟随文件主导风格。加密软件环境下内置 Edit/MultiEdit 直写会破坏加密，本工具用 Node.js fs 读改写，自动加密落盘。替代内置 Edit/MultiEdit 工具。",
  {
    path: z.string().describe("文件路径，支持相对路径或绝对路径"),
    oldString: z.string().describe("要被替换的原字符串。useRegex=true 时作为正则表达式"),
    newString: z.string().describe("替换后的字符串。正则模式下可用 $1 $2 等捕获组引用"),
    useRegex: z.boolean().optional().describe("是否将 oldString 当作正则表达式，默认 false（纯字符串匹配）"),
    replaceAll: z.boolean().optional().describe("是否替换全部匹配项，默认 false 仅替换第一处"),
    ignoreCase: z.boolean().optional().describe("是否忽略大小写，默认 false。仅在非正则的字符串模式下生效"),
  },
  async ({ path: filePath, oldString, newString, useRegex, replaceAll, ignoreCase }) => {
    try {
      // readFileContent 会剥离 BOM 并记录，写回时补回，避免 oldString 匹配首行失败
      const readResult = readFileContent(filePath);
      if (!readResult.ok) {
        return { content: [{ type: "text", text: "❌ " + readResult.error }], isError: true };
      }
      const original = readResult.content;
      const hasBom = readResult.hasBom;
      // 非 UTF-8 防护：GBK 等编码按 UTF-8 读入会产生大量 U+FFFD，此时做任何替换再写回，
      // 原始字节信息会永久丢失（不可逆损坏）。检测到即拒绝编辑并明确提示。
      if (isLikelyNonUtf8(original)) {
        return {
          content: [{ type: "text", text: "❌ 文件疑似非 UTF-8 编码（GBK 等），按 UTF-8 读取出现大量乱码替换字符，继续编辑写回会不可逆损坏文件，已拒绝操作: " + filePath + "\n建议：先确认文件编码，转换为 UTF-8 后再编辑。" }],
          isError: true,
        };
      }
      // 文件主导换行风格：CRLF 文件写入的替换文本也转成 CRLF，保持文件风格统一
      const fileEol = detectEol(original);
      const normalizedNew = normalizeEol(newString, fileEol);
      let matcher;
      if (useRegex) {
        try {
          // 正则模式默认附加 m 标志：^/$ 按行锚定（Agent 常用行级正则习惯），JS 无内联标志无法由调用方自行开启
          const flags = (replaceAll ? "g" : "") + "m" + (ignoreCase ? "i" : "");
          matcher = new RegExp(oldString, flags);
        } catch (e) {
          return { content: [{ type: "text", text: "❌ 正则表达式无效: " + e.message }], isError: true };
        }
      }
      let count;
      let updated;
      let eolAdapted = false; // 是否触发了换行符兼容替换
      if (useRegex) {
        // 计数与替换均带 m 标志，保持与构造 matcher 时一致
        const globalMatcher = new RegExp(matcher.source, "gm" + (ignoreCase ? "i" : ""));
        const matches = original.match(globalMatcher);
        count = matches ? matches.length : 0;
        const replaceMatcher = replaceAll ? globalMatcher : new RegExp(matcher.source, "m" + (ignoreCase ? "i" : ""));
        updated = original.replace(replaceMatcher, normalizedNew);
      } else {
        if (oldString === "") {
          return { content: [{ type: "text", text: "❌ oldString 不能为空字符串" }], isError: true };
        }
        // 第一优先：原样精确匹配（字节级一致，最安全）
        let idx = 0, c = 0;
        const hay = ignoreCase ? original.toLowerCase() : original;
        const needle = ignoreCase ? oldString.toLowerCase() : oldString;
        while ((idx = hay.indexOf(needle, idx)) !== -1) { c++; idx += needle.length; }
        count = c;
        if (count > 0) {
          if (replaceAll) {
            const esc = oldString.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            // 用函数替换避免 newString 中的 $& $1 等被误解析为替换模式
            updated = original.replace(new RegExp(esc, ignoreCase ? "gi" : "g"), () => normalizedNew);
          } else {
            const pos = hay.indexOf(needle);
            updated = original.slice(0, pos) + normalizedNew + original.slice(pos + oldString.length);
          }
        } else {
          // 第二优先：换行符兼容匹配。文件是 CRLF 而 oldString 用 LF（或相反）时，
          // 字节级比对必然失败，这里归一换行后再匹配，命中即记为换行适配替换
          const adapted = eolInsensitiveReplace(original, oldString, normalizedNew, replaceAll, ignoreCase);
          if (adapted) {
            count = adapted.count;
            updated = adapted.updated;
            eolAdapted = true;
          } else {
            count = 0;
            updated = original;
          }
        }
      }
      if (count === 0) {
        return {
          content: [{ type: "text", text: "⚠️ 未找到匹配内容，文件未修改。请检查 oldString（或正则）是否正确: " + filePath + "\n提示：若内容本身无误，请确认文件与 oldString 的换行风格（CRLF/LF）及空白字符是否一致。" }],
          isError: true,
        };
      }
      let warning = "";
      if (eolAdapted) {
        warning = "\nℹ️ 换行符已自动适配：oldString 与文件换行风格不一致（CRLF/LF），已按换行归一化匹配完成替换。";
      }
      if (!replaceAll && count > 1) {
        warning += "\n⚠️ 注意：共匹配 " + count + " 处，但 replaceAll=false 仅替换了第一处。如需全部替换请设 replaceAll=true。";
      }
      if (updated === original) {
        return { content: [{ type: "text", text: "⚠️ 替换后内容无变化，文件未修改: " + filePath }] };
      }
      // 原文件带 BOM 时补回，保持文件编码特征不变（部分 Windows 软件依赖 BOM）
      fs.writeFileSync(filePath, (hasBom ? "\uFEFF" : "") + updated, "utf-8");
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
      fs.cpSync(source, finalDest, { recursive: srcStat.isDirectory(), force: true });
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
      try {
        fs.renameSync(source, finalDest);
        return { content: [{ type: "text", text: "✅ 移动成功: " + source + " -> " + finalDest }] };
      } catch (e) {
        if (e.code === "EXDEV") {
          // 跨盘符：rename 不可用，回退为 cp + rm
          fs.cpSync(source, finalDest, { recursive: srcStat.isDirectory(), force: true });
          fs.rmSync(source, { recursive: srcStat.isDirectory(), force: true });
          return { content: [{ type: "text", text: "✅ 移动成功（跨盘符，复制后删除源）: " + source + " -> " + finalDest }] };
        }
        throw e;
      }
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
