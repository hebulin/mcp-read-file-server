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
 *   - read_file      读取单个文件明文（替代内置 Read）
 *   - read_files     批量读取多个文件明文
 *   - write_file     写入文件，自动加密落盘（替代内置 Write）
 *   - edit_file      精确字符串/正则替换后写回（替代内置 Edit/MultiEdit）
 *   - search_files   递归搜索文件内容（替代内置 Grep）
 *   - create_directory  递归创建目录
 *   - file_info      查询文件/目录信息
 *   - check_status   检查工具运行状态
 */
const fs = require("fs");
const path = require("path");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = require("zod");

const server = new McpServer({ name: "read-file-server", version: "1.0.0" });

/**
 * 读取文件内容。Node.js 进程被加密软件列为白名单，fs.readFileSync 可自动解密读到明文。
 */
function readFileContent(filePath) {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    // 加密环境下 stat.size 是密文字节数，与明文长度不一致，改用明文字节数避免误导
    return { ok: true, content, size: Buffer.byteLength(content, "utf-8") };
  } catch (e) {
    if (e.code === "ENOENT") {
      return { ok: false, error: "文件不存在: " + filePath };
    }
    return { ok: false, error: "读取失败（可能是密文，请确认 Node.js 是否被加密软件列为白名单进程）: " + e.message };
  }
}

// 注册 read_file 工具
server.tool(
  "read_file",
  "读取指定路径的文件内容（明文）。加密软件环境下，Node.js 进程作为白名单可自动解密读取明文。适用于读取代码、配置、文档等文本文件。替代内置 Read 工具。",
  { path: z.string().describe("文件路径，支持相对路径或绝对路径") },
  { readOnlyHint: true },
  async ({ path: filePath }) => {
    const result = readFileContent(filePath);
    if (result.ok) {
      return { content: [{ type: "text", text: result.content }] };
    } else {
      return { content: [{ type: "text", text: "❌ " + result.error }], isError: true };
    }
  }
);

// 注册 read_files 工具（批量读取）
server.tool(
  "read_files",
  "批量读取多个文件的内容（明文）。多个路径用逗号分隔。加密软件环境下通过 Node.js 白名单进程自动解密。",
  { paths: z.string().describe("文件路径列表，多个路径用英文逗号分隔") },
  { readOnlyHint: true },
  async ({ paths: pathsStr }) => {
    const pathList = pathsStr.split(",").map(p => p.trim()).filter(p => p);
    if (!pathList.length) {
      return { content: [{ type: "text", text: "❌ 未提供任何文件路径" }], isError: true };
    }
    const results = [];
    for (const p of pathList) {
      const result = readFileContent(p);
      if (result.ok) {
        results.push("========== 文件: " + p + " ==========\n" + result.content);
      } else {
        results.push("========== 文件: " + p + " 【读取失败】 ==========\n❌ " + result.error);
      }
    }
    return { content: [{ type: "text", text: results.join("\n\n") }] };
  }
);

// 注册 write_file 工具（加密软件环境下安全写回）
server.tool(
  "write_file",
  "将内容写入指定路径（明文）。加密软件环境下，Node.js 白名单进程写入会自动加密落盘，适用于安全写回加密文件。替代内置 Write 工具。",
  {
    path: z.string().describe("文件路径，支持相对路径或绝对路径"),
    content: z.string().describe("写入的文件内容（明文）"),
  },
  async ({ path: filePath, content }) => {
    try {
      // 自动创建父目录，避免新文件路径不存在时直接报错
      const parent = path.dirname(filePath);
      if (parent && !fs.existsSync(parent)) {
        fs.mkdirSync(parent, { recursive: true });
      }
      fs.writeFileSync(filePath, content, "utf-8");
      return { content: [{ type: "text", text: "✅ 写入成功: " + filePath }] };
    } catch (e) {
      return { content: [{ type: "text", text: "❌ 写入失败: " + e.message }], isError: true };
    }
  }
);

