# 文件操作 MCP Server（加密软件环境明文读写）

## 简介

加密环境文件操作工具。当 Node.js 是加密软件白名单进程时，通过 fs 模块自动解密读写文件明文，替代 AI Agent 内置文件工具，解决加密环境下读到密文的问题。适用于任何支持 MCP 协议的 AI Agent。

**v1.7.0 环境自适应**：自动探测本机加密策略（哪些扩展名会被透明加密、哪些进程可用），对「会被加密且无法解密」的扩展名自动走 safeWrite 中转落盘明文，无需任何手工配置，换电脑自动重新探测。详见下文「环境自适应」。

**v1.9.0 可回滚写入与目录级策略**：全部文本修改改为「完整载荷 → 独占暂存 → 独立指纹校验 → 原文件备份 → 提交 → 最终校验」事务流程，失败自动回滚，回滚失败保留 `recoveryPath`；加密策略按「目标目录 × 扩展名」实时探测，人工标注（`mark_extension`）独立持久化到 `.mcp-file-policies/`，刷新探测/重启/TTL 过期均不丢失；safeWrite 失败不再回退直写（保护原文）；复制/移动目录逐文件执行相同策略；所有工具返回统一 `structuredContent`（ok/code/changed/data/warnings）。

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
AI Agent  --(MCP/stdio)-->  Node.js MCP Server(index.js)  --(lib/ 模块)-->  fs 读写明文
```

- `index.js` 仅负责 stdio 启动与正则 worker 回收
- `lib/encryption.js` 目录级加密探测、写入策略决策、safeWrite 组合与独立指纹校验
- `lib/files.js` 路径边界、跨实例锁、可回滚提交（暂存→备份→rename→终验）、目录逐文件复制/移动
- `lib/text.js` 严格 UTF-8 增量解码与流式分页
- `lib/patterns.js` 无回溯 glob 与保留原索引的字符串替换
- `lib/regex.js` / `lib/regex-worker.js` 用户正则在可终止 worker 中执行（默认 1 秒预算）
- `lib/server.js` 注册全部 18 个 MCP 工具，统一 structuredContent 与超时/只读包装

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
1. 写入 目标目录下 .mcp-safe-<uuid><安全扩展名> 的随机临时文件（安全类型 → 磁盘明文）
2. 用探测到的可用外部进程（powershell/pwsh/cmd/robocopy/cscript）复制临时文件到目标路径
   （外部进程不在白名单内，复制动作不触发透明加密 → 目标落盘为明文）
3. 用独立读取器（PowerShell 流式 SHA256+size）校验目标文件磁盘指纹为明文
4. 清理临时文件
5. 失败则遍历全部「安全扩展名 × 可用进程」组合重试；
   v1.9.0 起全部失败直接报错（SAFE_WRITE_FAILED），原文件保持不变，不再回退直写
```

### 探测与缓存

- **首次启动（或缓存失效）自动探测**：在系统临时目录用候选扩展名写入探测样本，通过「Node 读回对比 + 独立进程读磁盘指纹」分类；再探测可用的外部进程并做复制交叉验证
- **目录级实时探测（v1.9.0）**：具体写入前按「目标目录 × 扩展名」在该目录内创建随机探测样本（`.mcp-probe-<uuid><ext>`，写完即删）实时分类，结果缓存在内存 scopes 中——加密策略按目录生效时结果也准确
- **自动缓存位置**：`~/.mcp-encryption-profile.json`（结构 v3），按 machineId（hostname+username 哈希）绑定，**换电脑/换用户自动重新探测**；缓存有效期 30 天；v1/v2 旧缓存自动作废（v2 中的人工 protected 标注会一次性迁移到独立策略目录）
- **人工策略独立存储**：`~/.mcp-file-policies/` 每个扩展名一个文件，刷新探测、TTL 过期、服务重启都不会删除人工标注
- **查看/刷新**：用 `encryption_profile` 工具查看当前探测结果与人工策略；加密策略变更后用 `refresh_profile` 强制重探（只刷新自动探测，不动人工策略）；`inspect_write_strategy` 可预览某个目标路径将采用的写入策略而不修改目标文件
- **无外部进程可用时**（如进程被策略禁止 spawn）：普通写入仍以 Node 侧指纹校验内容一致；强制 `writePolicy=plaintext` 时会明确报 `DISK_UNVERIFIED` 而不会谎称已落盘明文

