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

## 在新电脑上使用

只需拷贝 2 个文件：
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