// 注册 edit_file 工具（精确替换，替代受加密影响的 Edit/MultiEdit）
server.tool(
  "edit_file",
  "对文件内容做精确字符串或正则替换后写回（明文）。加密软件环境下内置 Edit/MultiEdit 直写会破坏加密，本工具用 Node.js fs 读改写，自动加密落盘。替代内置 Edit/MultiEdit 工具。",
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
      const original = fs.readFileSync(filePath, "utf-8");
      let matcher;
      if (useRegex) {
        try {
          const flags = replaceAll ? "g" : "";
          matcher = new RegExp(oldString, ignoreCase ? flags + "i" : flags);
        } catch (e) {
          return { content: [{ type: "text", text: "❌ 正则表达式无效: " + e.message }], isError: true };
        }
      }
      let count;
      let updated;
      if (useRegex) {
        const globalMatcher = new RegExp(matcher.source, "g" + (ignoreCase ? "i" : ""));
        const matches = original.match(globalMatcher);
        count = matches ? matches.length : 0;
        const replaceMatcher = replaceAll ? globalMatcher : new RegExp(matcher.source, ignoreCase ? "i" : "");
        updated = original.replace(replaceMatcher, newString);
      } else {
        if (oldString === "") {
          return { content: [{ type: "text", text: "❌ oldString 不能为空字符串" }], isError: true };
        }
        let idx = 0, c = 0;
        const hay = ignoreCase ? original.toLowerCase() : original;
        const needle = ignoreCase ? oldString.toLowerCase() : oldString;
        while ((idx = hay.indexOf(needle, idx)) !== -1) { c++; idx += needle.length; }
        count = c;
        if (replaceAll) {
          const esc = oldString.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          updated = original.replace(new RegExp(esc, ignoreCase ? "gi" : "g"), newString);
        } else {
          const pos = ignoreCase ? hay.indexOf(needle) : original.indexOf(oldString);
          if (pos === -1) {
            updated = original;
          } else {
            updated = original.slice(0, pos) + newString + original.slice(pos + oldString.length);
          }
        }
      }
      if (count === 0) {
        return {
          content: [{ type: "text", text: "⚠️ 未找到匹配内容，文件未修改。请检查 oldString（或正则）是否正确: " + filePath }],
          isError: true,
        };
      }
      let warning = "";
      if (!replaceAll && count > 1) {
        warning = "\n⚠️ 注意：共匹配 " + count + " 处，但 replaceAll=false 仅替换了第一处。如需全部替换请设 replaceAll=true。";
      }
      if (updated === original) {
        return { content: [{ type: "text", text: "⚠️ 替换后内容无变化，文件未修改: " + filePath }] };
      }
      fs.writeFileSync(filePath, updated, "utf-8");
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
  "在指定目录递归搜索文件内容（明文）。加密软件环境下内置 Grep(ripgrep) 只能读到密文搜不到内容，本工具用 Node.js fs 读取后正则匹配。替代内置 Grep 工具。",
  {
    pattern: z.string().describe("正则表达式（如 log.*Error、function\\s+\\w+）"),
    path: z.string().describe("搜索根目录，支持相对路径或绝对路径"),
    include: z.string().optional().describe("文件名 glob 过滤，多个用逗号分隔（如 *.java,*.xml）。不传则搜索全部文件"),
    ignoreCase: z.boolean().optional().describe("是否忽略大小写，默认 false"),
    onlyMatching: z.boolean().optional().describe("是否只输出匹配部分（非整行），默认 false 输出整行"),
    maxResults: z.number().optional().describe("最大返回匹配数，默认 200。超过会在末尾提示被截断"),
  },
  { readOnlyHint: true },
  async ({ pattern, path: rootDir, include, ignoreCase, onlyMatching, maxResults }) => {
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
      const matchesInclude = (name) => {
        if (!includeList) return true;
        return includeList.some((pat) => {
          const re = new RegExp("^" + pat.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
          return re.test(name);
        });
      };
      const limit = maxResults || 200;
      const results = [];
      let truncated = false;
      let scanned = 0;
      let matchedFiles = 0;
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
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            if (["node_modules", ".git", "target", "build", "dist", ".idea", ".vscode"].includes(entry.name)) continue;
            walk(full);
          } else if (entry.isFile()) {
            if (!matchesInclude(entry.name)) continue;
            scanned++;
            let content;
            try {
              content = fs.readFileSync(full, "utf-8");
            } catch (e) {
              continue;
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
          }
        }
      };
      walk(rootDir);
      let text = results.join("\n");
      if (results.length === 0) {
        text = "未找到匹配项（扫描 " + scanned + " 个文件，根目录: " + rootDir + "）";
      } else {
        text = "找到 " + results.length + " 处匹配（" + matchedFiles + " 个文件，扫描 " + scanned + " 个文件）:\n" + text;
        if (truncated) text += "\n... 结果已达上限 " + limit + "，被截断。可通过 maxResults 调大。";
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
  "查询文件或目录的信息：是否存在、类型、大小、修改时间等。加密软件环境下 stat 不读内容，结果准确。",
  { path: z.string().describe("文件或目录路径，支持相对路径或绝对路径") },
  { readOnlyHint: true },
  async ({ path: filePath }) => {
    try {
      const stat = fs.statSync(filePath);
      const info = {
        path: filePath,
        exists: true,
        type: stat.isDirectory() ? "directory" : "file",
        size: stat.size,
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
  "检查文件操作工具的运行状态，确认 Node.js 进程能否正常读取加密文件明文。",
  {},
  { readOnlyHint: true },
  async () => {
    return { content: [{ type: "text", text: "✅ read-file-server 运行中\n平台: Node.js " + process.version + "\n功能: 通过 Node.js fs 读写文件明文（加密软件白名单中的 Node.js 进程自动解密/加密）" }] };
  }
);

// 启动服务
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