### 写入策略（writePolicy）

write_file / edit_file / copy_path / move_path 均支持 `writePolicy` 参数：

| 值 | 语义 |
|----|------|
| `auto`（默认） | 人工标注优先；否则按目标目录实时探测：safe 直写、protected 直写保持加密、unsafe 走 safeWrite |
| `preserve` | 显式保持受控加密直写（等同人工标注 protected 的当次效果） |
| `plaintext` | 强制磁盘明文：必须经 safeWrite 且由独立读取器验证完整磁盘指纹，验证失败则中止并保留原文件 |

### mark_extension 手动标注

当自动分类不符合预期时手动干预（标注优先级高于一切自动分类，独立持久化，重启/刷新不丢失）：

| 场景 | 调用 | 效果 |
|------|------|------|
| `.java` 需要保持 TSD 加密（受控文档） | `mark_extension(".java", "protected")` | auto 策略下直写保持加密，Notepad 打开正常 |
| `.scss` 必须保持明文（自动误判） | `mark_extension(".scss", "unsafe")` | auto 策略下强制走 safeWrite 保持明文 |
| 恢复自动分类 | `mark_extension(".java", "clear")` | 写入墓碑清除标注，恢复实时探测 |

## 写入保证（v1.9.0）

所有文本修改（write_file / edit_file）与文件复制/移动都经过统一的可回滚提交流程：

```
改前指纹 → expectedHash/overwrite 校验 → 策略决策
  → 同目录随机独占暂存 .mcp-stage-<uuid><ext>（外部进程中转时经安全扩展名）
  → fsync 刷盘 → 再次比对改前指纹（防并发改动）
  → 原文件 rename 为 .mcp-backup-<uuid><ext> → 暂存 rename 到位
  → 独立指纹终验（SHA256+size；有独立读取器时含磁盘原始字节）
  → 成功删除备份；任一步失败自动回滚，回滚失败返回 recoveryPath（备份不得删除）
```

- **完整载荷**：追加模式先在内存合成「原内容+新增」完整内容再走事务，纠正/重写不会丢原文与 BOM
- **safeWrite 失败即中止**：不再回退直写破坏原文（SAFE_WRITE_FAILED，changed=false）
- **跨实例锁**：同一路径的并发写入经 `.mcp-file-locks/` 互斥（等待 5 秒超时 FILE_BUSY）；`expectedHash` 可检测其他编辑器造成的版本变化（CONFLICT）
- **断电/强杀残留**：两次 rename 之间的极端崩溃可能留下 `.mcp-backup-*` 与 `.mcp-stage-*`，先核对内容与时间再人工恢复，禁止直接批量清理
- **复制/移动目录**：逐文件执行相同策略；移动先复制并二次比对指纹后再删除已验证的源文件；失败返回 `partial` 与 `sourceRetained`，不静默回退；符号链接明确拒绝；递归目标（目标在源内）明确拒绝
- **diskState 三态**：`plaintext`（独立进程验证磁盘明文）、`preserved`（保持加密直写）、`unknown`（内容已校验但无独立读取器证明磁盘状态——不能当作「已证明明文」）

## 文件结构

