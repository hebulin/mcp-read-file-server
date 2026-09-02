# 文件操作 MCP Server（加密软件环境明文读写）

## 简介

加密环境文件操作工具。当 Node.js 是加密软件白名单进程时，通过 fs 模块自动解密读写文件明文，替代 AI Agent 内置文件工具，解决加密环境下读到密文的问题。适用于任何支持 MCP 协议的 AI Agent。

**v1.7.0 环境自适应**：自动探测本机加密策略（哪些扩展名会被透明加密、哪些进程可用），对「会被加密且无法解密」的扩展名（如部分机器上的 `.scss`/`.css`）自动走 safeWrite 中转落盘明文，无需任何手工配置，换电脑自动重新探测。详见下文「环境自适应」。

**v1.8.0 写入后实时重分类**：启动探测只给出先验分类，且 Node.js 白名单读回无法区分「真受控（TSD 管控文档）」与「伪受控」。1.8.0 起所有直写路径完成后，用外部进程读取目标文件磁盘原始字节实测：发现密文（命中 `%TSD` 魔数）自动将该扩展名重分类为 encrypted 并立即用 safeWrite 重写为明文；实测明文则重分类为 safe。对需要**保持加密**的扩展名（如 `.java`），用 `mark_extension` 手动标注 protected 后，写入直写保持加密且跳过自动纠正。

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

## 环境自适应（v1.7.0+）

### 解决的问题

加密软件对「写入是否透明加密」是**按目标文件扩展名**决定的，且每台电脑的策略不同：

| 扩展名分类 | 含义 | 直写后果 | 本工具策略 |
|-----------|------|---------|-----------|
| **safe** | 写入后磁盘是明文 | 正常 | 直接写（原始行为） |
| **protected** | 写入后磁盘是密文，但 Node.js 白名单读回自动解密 | 本机正常 | 直接写（保持加密保护） |
| **unsafe** | 写入后被加密，但该类型不在保护列表，**任何进程都无法解密** | 磁盘密文乱码，文件损坏 | 自动走 safeWrite |

### safeWrite 原理

对 unsafe 扩展名目标，写入流程自动切换为：

```
1. fs.writeFileSync 写入 目标路径+安全扩展名 的临时文件（安全类型 → 磁盘明文）
2. 用探测到的可用外部进程（powershell/cmd/robocopy/cscript 等）复制临时文件到目标路径
   （外部进程不在白名单内，复制动作不触发透明加密 → 目标落盘为明文）
3. 校验目标文件磁盘字节为明文
4. 清理临时文件
5. 失败则遍历全部「安全扩展名 × 可用进程」组合重试；全部失败回退直写并明确告警
```

### 探测与缓存

- **首次启动（或缓存失效）自动探测**：依次用候选扩展名写入临时文件，通过「外部进程读磁盘原始字节 + 物理大小对比 + Node 读回对比」三重交叉验证分类；再探测可用的外部进程并做复制交叉验证
- **探测全程在系统临时目录进行**，不污染用户目录；对未在候选清单中的扩展名，首次写入时按需即时探测（在目标文件所在目录进行，兼容按目录生效的策略）
- **缓存位置**：`~/.mcp-encryption-profile.json`，按 machineId（hostname+username 哈希）绑定，**换电脑/换用户自动重新探测**；缓存有效期 30 天
- **查看/刷新**：用 `encryption_profile` 工具查看当前探测结果；加密策略变更后用 `refresh_profile` 强制重探
- **无外部进程可用时**（如进程被策略禁止 spawn）：自动降级为大小+读回对比探测，unsafe 写入回退直写并告警，不影响其他功能

### 写入后实时重分类（v1.8.0+）

启动探测的分类结论是先验的（在系统临时目录采样），且 Node.js 白名单读回无法区分「真受控文档」与「伪受控」——两者在白名单进程里都能读到明文。1.8.0 起引入**写入后实测**兜底：

```
写入完成 → 外部进程读目标文件磁盘前 16 字节
  ├─ 与写入内容前缀一致 → 磁盘明文 → 扩展名重分类为 safe
  ├─ 命中 %TSD 魔数     → 磁盘密文 → 扩展名重分类为 encrypted，
  │                        并立即用 safeWrite 重写为明文（自动纠正）
  └─ 检测不可用          → 保持原分类（无任何副作用）
```

