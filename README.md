# mcp-read-file-server

加密环境文件操作 MCP Server。当 Node.js 是加密软件白名单进程时，通过 `fs` 模块自动解密读写文件明文，替代 AI Agent 内置文件工具，解决加密环境下读到密文的问题。

适用于任何支持 MCP 协议的 AI Agent。

---

## 适用场景

电脑安装了文件加密软件（如天锐绿盾、IP-Guard、亿赛通、深信服等），磁盘上的文件是密文。AI Agent（Claude Code、Cursor、Windsurf、Cline 等）是独立进程，内置文件工具不在白名单内，只能读到密文。而 Node.js 进程在白名单内，通过 MCP Server 提供的替代工具可以正常读写明文。

**前提条件：Node.js 进程已被加密软件列为白名单（受信任进程）。**

## 架构

```
AI Agent  --(MCP/stdio)-->  Node.js MCP Server  --(fs.readFileSync)-->  读取明文
```

## 文件结构

```
mcp-read-file-server/
├── README.md          # 本文档
├── SKILL.md           # 配套 Skill（可选，让 AI 学会自动选用本工具）
├── index.js           # MCP Server 主程序（源代码）
├── package.json       # 项目配置（依赖声明）
└── node_modules/      # 依赖
```

## 安装

### 前置条件

- Node.js v18+（推荐 v20+）
- Node.js 已被加密软件列为白名单进程

### 安装依赖

```bash
cd mcp-read-file-server
npm install
```

## 配置 MCP Server

所有 Agent 配置 MCP Server 的核心信息相同，只是配置文件位置和格式略有差异：

```json
{
  "mcpServers": {
    "read-file-server": {
      "command": "node",
      "args": ["/path/to/mcp-read-file-server/index.js"]
    }
  }
}
```

> **路径说明**：`args` 中的路径请替换为 `index.js` 在你本机的实际绝对路径。建议使用绝对路径避免歧义。

### 各 Agent 配置方式

| Agent | 配置方式 |
|-------|---------|
| **Claude Code CLI** | 项目级：项目根目录创建 `.mcp.json`；用户级：`claude mcp add read-file-server -s user -- node "/path/to/index.js"`；全局：编辑 `~/.claude.json` |
| **OpenClaw** | `openclaw mcp set read-file-server '{"command":"node","args":["/path/to/index.js"]}'`，或直接编辑 `openclaw.json` 中的 `mcp.servers` |
| **Cursor** | Settings → MCP → 添加 Server，粘贴上述 JSON |
| **Windsurf** | MCP 配置中添加上述 JSON |
| **Cline / Roo Code** | MCP 设置中添加上述 JSON |
| **Continue.dev** | `config.json` 中配置 MCP |
| **Zed** | `settings.json` 中配置 MCP |
| **其他支持 MCP 的工具** | 按各自文档配置 MCP Server |

### 验证配置

```bash
# Claude Code
claude mcp list

# OpenClaw
openclaw mcp list
```

应该能看到 `read-file-server` 在列表中。

## 提供的工具

| 工具名 | 替代内置 | 功能 | 参数 |
|--------|---------|------|------|
| `read_file` | Read | 读取单个文件明文 | `path`: 文件路径 |
| `read_files` | 多次 Read | 批量读取多个文件明文 | `paths`: 逗号分隔的路径 |
| `write_file` | Write | 写入文件（自动加密落盘） | `path`、`content` |
| `edit_file` | Edit/MultiEdit | 精确字符串/正则替换后写回 | `path`、`oldString`、`newString`、`useRegex`、`replaceAll`、`ignoreCase` |
| `search_files` | Grep | 递归搜索文件内容 | `pattern`、`path`、`include`、`ignoreCase`、`onlyMatching`、`maxResults` |
| `create_directory` | - | 递归创建目录 | `path` |
| `file_info` | - | 查询文件/目录信息 | `path` |
| `check_status` | - | 检查工具运行状态 | 无 |