```
mcp-read-file-server/
├── README.md         # 本文档
├── SKILL.md          # 配套 Skill（可选，让 AI 学会自动选用本工具）
├── index.js          # MCP Server stdio 入口（含 shebang，可作可执行入口）
├── lib/              # 生产模块（encryption/files/text/patterns/regex/server）
├── scripts/          # 开发检查工具（check.js：语法+LF 检查）
├── test/             # 仓库内回归/协议/适配测试（不随包发布）
├── package.json      # 包配置（bin/files/依赖声明，可 npm publish）
├── .gitignore        # Git 忽略规则
└── node_modules/     # 依赖（@modelcontextprotocol/sdk、zod，不随包发布）
```

### 子目录说明

**lib/（生产模块）**：文件操作 MCP 的生产源码模块，不是额外安装的工具。text 处理严格 UTF8 和分页；patterns 处理无回溯 glob 与字符串编辑；regex/regex-worker 隔离用户正则；encryption 处理探测和持久策略；files 处理路径、锁与提交回滚；server 注册 MCP 工具。通过项目入口 index.js 使用。依赖现有 Node>=20、MCP SDK 和 Zod，无新增生产直接依赖。卸载整个 npm 包时随包卸载，不应单独删除其中某个模块。

**scripts/（开发检查工具）**：项目开发工具目录。check.js 检查 JS 语法与 LF 行尾，不执行功能测试。使用 `npm run check`。仅使用现有 Node 内置模块，无安装依赖。无需额外卸载；删除脚本前须同步修改 package.json 对应命令。

## 安装