- **首次写入新扩展名**：先直写，实测发现加密 → 自动重分类 + 立即纠正为明文，并提示已切换策略；第二次起该扩展名直接走 safeWrite
- **目录级策略差异**：已知 safe/protected 的扩展名在写入后也会复测，策略被管理员调整或按目录生效时可自动纠正误分类
- **用户标注优先**：`mark_extension` 标注为 protected 的扩展名保持加密直写，跳过自动纠正（适合 `.java` 这类需要保持加密状态的受控文档）；标注为 unsafe 的扩展名强制走 safeWrite 保持明文
- **缓存结构 v2**：新增 `encryptedExtensions`（写入后实测密文的扩展名）与 `userProtectedExtensions`（用户标注），旧版缓存自动作废重探

### mark_extension 手动标注

当自动分类不符合预期时手动干预（标注优先级高于一切自动分类）：

| 场景                                         | 调用 | 效果 |
|----------------------------------------------|------|------|
| `.java` 需要保持 TSD 加密（company受控文档） | `mark_extension(".java", "protected")` | 直写保持加密，Notepad 打开正常，跳过写入后自动纠正 |
| `.scss` 必须保持明文（自动误判为 protected） | `mark_extension(".scss", "unsafe")` | 强制走 safeWrite 保持明文 |
| 恢复自动分类                                 | `mark_extension(".java", "clear")` | 清除手动标注 |

## 文件结构

```
mcp-read-file-server/
├── README.md         # 本文档
├── SKILL.md          # 配套 Skill（可选，让 AI 学会自动选用本工具）
├── index.js          # MCP Server 主程序（含 shebang，可作可执行入口）
├── package.json      # 包配置（bin/files/依赖声明，可 npm publish）
├── .gitignore        # Git 忽略规则
└── node_modules/     # 依赖（@modelcontextprotocol/sdk、zod，不随包发布）
```

## 安装

### 前置条件
- Node.js v18+（推荐 v20+）
- Node.js 已被加密软件列为白名单进程

### 方式一：通过 npx 运行（推荐，无需手动安装）

已发布到 npm，可直接通过 `npx` 运行，无需 `git clone` 和 `npm install`：

```bash
npx -y mcp-read-file-server
```

首次运行 npx 会自动下载本包及其依赖到临时目录并启动（需数秒~十几秒；若 Agent 启动超时，可先在终端手动跑一次 `npx -y mcp-read-file-server` 预热缓存，看到卡住等输入后 `Ctrl+C` 退出）。配置 Agent 时将 `command` 设为 `npx`、`args` 设为 `["-y", "mcp-read-file-server"]` 即可（见下文「配置」；**Windows 下部分 Agent 需用 `npx.cmd`**）。

### 方式二：从源码运行（开发 / 离线场景）

```bash
git clone https://github.com/hebulin/mcp-read-file-server.git
cd mcp-read-file-server
npm install
```

此时配置中使用 `node` + 本地 `index.js` 绝对路径。

## 配置

所有 Agent 配置 MCP Server 的核心信息相同，只是配置文件位置和格式略有差异。

### npx 方式（推荐）

通过 npm 包运行，无需关心本地路径：

```json
{
  "mcpServers": {
    "read-file-server": {
      "command": "npx",
      "args": ["-y", "mcp-read-file-server"]
    }
  }
}
```

> **⚠️ Windows 用户注意**：部分 Agent（Cursor / Cline / Continue 等）在 Windows 下直接用 `npx` 会启动失败（报 `spawn npx ENOENT` 或连不上），需把 `command` 改成 `npx.cmd`：
>
> ```json
> {
>   "mcpServers": {
>     "read-file-server": {
>       "command": "npx.cmd",
>       "args": ["-y", "mcp-read-file-server"]
>     }
>   }
> }
> ```
>
> Claude Code 通常能自动识别 `npx`，无需改。若 `npx.cmd` 仍失败，可改用 `"command": "cmd"`、`"args": ["/c", "npx", "-y", "mcp-read-file-server"]`。

### 本地源码方式