> **注意**：不同 Agent 对 MCP 工具的命名方式不同。例如 OpenClaw 中工具名为 `mcp__read-file-server__read_file`，其他 Agent 可能直接使用 `read_file`。具体请参考目标 Agent 的 MCP 工具命名规范。

## 使用

配置好后，在 Agent 中直接说需求即可。Agent 会自动调用 MCP 工具读写文件明文。

使用示例：
- "读一下 `src/main.js` 的内容"
- "把 `config.json` 里的 `host` 改成 `localhost`"
- "在 `src/` 下搜索所有含 `axios` 的文件"
- "帮我建个 `dist/assets/` 目录"

## 配套 Skill（可选）

本工具附带一份 Skill：`SKILL.md`，位于本目录根下。它的作用是**教 AI Agent 在加密环境下主动选用本 MCP 工具，避开内置 Read/Write/Edit/Grep**。

| 项 | 说明 |
|----|------|
| 作用 | 让 AI Agent 在加密环境下主动选用本工具，避开内置文件操作 |
| 当前状态 | `SKILL.md` 在工具根目录，**未安装**，需要按下面步骤复制到对应位置才生效 |
| 触发关键词 | 天锐、绿盾、密文、TSD、IP-Guard、亿赛通、白名单、读不到文件等 |

### 安装到 Claude Code

| 作用域 | 安装位置 |
|--------|----------|
| 项目级（仅本项目） | `<项目根>/.claude/skills/encryption-file-ops/SKILL.md` |
| 用户级（所有项目） | `~/.claude/skills/encryption-file-ops/SKILL.md` |

```bash
mkdir -p ~/.claude/skills/encryption-file-ops
cp SKILL.md ~/.claude/skills/encryption-file-ops/SKILL.md
```

安装后重启 Claude Code 即可生效。

### 安装到 OpenClaw

```bash
mkdir -p ~/.openclaw/workspace/skills/encryption-file-ops
cp SKILL.md ~/.openclaw/workspace/skills/encryption-file-ops/SKILL.md
```

安装后重启 OpenClaw 会话即可生效。

### 安装到其他 Agent

将 `SKILL.md` 放入目标 Agent 的 Skill 加载目录（格式要求为 `skill-name/SKILL.md` 的子目录结构），具体参考各 Agent 的 Skill 文档。

### 验证安装

安装并重启 Agent 后，输入触发关键词测试，例如：
> "这个项目里有文件加密，读文件是密文，怎么办？"

观察是否自动选用本工具的 MCP 操作而非内置 Read/Grep。

## 在新电脑上使用

只需拷贝 4 个文件：

```
mcp-read-file-server/
├── README.md
├── SKILL.md         （可选）
├── index.js
└── package.json
```

新电脑上运行 `npm install` 安装依赖，然后按目标 Agent 的方式配置 MCP 即可。

## 故障排查

| 现象 | 可能原因 | 解决方案 |
|------|----------|----------|
| 读到的仍是密文/乱码 | Node.js 不在加密软件白名单 | 联系加密软件管理员，将 `node.exe` 加入白名单 |
| MCP 工具不可见 | MCP Server 未配置或未启动 | 检查 Agent 的 MCP 列表命令（如 `claude mcp list`） |
| `edit_file` 报"未找到匹配内容" | `oldString` 拼写、缩进、换行不对 | 重新 `read_file` 复制原文，不要凭记忆写 |
| `edit_file` 报"匹配到 N 处" | 文件中存在重复内容 | 加更长/更唯一的 `oldString` 唯一定位，或 `replaceAll=true` |
| `search_files` 报"正则表达式无效" | 正则语法错误 | 检查 `pattern` 是否需要转义特殊字符 |
| `write_file` 报权限错误 | 文件被占用或目录无写权限 | 关闭占用进程 / 检查目录权限 |
| 工具调用超时 | 文件过大 | 改用 `search_files` 定位后只 `read_file` 关键段 |

### 测试 MCP Server 是否能启动

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}}}' | node index.js
```

正常应无报错输出。