### 前置条件
- Node.js v20+
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
npm ci
```

此时配置中使用 `node` + 本地 `index.js` 绝对路径。本地修改不会自动更新 npm 上的包，测试本地代码请在客户端配置中直接指向本仓库入口。

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

### 环境变量（可选）

| 环境变量 | 默认与说明 |
|---------|-----------|
| `MCP_BASE_DIR` | 服务启动目录；所有相对路径的基准 |
| `MCP_ALLOWED_ROOTS` | 可选绝对路径 JSON 数组（如 `["D:/Projects"]`）；设置后所有文件操作限制在根目录内，未设置继承 Node 进程文件权限 |
| `MCP_READ_ONLY` | `1` 禁用全部修改类工具（保留读操作；edit_file dryRun 仍可预览） |
| `MCP_DISABLE_DELETE` | `1` 禁用 remove_path |
| `MCP_PROFILE_DIR` | 探测缓存/人工策略/锁文件的存放目录，默认用户主目录；建议保持稳定，测试必须独立设置 |

## 提供的工具

共 18 个工具。所有工具同时返回文本与统一 `structuredContent`：`{ ok, code, changed, data, warnings }`；错误时 `isError:true`，`code` 为机器可读错误码（如 `NO_MATCH` / `CONFLICT` / `SAFE_WRITE_FAILED` / `DISK_MISMATCH` / `FILE_BUSY`），并视情况附 `recoveryPath` / `partial` / `sourceRetained`。

| 工具名 | 替代内置 | 功能 | 参数 |
|--------|---------|------|------|
| `read_file` | Read | 读取单个文件明文（完整读取返回 hash，超 40 万字符截断返回 nextOffset） | `path` |
| `read_files` | 多次 Read | 批量读取（最多 100 个文件，总 40 万字符预算，逐项状态） | `paths` |
| `read_file_partial` | Read（局部） | 局部读取（字符模式带 offset 续页；行模式返回 nextLine） | `path`、`mode`、`charCount`、`offset`、`startLine`、`endLine` |
| `write_file` | Write | 写入文件（完整载荷事务提交；追加/BOM/行尾跟随原文件） | `path`、`content`、`mode`、`eol`、`expectedHash`、`overwrite`、`writePolicy` |
| `edit_file` | Edit/MultiEdit | 精确替换后写回（CRLF/LF 自动兼容、edits 批量原子、dryRun 预览、expectedMatches 计数保护） | `path`、`oldString`、`newString`、`edits`、`useRegex`、`replaceAll`、`ignoreCase`、`expectedMatches`、`expectedHash`、`dryRun`、`writePolicy` |
| `search_files` | Grep | 递归搜索内容（literal/regex 双模式、上下文行、跳过二进制/超大文件） | `pattern`、`path`、`mode`、`include`、`exclude`、`ignoreCase`、`onlyMatching`、`contextLines`、`maxResults`、`showHidden` |
| `find_files` | Glob | 按文件名 glob 递归查找（支持花括号与字面括号路径） | `pattern`、`path`、`maxResults` |
| `list_directory` | LS | 列出目录内容（含 symlink 类型；offset/maxResults 分页） | `path`、`showHidden`、`offset`、`maxResults` |
| `copy_path` | bash cp | 复制文件/目录（逐文件策略校验；overwrite=false 保护） | `source`、`destination`、`overwrite`、`writePolicy` |
| `move_path` | bash mv | 移动/重命名（同路径保护；复制校验后才删源） | `source`、`destination`、`overwrite`、`writePolicy` |
| `remove_path` | bash rm | 删除文件/目录（默认递归；dryRun 预览；保护根目录） | `path`、`recursive`、`dryRun` |
| `create_directory` | - | 递归创建目录 | `path` |
| `file_info` | - | 查询文件信息（流式 SHA256 指纹、链接目标；calculateHash=false 仅查元数据） | `path`、`calculateHash` |
| `check_status` | - | 心跳检查；传 path 实测读取（检出 %TSD 密文头会明示；expectedHash 提供可信对照） | `path`（可选）、`expectedHash`（可选） |
| `encryption_profile` | - | 查看自动探测缓存与人工策略标注 | 无 |
| `refresh_profile` | - | 强制重新探测（只刷新自动缓存，不动人工策略） | 无 |
| `mark_extension` | - | 人工标注扩展名策略（protected/unsafe/clear，独立持久化） | `extension`、`category` |
| `inspect_write_strategy` | - | 预览某目标路径将采用的写入策略（在目标目录探测，不修改目标文件） | `path`、`writePolicy` |

### `read_file_partial` 参数详解

| 参数 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| `path` | string | 是 | - | 文件路径，支持相对路径或绝对路径 |
| `mode` | enum: `chars` / `lines` | 是 | - | 读取模式：`chars`=按字符数读取；`lines`=按行号读取指定行或行范围 |
| `charCount` | number | `mode=chars` 时必填 | - | 读取前 N 个字符 |
| `offset` | number | 否 | 0 | 字符模式续页位置（须使用上次返回的 `nextOffset`，不能自行换算字节偏移） |
| `startLine` | number | `mode=lines` 时必填 | - | 起始行号（从 1 开始） |
| `endLine` | number | 否 | =`startLine` | 结束行号（含该行）。不传则只读取 `startLine` 一行 |

**使用示例：**

- 读取文件前 500 个字符：`mode="chars"`, `charCount=500`
- 读取第 10 行：`mode="lines"`, `startLine=10`
- 读取第 5-20 行：`mode="lines"`, `startLine=5`, `endLine=20`

> 返回内容会带文件名、读取范围、总行数的头部信息，行模式下每行带行号前缀。超出文件范围时自动截断并提示；行模式流式扫描返回 `nextLine` 供续页。

### `edit_file` 换行符自动兼容

Windows 下文件多为 CRLF 换行，而 AI Agent 生成的多行 `oldString` 通常是 LF 换行，字节级比对会直接失败（报"未找到匹配内容"）。本工具已内置兼容逻辑：

- **匹配阶段**：先按字节原样精确匹配；未命中时自动将文件与 `oldString` 的换行符统一归一（`\r\n` / `\r` / `\n` 均视为换行）后再匹配，两种风格任意组合均可命中
- **写入阶段**：`newString` 的行尾会自动转换为文件本身的主导换行风格，不会把 CRLF 文件改写为 LF 混行
- **BOM 自动处理**：UTF-8 BOM 读取时自动剥离、写回时自动补回，`oldString` 无需关心 BOM
- **正则模式默认多行**：`useRegex=true` 时自动附加 `m` 标志，`^xxx` / `xxx$` 按行锚定；正则在独立 worker 中执行（默认 1 秒预算），超时/取消不影响服务继续响应
- **批量原子编辑（edits 数组）**：一次调用完成多处修改（1–200 条），按序应用；**任一条目失败则整体不写盘**，不会产生「半改状态」。条目按文件现状顺序构造（前面条目的结果参与后续条目匹配）
- **dryRun 预览**：`dryRun=true` 返回 matched/replaced/原文与提议 hash 及差异片段，不写盘
- **expectedMatches 计数保护**：声明期望替换处数，实际不符即失败（MATCH_COUNT_MISMATCH）不写盘，防止误替换
- **失败附相似行诊断**：字符串匹配失败时返回「可能相关的行」及相似度，直接对照排查空白/缩进差异，无需盲目重试

注意：该兼容仅针对换行符差异，空格、缩进等其他空白字符仍需与原文完全一致。含反引号 `` ` `` 与 `${}` 的内容直接原样传参（JSON 传输无 JS 模板字面量转义问题）。

