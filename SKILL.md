---
name: encryption-file-ops
description: 在文件加密软件（天锐绿盾 / IP-Guard / 亿赛通 / 深信服等）环境下，使用 MCP Server 提供的替代工具（read_file / write_file / edit_file / search_files 等）替代 AI Agent 内置 Read/Write/Edit/Grep 工具读写明文。当内置工具返回密文/乱码，或用户提到"加密、绿盾、密文、白名单、读不到文件"等关键词时激活。
---

# 加密环境文件操作 Skill

> **本 Skill 负责"教策略"，MCP Server 负责"执行"。**
>
> 本 Skill 不替代任何 MCP 工具，仅提供使用指引。前提是 `mcp-read-file-server` 已按项目 README 配置到你的 Agent 中。

## 一、适用场景与触发条件

**满足任一即激活本 Skill：**

- 内置 `Read`/`Write`/`Edit`/`Grep` 工具返回密文、十六进制乱码、`%TSD-Header-###%` 文件头
- 用户提到关键词：天锐、绿盾、TSD、IP-Guard、亿赛通、深信服、加密软件、白名单、密文、解密失败
- 项目文件头出现 `%TSD-Header-###%` 等加密标识

**前置条件（必须满足）：**
- Node.js 进程已被加密软件列为**白名单（受信任进程）**
- `mcp-read-file-server` MCP Server **已配置并正常运行**（在 Agent 的 MCP 列表中能看到 `read-file-server`）

## 二、工具映射表

以下工具名以 MCP 协议原始名称为准。不同 Agent 可能对 MCP 工具有不同的命名规则：

- **Claude Code / Cursor / Cline 等大多数 Agent**：直接使用工具名，如 `read_file`
- **OpenClaw / 部分平台**：可能自动添加前缀，如 `mcp__read-file-server__read_file`

请根据你的 Agent 实际显示的工具名调用，以下表格使用通用名称。

| 场景 | 内置工具（禁用 ❌） | MCP 工具（用这个 ✅） |
|------|:-------------------|:--------------------|
| 读单个文件 | `Read` | `read_file` |
| 读 ≥2 个文件 | 多次 `Read` | `read_files` |
| 写文件 | `Write` | `write_file` |
| 精确编辑 | `Edit` / `MultiEdit` | `edit_file` |
| 搜索内容 | `Grep` | `search_files` |
| 创建目录 | （无） | `create_directory` |
| 查文件信息 | （无） | `file_info` |
| 健康检查 | （无） | `check_status` |

> **强约束**：在加密环境下，**禁止使用** `Read`/`Write`/`Edit`/`MultiEdit`/`Grep` 内置工具——它们会读到密文或破坏加密结构。

## 三、哪些工具在加密环境下安全可用

| 工具类型 | 可用？ | 说明 |
|:---------|:------:|:-----|
| 内置 `Read` / `Write` / `Edit` / `Grep` | ❌ 禁用 | 独立进程通常不在白名单，读到密文或破坏加密 |
| 终端 shell 原生命令（`cat`/`sed`/`grep`） | ⚠️ 慎用 | shell 进程通常不在白名单，同样读到密文 |
| MCP Server 提供的工具（`read_file` 等） | ✅ 主用 | Node.js 进程在白名单，可正常解密读写 |
| `node -e` 直接调用 `fs` 模块 | ✅ 可用 | Node.js 进程在白名单，效果等同于 MCP 工具 |
| 仅列文件名的操作（如 `ls`、文件树浏览） | ✅ 可用 | 不读文件内容，加密不影响 |
| 网络工具（HTTP 请求、网页抓取） | ✅ 可用 | 与本地加密无关 |

> **Shell 命令特别注意**：终端 shell 进程通常不在加密软件白名单，`cat`/`sed`/`grep` 等命令读文件时得到的是密文。如需在终端读取明文，应通过 `node -e "fs.readFileSync(...)"` 走 Node.js 白名单进程。

## 四、决策树

