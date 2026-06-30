# 文件操作 MCP Server（加密软件环境明文读写）

## 简介

加密环境文件操作工具。当 Node.js 是加密软件白名单进程时，通过 fs 模块自动解密读写文件明文，替代 AI Agent 内置文件工具，解决加密环境下读到密文的问题。适用于任何支持 MCP 协议的 AI Agent。

## 适用场景

电脑安装了文件加密软件（如天锐绿盾、IP-Guard、亿赛通、深信服等），磁盘上的文件是密文。AI Agent（Claude Code、Cursor、Windsurf、Cline 等）是独立进程，内置文件工具不在白名单内，只能读到密文。而 Node.js 进程在白名单内，通过 MCP Server 提供的替代工具可以正常读写明文。

**前提条件：Node.js 进程已被加密软件列为白名单（受信任进程）。**

## 支持的 AI Agent

本 MCP Server 遵循标准 MCP 协议，任何支持 MCP 的 Agent 均可使用：

| Agent | 配置方式 |
|-------|---------|
| Claude Code CLI | `.mcp.json` 或 `claude mcp add` |
| Cursor | Settings → MCP → 添加 Server |
| Windsurf | MCP 配置中添加 |
| Cline / Roo Code | MCP 设置中添加 |
| Continue.dev | `config.json` 中配置 MCP |
| Zed | `settings.json` 中配置 MCP |
| 其他支持 MCP 的工具 | 按各自文档配置 |

## 架构

```
AI Agent  --(MCP/stdio)-->  Node.js MCP Server  --(fs.readFileSync)-->  读取明文
```

## 文件结构

```
mcp-read-file-server/
├── README.md         # 本文档
├── SKILL.md          # 配套 Skill（可选，让 AI 学会自动选用本工具）
├── index.js          # MCP Server 主程序（源代码）
├── package.json      # 项目配置（依赖声明）
└── node_modules/     # 依赖（@modelcontextprotocol/sdk、zod）
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

## 配置

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

### Claude Code CLI

#### 方式一：项目级配置（仅当前项目可用）

在项目根目录创建 `.mcp.json` 文件：

```json
{
  "mcpServers": {
    "read-file-server": {
      "command": "node",
      "args": ["D:/AiJiamiToolsPlugins/mcp-read-file-server/index.js"]
    }
  }
}
```

#### 方式二：全局配置（所有项目可用）

```bash
claude mcp add read-file-server -s user -- node "D:/AiJiamiToolsPlugins/mcp-read-file-server/index.js"
```

参数说明：
- `read-file-server`：MCP Server 名称（自定义）
- `-s user`：作用域为全局（所有项目可用），不写则默认项目级
- `--`：分隔符，后面是实际执行的命令
- `node "..."`：实际执行的命令

#### 方式三：手动编辑全局配置文件

直接编辑 `C:\Users\你的用户名\.claude.json`，添加：

```json
{
  "mcpServers": {
    "read-file-server": {
      "command": "node",
      "args": ["D:/AiJiamiToolsPlugins/mcp-read-file-server/index.js"]
    }
  }
}
```

#### 验证配置

```bash
claude mcp list
```

应该能看到 `read-file-server` 在列表中。

### Cursor / Windsurf / Cline 等

在各自设置界面的 MCP 配置中，添加上述 JSON 配置。

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

## 使用

配置好后，在 Agent 中直接说需求即可。Agent 会自动调用 MCP 工具读写文件明文。

## 配套 Skill（可选）

本工具附带一份 Skill：`SKILL.md`，位于本目录根下。

| 项 | 说明 |
|----|------|
| 作用 | 教 AI Agent 在加密环境下主动选用 `mcp__read-file-server__*` 工具，避开内置 Read/Write/Edit/Grep |
| 当前状态 | `SKILL.md` 在工具根目录，**未安装**，需要按下面步骤复制到对应位置才生效 |
| 触发关键词 | 天锐、绿盾、密文、TSD、IP-Guard、亿赛通、白名单、读不到文件等 |

### 1. 安装到 Claude Code

Claude Code 启动时会自动扫描 `skills/` 目录，每个 Skill 必须是 `skill-name/SKILL.md` 的子目录结构。

| 作用域 | 安装位置 |
|--------|----------|
| 项目级（仅本项目） | `<本仓库>/.claude/skills/encryption-file-ops/SKILL.md` |
| 用户级（所有项目） | `~/.claude/skills/encryption-file-ops/SKILL.md` |

安装示例（项目级，从本目录执行）：

```bash
mkdir -p ../.claude/skills/encryption-file-ops
cp SKILL.md ../.claude/skills/encryption-file-ops/SKILL.md
```

安装后**重启 Claude Code** 即可生效。

### 2. 安装到 OpenClaw（小龙虾）

> ⚠️ 以下为通用约定写法，OpenClaw 的 Skill 加载机制请以其官方文档为准，确认后可对本节做相应调整。

**方式一：让 OpenClaw 自动安装**

把 `SKILL.md` 交给 OpenClaw，用自然语言让它自己装：

```
我把一个 Skill 文件放在 D:/AiJiamiToolsPlugins/mcp-read-file-server/SKILL.md，
请按 OpenClaw 的 Skill 规范把它安装到我的 skills 目录，并确认能否被加载。
```

OpenClaw 会读取文件、确认 frontmatter（`name` / `description`），并复制到它自己的 Skill 目录。装完后可让它自检：

```
列出你当前已加载的所有 Skill，确认 encryption-file-ops 是否在其中。
```

**方式二：手动复制**

```bash
# 以 OpenClaw 默认 skill 目录 ~/.openclaw/skills 为例
mkdir -p ~/.openclaw/skills/encryption-file-ops
cp SKILL.md ~/.openclaw/skills/encryption-file-ops/SKILL.md
```

> 配置目录名（`.openclaw`）仅为示例，请替换为 OpenClaw 实际使用的目录。

**方式三：项目级随仓库分发**

如果希望 Skill 跟随项目走（团队成员拉代码即生效），把 SKILL.md 放进项目的 Skill 扫描目录（例如 `<仓库根>/.openclaw/skills/encryption-file-ops/SKILL.md`），与 OpenClaw 的项目级 Skill 约定保持一致即可。

### 3. 验证安装

无论哪种 Agent，安装后重启客户端，然后：

1. 输入触发关键词测试，例如："这个项目里有文件加密，读文件是密文，怎么办？"
2. 观察是否自动选用 `mcp__read-file-server__*` 工具而非内置 Read/Grep


## 在新电脑上使用

只需拷贝 4 个文件：
- `README.md`（本文档）
- `SKILL.md`（配套 Skill，可选）
- `index.js`（源代码）
- `package.json`（依赖声明）

新电脑上运行 `npm install` 安装依赖，然后按目标 Agent 的方式配置 MCP 即可。

## 故障排查

### 读取到的仍是密文

说明 Node.js 未被加密软件列为白名单。解决方法：
- 联系加密软件管理员，将 `node.exe` 加入白名单
- 确认加密软件的受信任进程列表中包含 Node.js

### MCP Server 无法启动

```bash
# 验证 Node.js 和依赖
node --version
cd mcp-read-file-server && npm install

# 测试启动
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}}}' | node index.js
```