### 其他内置保护

- **预算读取（性能）**：`read_file` / `read_files` / `read_file_partial`(chars 模式) 只读取需要的字节数而非整个文件。读取 100MB 大文件的前 40 万字符从 ~160ms/100MB 内存降到 ~3ms/1.5MB 内存
- **编码防损坏**：严格 UTF-8 增量解码（合法中文跨字节边界不损坏）；UTF-16、GBK/非法 UTF-8、含 NUL 的二进制拒绝进入文本编辑/追加流程，防止不可逆损坏
- **大文件截断**：`read_file` / `read_files` 单文件超过 40 万字符自动截断，提示改用 `read_file_partial` 分页读取，避免撑爆上下文
- **二进制/超大文件跳过**：`search_files` 只预读首块判定二进制后即跳过，超过 5MB 的文件也跳过，并在结果 skipped 中说明数量
- **隐藏文件默认跳过**：`search_files` / `find_files` 默认跳过 `.` 开头的文件与目录（避免把 `.env` 等敏感内容灌入上下文），忽略目录还包含 `node_modules`、`.git`、`target`、`build`、`dist`、`vendor` 等（可用 `showHidden`/`useDefaultIgnore` 控制）；`list_directory` 可用 `showHidden=true` 显示
- **glob 支持 `{a,b}` 花括号**：`find_files` / `search_files` 的 include 支持 `src/**/*.{ts,tsx}` 这类 Agent 高频写法；不含路径分隔符的 include 按文件名匹配，含 `/` 的按相对路径匹配
- **主要预算**：字符页 40 万；文本整文件编辑/覆盖/追加 16MB；读取页最多扫描 64MB；搜索单文件 5MB、总输出 40 万字符、最多 2000 条；遍历最多 10 万项/128 层；目录复制/移动最多 1 万项；工具超时 `timeoutMs` 默认 15000（100–60000）

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
   encryption_profile 查看本机扩展名分类与人工策略；
   写入前可用 inspect_write_strategy 预览目标路径的写入策略。
2. 写任何扩展名的文件都不用关心加密细节：write_file/edit_file/copy_path/
   move_path 默认 writePolicy=auto，按目标目录实时探测并自动选择直写或
   safeWrite；需要保持加密用 writePolicy=preserve，需要强制磁盘明文用
   writePolicy=plaintext（失败会中止并保留原文件，不会回退直写）。
3. 需要长期保持加密/明文的扩展名：用 mark_extension(".java", "protected")
   或 mark_extension(".scss", "unsafe") 标注一次永久生效（独立存储，
   重启与刷新探测不丢失）；mark_extension(".ext", "clear") 恢复自动。