```
需要读文件
  ├─ 单个 → read_file
  └─ 多个（≥2）→ read_files（批量更高效）

需要修改文件
  ├─ 已读过 → 直接 edit_file
  └─ 未读过 → 先 read_file 拿到明文 → 再 edit_file

需要新建/覆盖文件
  └─ write_file

需要搜索内容
  └─ search_files
      ├─ 限定文件类型 → 用 include（如 "*.java,*.xml"）
      └─ 控制返回数量 → 用 maxResults

需要创建目录
  └─ create_directory

需要判断文件是否存在 / 查大小
  └─ file_info

工具异常 / 不确定是否生效
  └─ check_status
```

## 五、典型工作流

### 流程 1：读取并修改文件

```
1. read_file 读取明文
2. 分析内容
3. edit_file 修改
   - oldString 必须从第 1 步读到的内容里原样复制（含空格、缩进、换行）
4. 必要时再 read_file 验证修改结果
```

### 流程 2：批量读多个相关文件

```
1. read_files
   - paths 参数用英文逗号分隔，如 "D:/proj/A.java,D:/proj/B.java"
2. 统一分析（输出会带 "========== 文件: xxx ==========" 分隔）
```

### 流程 3：在项目中搜索特定代码

```
1. search_files
   - pattern: 正则表达式（如 "function\s+\w+"、"@GetMapping"）
   - path: 搜索根目录
   - include: 文件名过滤（可选）
2. 根据返回的 file:line 定位，用 read_file 读取具体文件
```

### 流程 4：从零创建新模块

```
1. create_directory 建目录
2. write_file 逐个创建文件
3. read_file 验证（可选）
```

## 六、`edit_file` 参数详解

| 参数 | 类型 | 必填 | 默认 | 说明 |
|:-----|:-----|:----:|:----:|:-----|
| `path` | string | ✅ | - | 文件绝对路径 |
| `oldString` | string | ✅ | - | 要替换的原内容，必须从 `read_file` 原文中精确复制 |
| `newString` | string | ✅ | - | 替换后的新内容 |
| `useRegex` | boolean | ❌ | false | true 时 oldString 当正则，可用 `$1` `$2` 引用捕获组 |
| `replaceAll` | boolean | ❌ | false | 替换所有匹配项；false 时仅替换第一处 |
| `ignoreCase` | boolean | ❌ | false | 是否忽略大小写（仅字符串模式生效） |

### 常见模式

- **单点替换**：`useRegex=false, replaceAll=false`（默认）
- **批量替换**：`useRegex=true, replaceAll=true`（如统一改名）
- **正则提取重组**：`useRegex=true, newString` 里用 `$1` `$2`

## 七、注意事项

1. **路径用绝对路径最稳**（如 `D:/proj/file.java`），相对路径以 MCP Server 启动目录为基准
2. **`edit_file` 前必须 `read_file`**：从原文精确复制 `oldString`（含空格、缩进、换行），**不要凭记忆写**
3. **`write_file` 是覆盖写**：会清空原文件再写入，重要文件修改前建议先 `read_file` 备份内容
4. **`search_files` 自动跳过**：`node_modules`、`.git`、`target`、`build`、`dist`、`.idea`、`.vscode`
5. **大批量搜索**：用 `maxResults` 控制返回数量（默认 200），避免一次性返回过多结果
6. **工具调用顺序**：复杂任务先 `check_status` 确认 MCP Server 正常运行，再正式操作

## 八、故障排查

| 现象 | 可能原因 | 解决方案 |
|:-----|:---------|:---------|
| 读到的还是密文/乱码 | Node.js 不在加密软件白名单 | 联系管理员把 `node.exe` 加入白名单 |
| MCP 工具全部不可见 | MCP Server 未配置或未启动 | 检查 Agent 的 MCP 列表命令（如 `claude mcp list`），确认 `read-file-server` 在列表中 |
| `edit_file` 报"未找到匹配内容" | `oldString` 拼写/缩进/换行不匹配 | 重新 `read_file` 复制原文，不要凭记忆写 |
| `edit_file` 报"匹配到 N 处" | 文件中存在重复内容 | 加更长/更唯一的 `oldString` 唯一定位，或 `replaceAll=true` |
| `search_files` 报"正则表达式无效" | 正则语法错误 | 检查 `pattern` 是否需要转义特殊字符 |
| `write_file` 报权限错误 | 文件被占用或目录无写权限 | 关闭占用进程 / 检查目录权限 |
| 工具调用超时 | 文件过大 | 改用 `search_files` 定位后只 `read_file` 关键段 |