若用「方式二」从源码运行，则指向本地 `index.js`：

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
      "command": "npx",
      "args": ["-y", "mcp-read-file-server"]
    }
  }
}
```

#### 方式二：全局配置（所有项目可用）

```bash
claude mcp add read-file-server -s user -- npx -y mcp-read-file-server
```

参数说明：
- `read-file-server`：MCP Server 名称（自定义）
- `-s user`：作用域为全局（所有项目可用），不写则默认项目级
- `--`：分隔符，后面是实际执行的命令
- `npx -y mcp-read-file-server`：实际执行的命令（自动从 npm 拉取并运行）

#### 方式三：手动编辑全局配置文件

直接编辑 `C:\Users\你的用户名\.claude.json`，添加：

```json
{
  "mcpServers": {
    "read-file-server": {
      "command": "npx",
      "args": ["-y", "mcp-read-file-server"]
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
| `read_file` | Read | 读取单个文件明文（超大文件自动截断） | `path` |
| `read_files` | 多次 Read | 批量读取多个文件明文（数组或逗号分隔字符串） | `paths` |
| `read_file_partial` | Read（局部） | 局部读取文件（前N字符 / 指定行范围） | `path`、`mode`、`charCount`、`startLine`、`endLine` |
| `write_file` | Write | 写入文件（支持追加模式 / 行尾风格 / BOM 保留；unsafe 扩展名自动 safeWrite 明文落盘） | `path`、`content`、`mode`、`eol` |
| `edit_file` | Edit/MultiEdit | 精确替换后写回（CRLF/LF 自动兼容、BOM 保留、正则多行模式、`edits` 批量原子编辑、失败附相似行诊断；unsafe 扩展名自动 safeWrite） | `path`、`oldString`、`newString`、`edits`、`useRegex`、`replaceAll`、`ignoreCase` |
| `search_files` | Grep | 递归搜索文件内容（支持 `**` 目录通配、跳过二进制/超大文件） | `pattern`、`path`、`include`、`exclude`、`ignoreCase`、`onlyMatching`、`maxResults` |
| `find_files` | Glob | 按文件名 glob 递归查找（如 `**/*.test.js`） | `pattern`、`path`、`maxResults` |
| `list_directory` | LS | 列出目录内容（类型/大小/时间） | `path`、`showHidden` |
| `copy_path` | bash cp | 复制文件/目录（递归；加密环境必须经白名单进程；unsafe 目标自动 safeCopy） | `source`、`destination` |
| `move_path` | bash mv | 移动/重命名（跨盘符自动回退复制+删除；unsafe 目标自动明文落盘） | `source`、`destination` |
| `remove_path` | bash rm | 删除文件/目录（默认递归，谨慎使用） | `path`、`recursive` |
| `create_directory` | - | 递归创建目录 | `path` |
| `file_info` | - | 查询文件/目录信息（含明文大小、符号链接） | `path` |
| `check_status` | - | 检查运行状态（可实测解密能力，输出含环境探测概要） | `path`（可选） |
| `encryption_profile` | - | 查看环境探测结果（扩展名三分类、可用进程、最佳组合、缓存位置） | 无 |
| `refresh_profile` | - | 强制重新探测环境并更新缓存（加密策略变更后使用） | 无 |
| `mark_extension` | `extension`, `category` | 手动标注扩展名写入策略：protected=保持加密直写，unsafe=强制 safeWrite 明文，clear=清除标注 | 无 |

### `read_file_partial` 参数详解

| 参数 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| `path` | string | ✅ | - | 文件路径，支持相对路径或绝对路径 |
| `mode` | enum: `chars` / `lines` | ✅ | - | 读取模式：`chars`=按字符数读取前N个字符；`lines`=按行号读取指定行或行范围 |
| `charCount` | number | `mode=chars` 时必填 | - | 读取前 N 个字符 |
| `startLine` | number | `mode=lines` 时必填 | - | 起始行号（从 1 开始） |
| `endLine` | number | ❌ | =`startLine` | 结束行号（含该行）。不传则只读取 `startLine` 一行 |

**使用示例：**

- 读取文件前 500 个字符：`mode="chars"`, `charCount=500`
- 读取第 10 行：`mode="lines"`, `startLine=10`
- 读取第 5-20 行：`mode="lines"`, `startLine=5`, `endLine=20`

> 返回内容会带文件名、读取范围、总字符数/总行数的头部信息，行模式下每行带行号前缀。超出文件范围时自动截断并提示。

### `edit_file` 换行符自动兼容

Windows 下文件多为 CRLF 换行，而 AI Agent 生成的多行 `oldString` 通常是 LF 换行，字节级比对会直接失败（报"未找到匹配内容"）。本工具已内置兼容逻辑：

- **匹配阶段**：先按字节原样精确匹配；未命中时自动将文件与 `oldString` 的换行符统一归一（`\r\n` / `\r` / `\n` 均视为换行）后再匹配，两种风格任意组合均可命中
- **写入阶段**：`newString` 的行尾会自动转换为文件本身的主导换行风格，不会把 CRLF 文件改写为 LF 混行
- **提示信息**：触发换行适配时，返回结果会附 `ℹ️ 换行符已自动适配` 说明，方便排查
- **BOM 自动处理**：UTF-8 BOM 读取时自动剥离、写回时自动补回，`oldString` 无需关心 BOM
- **正则模式默认多行**：`useRegex=true` 时自动附加 `m` 标志，`^xxx` / `xxx$` 按行锚定
- **批量原子编辑（edits 数组）**：一次调用完成多处修改，按序应用；**任一条目失败则整体不写盘**，不会产生「半改状态」。条目按文件现状顺序构造（前面条目的结果参与后续条目匹配）
- **失败附相似行诊断**：字符串匹配失败时返回「可能相关的行」及相似度，直接对照排查空白/缩进差异，无需盲目重试

注意：该兼容仅针对换行符差异，空格、缩进等其他空白字符仍需与原文完全一致。含反引号 `` ` `` 与 `${}` 的内容直接原样传参（JSON 传输无 JS 模板字面量转义问题）。

### 其他内置保护

- **预算读取（性能）**：`read_file` / `read_files` / `read_file_partial`(chars 模式) 只读取需要的字节数而非整个文件。读取 100MB 大文件的前 40 万字符从 ~160ms/100MB 内存降到 ~3ms/1.5MB 内存
- **编码防损坏**：UTF-16 文件（BOM/字节特征检测）直接拒绝读取并提示转换；疑似非 UTF-8（GBK 等，含大量乱码替换字符）的文件 `edit_file` 拒绝编辑写回，防止不可逆损坏
- **大文件截断**：`read_file` / `read_files` 单文件超过 40 万字符自动截断，提示改用 `read_file_partial` 分页读取，避免撑爆上下文
- **二进制/超大文件跳过**：`search_files` 只预读首 8KB 判定二进制（图片/exe 含 NUL 字节）后即跳过，超过 5MB 的文件也跳过，并在结果中说明跳过数量
- **隐藏文件默认跳过**：`search_files` / `find_files` 默认跳过 `.` 开头的文件与目录（避免把 `.env` 等敏感内容灌入上下文），忽略目录还包含 `node_modules`、`.git`、`target`、`build`、`dist`、`vendor` 等；`list_directory` 可用 `showHidden=true` 显示
- **glob 支持 `{a,b}` 花括号**：`find_files` / `search_files` 的 include 支持 `src/**/*.{ts,tsx}` 这类 Agent 高频写法

## 使用

配置好后，在 Agent 中直接说需求即可。Agent 会自动调用 MCP 工具读写文件明文。

## 推荐提示词（Prompt）

把下面这段提示词放入 Agent 的系统提示/记忆文件（Claude Code 放 `CLAUDE.md`，Cursor 放 `.cursor/rules`，其他 Agent 放对应的全局指令位置），可让 Agent 在加密环境下**始终正确地**使用本工具，避免误用内置工具读到密文或写出不可解密的乱码文件：

```markdown
# 文件操作强制规则（加密软件环境）

本机装有文件加密软件（天锐绿盾/TSD/IP-Guard/亿赛通等），磁盘文件为密文。
所有文件操作必须使用 mcp__read-file-server__* 工具，严禁使用内置
Read/Write/Edit/MultiEdit/Grep/LS 及 Bash 的 cat/sed/grep/cp/mv/rm
（内置工具不在加密软件白名单内，会读到密文或产出任何进程都无法解密的乱码文件）。
find_files 之外的文件名查找也优先用 MCP 工具。

## 工具映射
- 读单个文件      → mcp__read-file-server__read_file
- 读多个文件      → mcp__read-file-server__read_files（批量，一次调用）
- 局部读取        → read_file_partial（大文件分页：mode=chars 或 mode=lines）
- 新建/覆盖写     → write_file
- 修改文件        → edit_file（多处修改必须用 edits 数组一次提交，禁止逐条调用）
- 搜索内容        → search_files（include 限定类型，maxResults 控制数量）
- 按文件名查找    → find_files
- 列目录          → list_directory
- 复制/移动/删除  → copy_path / move_path / remove_path
- 建目录/查信息   → create_directory / file_info

## 使用规则
1. 会话开始先调 check_status 确认白名单解密正常；环境不明时调
   encryption_profile 查看本机扩展名分类（safe/protected/unsafe/encrypted）与可用进程。
2. 写任何扩展名的文件都不用关心加密细节：write_file/edit_file/copy_path/
   move_path 已内置环境自适应与写入后实时检测——写入后磁盘为密文的扩展名
   会被自动识别并立即重写为明文，后续同类文件自动走 safeWrite。
3. 需要保持加密状态的扩展名（如受控的 .java 文档）：用
   mark_extension(".java", "protected") 标注一次即可，之后写入直写保持加密；
   反之若某扩展名被误判导致写入后变密文，用 mark_extension(".ext", "unsafe")
   强制保持明文。标注一次永久生效（缓存在本机）。
4. edit_file 前必须先 read_file 拿原文，oldString 从原文原样复制
   （含空格与缩进；CRLF/LF 换行差异会自动兼容，无需手工处理）。
5. 路径一律使用绝对路径。
6. 若写工具返回「safeWrite 失败/回退直接写入」告警，先调 refresh_profile
   重新探测环境，再重试写入；仍失败则把告警原文报告给用户。
7. edit_file 匹配失败时，按返回的「可能相关的行」诊断修正 oldString，
   不要盲目重试。
```

> 该提示词与 `SKILL.md` 二选一即可：Agent 支持 Skill 机制（Claude Code 等）时装 SKILL.md；不支持或想要更强约束时，直接把上面的提示词写进全局指令。

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

已发布到 npm，新电脑上**无需拷贝文件**，只要装了 Node.js（v18+），直接配置 Agent 使用 `npx -y mcp-read-file-server` 即可。

> 若需离线使用或二次开发，再按「安装 -> 方式二」从源码克隆运行。

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

### 写入 .scss/.css 等文件后显示乱码（密文）

该扩展名在本机属于 unsafe 类型（加密但不自动解密）。v1.7.0+ 会自动走 safeWrite 规避；若仍出现乱码：

1. 调 `refresh_profile` 强制重新探测（策略可能变更或缓存过期）
2. 调 `encryption_profile` 确认该扩展名已被正确识别为 unsafe、且存在可用外部进程与 bestCombo
3. 若显示「可用外部进程: （无）」，说明 MCP Server 进程被策略禁止 spawn 子进程，需联系管理员放行 powershell/cmd，或接受直写加密后由白名单应用打开

### 写工具返回「safeWrite 失败，已回退直接写入」告警

说明所有「安全扩展名 × 外部进程」组合都验证失败（常见原因：外部进程对目标目录无写权限）。处理：调 `refresh_profile` 重探；检查目标目录权限；换目录重试。回退写入的文件在本机可能显示乱码，建议删除后重新写入。

### Agent 连不上 MCP Server

包本身正常但 Agent 连不上时，按以下顺序排查：

1. **Windows 下 `npx` 找不到**：部分 Agent（Cursor / Cline / Continue 等）需把 `command` 写成 `npx.cmd`，详见上文「配置 -> npx 方式」的 Windows 注意事项。这是 Windows 上最常见的连不上原因。
2. **首次 npx 下载超时**：npx 首次拉取包需数秒~十几秒，某些 Agent 启动超时较短会连不上。先在终端手动跑一次 `npx -y mcp-read-file-server`（看到卡住等输入即启动成功，`Ctrl+C` 退出），让包进入缓存，再让 Agent 连接即可秒启。
3. **npx 缓存了旧版 / 损坏**：清缓存重试 ——
   ```bash
   npx clear-npx-cache
   # 或 Windows 下手动删除缓存目录
   rm -rf "C:/Users/你的用户名/AppData/Local/npm-cache/_npx"
   ```
4. **确认包本身是否正常**：
   ```bash
   npx -y mcp-read-file-server   # 能启动=包没问题，问题在 Agent 配置/环境
   ```
   能启动并卡住等输入，说明包正常，需检查 Agent 的配置 JSON 格式与 `command` 写法。


---
[![MCP Badge](https://lobehub.com/badge/mcp/hebulin-mcp-read-file-server)](https://lobehub.com/mcp/hebulin-mcp-read-file-server)