4. edit_file 前必须先 read_file 拿原文，oldString 从原文原样复制
   （含空格与缩进；CRLF/LF 换行差异会自动兼容，无需手工处理）；
   重要修改先 dryRun=true 预览；可用 expectedHash 防止覆盖他人改动。
5. 路径一律使用绝对路径。
6. 写工具返回 isError 时先看 structuredContent 的 code：
   SAFE_WRITE_FAILED/DISK_MISMATCH 说明明文落盘失败（原文件未动），
   先调 refresh_profile 重新探测再重试；出现 recoveryPath 说明回滚
   也失败，保留该备份并报告用户，禁止盲目重试或删除备份。
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

已发布到 npm，新电脑上**无需拷贝文件**，只要装了 Node.js（v20+），直接配置 Agent 使用 `npx -y mcp-read-file-server` 即可。

> 若需离线使用或二次开发，再按「安装 -> 方式二」从源码克隆运行。

## 开发与验证

```powershell
npm ci
npm run check    # 语法 + LF 行尾检查
npm test         # 仓库内回归/协议/适配测试（Node 内置 test runner）
npm audit --omit=dev
```

测试位于 `test/`（regression/protocol/adapters 三个套件，模拟磁盘错误与真实 stdio 协议分离，不触碰真实 profile）；CI 覆盖 Windows/Linux × Node 20/22/24。运行依赖：MCP SDK 1.30.0、Zod 4.4.3（间接依赖 fast-uri/qs 通过 overrides 限定修复版本）。

## 故障排查

### 读取到的仍是密文

说明 Node.js 未被加密软件列为白名单。解决方法：
- 联系加密软件管理员，将 `node.exe` 加入白名单
- 确认加密软件的受信任进程列表中包含 Node.js

### MCP Server 无法启动

```bash
# 验证 Node.js 和依赖
node --version
cd mcp-read-file-server && npm ci

# 测试启动
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}}}' | node index.js
```

### 写入 .scss/.css 等文件后显示乱码（密文）

该扩展名在本机属于 unsafe 类型（加密但不自动解密）。v1.7.0+ 会自动走 safeWrite 规避；若仍出现乱码：

1. 调 `refresh_profile` 强制重新探测（策略可能变更或缓存过期）
2. 调 `encryption_profile` 确认该扩展名分类与可用外部进程；或对该扩展名直接 `mark_extension(".scss", "unsafe")` 强制明文
3. 若显示「可用外部进程: （无）」，说明 MCP Server 进程被策略禁止 spawn 子进程，需联系管理员放行 powershell/cmd，或接受直写加密后由白名单应用打开

### 写工具返回 SAFE_WRITE_FAILED / DISK_MISMATCH

v1.9.0 起 safeWrite 失败**不再回退直写**（保护原文件，返回 `changed:false`）。说明所有「安全扩展名 × 外部进程」组合都验证失败（常见原因：外部进程对目标目录无写权限，或独立读取器验证磁盘指纹不一致）。处理：调 `refresh_profile` 重探；检查目标目录权限；确认 powershell/cmd 可被执行；换目录重试。

### 写工具返回 FILE_BUSY / CONFLICT

- `FILE_BUSY`：另一个 MCP 实例正在写同一路径（锁位于 `~/.mcp-file-locks/`）。确认对方进程结束后重试；仅当确认锁属主进程已退出时才可人工删除残留锁文件
- `CONFLICT`：传入的 `expectedHash` 与文件当前指纹不一致——文件在您读取后被其他进程改过。重新 read_file 后再编辑

### 回滚失败返回 recoveryPath

极端情况（断电/强杀/磁盘错误）下自动回滚也失败时会返回 `recoveryPath`——这是原文件的备份路径，**必须保留**。先核对备份内容与时间，人工恢复后再排查；禁止直接批量清理 `.mcp-backup-*` / `.mcp-stage-*`。

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
