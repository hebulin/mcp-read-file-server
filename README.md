# 文件操作 MCP Server（加密软件环境明文读写）

## 简介

加密环境文件操作工具。当 Node.js 是加密软件白名单进程时，通过 fs 模块自动解密读写文件明文，替代 AI Agent 内置文件工具，解决加密环境下读到密文的问题。适用于任何支持 MCP 协议的 AI Agent。

## 最新版本：2.1.0（相对 1.0）

本节以仓库 `v1.0` 标签（包版本 `1.0.0`）为基线，汇总当前版本的变化，不再逐条保留中间版本的更新说明。

| 方面 | 1.0 | 2.1.0 |
|------|-----|-------|
| 文件写入 | 由 Node 直接读改写，依赖本机透明加密行为 | 统一暂存、备份、提交及终验；失败回滚，恢复失败保留 `recoveryPath` |
| 加密策略 | 没有按原文件状态选择写入策略 | `auto` 比较原文件的 Node 与外部读取视图：原明文继续验证明文，原受保护文件保留受控写入；新建文件不凭 Node 可读就自动加密 |
| 工具范围 | 8 个基础读写、搜索及目录工具 | 18 个工具，增加分页、列目录、文件查找、复制/移动/删除和 4 个策略诊断/管理工具 |
| 编辑准确性 | 单次字符串或正则替换 | 批量原子编辑、CRLF/LF 适配、BOM 保留、预览、预期匹配数和 hash 冲突保护 |
| 读取与性能 | 同步文件操作和基础搜索 | 异步 I/O、流式分页、有界输出；正则与字面量计算在可终止 worker 中执行；glob 累计预算并让出主线程 |
| 并发与异常 | 基础异常返回 | 跨实例路径/子树锁；目录逐文件校验；部分完成、源保留、回滚和清理错误分别报告 |
| 边界保护 | 主要依赖进程文件权限 | 可配置允许根、只读和禁删；识别真实路径/链接及受保护根；拒绝目录双向祖先重叠 |
| 分发与验证 | 本地脚本启动，无仓库测试套件 | npm CLI 入口、模块化源码、结构化响应、回归/真实 stdio/Windows 适配测试及 CI；最低 Node.js 20 |

**本次重点修复**：原始明文文件经 MCP 编辑后出现加密内容，而 Node 读回正常、编辑器却显示密文。修复基于每个文件的写入前状态，适用于所有扩展名、未知后缀、无扩展名和点文件。文本工具仍只接受有效 UTF-8，二进制文件通过复制/移动使用相同的提交保护。

**累计修复与优化**：拒绝非法 UTF-8、UTF-16 和 NUL 文本的破坏性编辑；修复分页边界、换行匹配、复制移动重叠、并发追加及部分失败状态；安全中转失败不再回退直写；锁和临时文件清理失败不会掩盖主操作结果；工作线程和扫描预算防止复杂表达式阻塞服务。依赖锁定与 overrides 用于复现已验证的依赖树。

**升级行为变化**：显式 `writePolicy` 优先，其次是持久人工策略，再由 `auto` 观察文件状态。Windows 的 `auto` 缺少可用外部读取器时返回 `DISK_UNVERIFIED`，不会猜测后继续写入；需要新建受保护文件时明确指定 `preserve` 或配置人工 `protected`。更新后重启全部 MCP 实例，并用 `check_status` 确认运行版本为 `2.1.0`。

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
- `lib/locks.js` 登记路径及子树占用；`lib/cleanup.js` 保留主操作结果并收集清理错误
- `lib/text.js` 严格 UTF-8 增量解码与流式分页
- `lib/patterns.js` 无回溯 glob 与保留原索引的字符串替换
- `lib/regex.js` / `lib/regex-worker.js` 用户正则与字面量编辑在可终止 worker 中执行（单次计算默认最多 1 秒，并受请求总预算约束）
- `lib/server.js` 注册全部 18 个 MCP 工具，统一 structuredContent 与超时/只读包装

## 环境自适应

### 解决的问题

加密行为可能随目录、文件类型和进程变化。Node 能读到明文，并不表示 IDEA 或其他编辑器也能解密。新建探测样本的分类只描述进程观察，不能替代原文件的状态：

| 探测分类 | 实际观察 | 新建文件的 auto 策略 |
|----------|----------|----------------------|
| **safe** | Node 和外部读取视图均与探测载荷一致 | 允许先写暂存文件，暂存及最终路径仍须通过明文校验 |
| **protected** | Node 读回正确，外部读取视图不同 | 不推断其他编辑器可解密，使用安全中转并验证明文 |
| **unsafe** | Node 读回已经与探测载荷不同 | 使用安全中转并验证明文 |
| **unknown** | 无法取得外部读取结果 | 不能宣称安全；有读取器时只允许通过严格明文校验后提交 |

已有文件的状态不缓存、不按后缀共享：每次 `auto` 都比较该文件的 Node 指纹与外部进程指纹。两者一致时要求明文提交；两者不同时走受控写入，并检查外部视图没有意外变成预期明文。复制/移动覆盖已有目标时参考目标状态，新目标参考源文件状态；目录内逐文件执行。

### safeWrite 原理

明文暂存写入出现内容不一致、目录探测不适合直接写入，或明确要求安全中转时，流程切换为：

```
1. 写入目标目录下 .mcp-safe-<uuid><候选扩展名> 的随机临时文件，并验证其内容
2. 用可用外部进程（powershell/pwsh/cmd/robocopy/cscript）复制到 .mcp-stage-<uuid><目标扩展名>
3. 用Node和外部读取器（PowerShell 流式 SHA256+size）验证暂存文件与预期载荷一致
4. 清理临时文件
5. 失败则遍历全部「安全扩展名 × 可用进程」组合重试；
   全部失败直接报错（SAFE_WRITE_FAILED），不再回退未经验证的写入
```

暂存成功后仍需 rename 提交及最终路径校验，最终校验失败会回滚。外部进程是否会加密、是否会自动解密均不能仅凭进程名称判断；上述校验是进程可见字节对照，不是绕过驱动读取原始磁盘。

### 探测与缓存

- **首次需要自动策略（或缓存失效）时探测**：在系统临时目录用候选扩展名写入样本，通过 Node 与外部进程指纹对照分类，并探测可用复制进程
- **目录级探测**：无原文件或复制源状态可参考的新建路径，按「目标目录 × 扩展名」创建随机样本（`.mcp-probe-<uuid><ext>`，写完即删），观察缓存在内存 scopes 中。已有文件优先逐文件观察，不受旧目录分类覆盖
- **自动缓存位置**：`~/.mcp-encryption-profile.json`（结构 v3），按 machineId（hostname+username 哈希）绑定，换电脑/换用户重新探测；有效期 30 天。兼容有效的 v2/v3 缓存，丢弃旧 scopes；v2 人工 protected 一次性迁移到独立策略目录
- **人工策略独立存储**：`~/.mcp-file-policies/` 每个扩展名一个文件，刷新探测、TTL 过期、服务重启都不会删除人工标注
- **查看/刷新**：用 `encryption_profile` 工具查看当前探测结果与人工策略；加密策略变更后用 `refresh_profile` 强制重探（只刷新自动探测，不动人工策略）；`inspect_write_strategy` 可预览某个目标路径将采用的写入策略而不修改目标文件
- **无外部读取器时**：Windows 的 auto 返回 `DISK_UNVERIFIED`；非 Windows 且没有该后缀的加密观察时保留 Node 内容校验，返回 unknown 并告警。显式 plaintext 在所有平台都必须有可用外部读取器。配置过的读取器临时失败时不得降级为成功

### 写入策略（writePolicy）

write_file / edit_file / copy_path / move_path 均支持 `writePolicy` 参数：

| 值 | 语义 |
|----|------|
| `auto`（默认） | 人工标注优先；否则原明文要求明文终验，原受保护文件保留受控写入；新文件要求明文，不自动沿用探测样本的加密状态 |
| `preserve` | 显式受控写入，经暂存替换并校验 Node 内容；不保证原来的明文状态，也不保证其他编辑器能解密 |
| `plaintext` | 显式安全中转，必须验证暂存及最终路径的外部指纹与预期明文一致；失败中止或回滚 |

返回的 `strategy.basis` 区分 `explicit`（本次显式策略）、`override`（人工标注）、`target`（原目标）、`source`（新复制目标的源）、`new_file`（全新文件）和 `unverified`。`originalState` 记录自动决策依据；`category` 描述观察结果，不是编辑器兼容性认证。`user_unsafe` 在显式 plaintext 下也会返回，不表示新增了永久标注。

### mark_extension 手动标注

当需要固定某类文件的写入方式时手动标注（本次显式 writePolicy 优先，其次人工标注，再次自动状态判断；标注持久化，重启/刷新不丢失）：

| 场景 | 调用 | 效果 |
|------|------|------|
| `.java` 需要受控写入 | `mark_extension(".java", "protected")` | auto 采用 preserve；仍需确认实际使用的编辑器能正常读取 |
| `.custom` 需要固定明文写入 | `mark_extension(".custom", "unsafe")` | auto 强制使用安全中转及明文校验 |
| 恢复自动分类 | `mark_extension(".java", "clear")` | 写入墓碑清除标注，恢复实时探测 |

## 写入保证

所有文本修改（write_file / edit_file）与文件复制/移动都经过统一的可回滚提交流程：

```
改前指纹 → expectedHash/overwrite 校验 → 策略决策
  → 同目录随机独占暂存 .mcp-stage-<uuid><ext>（外部进程中转时经安全扩展名）
  → fsync 刷盘 → 再次比对改前指纹（防并发改动）
  → 原文件 rename 为 .mcp-backup-<uuid><ext> → 暂存 rename 到位
  → 指纹终验（SHA256+size；自动状态策略同时检查外部读取视图）
  → 成功删除备份；任一步失败自动回滚，回滚失败返回 recoveryPath（备份不得删除）
```

- **完整载荷**：追加模式先在内存合成「原内容+新增」完整内容再走事务，纠正/重写不会丢原文与 BOM
- **safeWrite 失败即中止**：不再回退直写破坏原文（SAFE_WRITE_FAILED，changed=false）
- **跨实例锁**：使用同一 `MCP_PROFILE_DIR` 的实例经 `.mcp-file-locks/` 登记整组路径，同路径及祖先/后代相互排斥，无关路径可并行（等待 5 秒超时 FILE_BUSY）；`expectedHash` 可检测其他编辑器造成的版本变化（CONFLICT）。升级时应重启全部 MCP 实例，避免旧进程继续执行旧的锁和写入策略
- **清理状态**：提交或锁清理失败会附带 `cleanupErrors`；主操作已成功时保留成功结果和真实 `changed`，错误时保留原错误及 `recoveryPath`。不要因清理告警重复追加内容
- **递归删除**：逐项执行，失败时返回 `changed`、`partial`（最多100项）、`removedCount`、`partialTruncated`、`failedPath`；受一万项和128层预算限制，不是整树事务
- **断电/强杀残留**：两次 rename 之间的极端崩溃可能留下 `.mcp-backup-*` 与 `.mcp-stage-*`，先核对内容与时间再人工恢复，禁止直接批量清理
- **复制/移动目录**：逐文件执行相同策略；移动先复制并二次比对指纹后再删除已验证的源文件；失败返回 `partial` 与 `sourceRetained`，不静默回退；符号链接明确拒绝；源和最终目标存在任一方向的祖先关系时拒绝，相同路径保持不变。回滚失败时 `changed=true`，`partial` 包含当前失败目标，原备份通过 `recoveryPath` 返回
- **移动失败的源变化**：`sourceRetained` 表示本次是否尚未删除任何源文件或源目录；`removedSourceCount`、`removedSourcePaths`（最多100项）、`removedSourcePathsTruncated` 报告已经删除的源项。失败仍保留已完成子项的 `cleanupErrors`
- **策略探测互斥**：`inspect_write_strategy` 持有目标父目录锁，创建和清理探测样本完成后才允许该目录被复制、移动或删除
- **glob总预算**：生产搜索与查找使用异步匹配，合并重复模式和分支；一次请求的展开后累计长度最多10万，编译和全部路径匹配共用5000万工作单元预算。约每16384工作单元让出事件循环，检查取消与截止时间；超过限额返回 `GLOB_LIMIT`，超时返回 `TIMEOUT`
- **diskState 三态**：`plaintext`（Node 与外部视图均匹配预期明文）、`preserved`（Node 内容通过受控写入校验，不保证其他编辑器可解密）、`unknown`（仅内容校验，不能声称已验证明文）。自动保留原保护状态还返回 `protectionObserved:true`，表示外部视图仍不同，并非密钥或加密完整性认证
- **校验边界**：如果外部读取器也被透明解密，两种视图一致仍不能证明原始磁盘未加密。上线前用真实驱动及目标编辑器验收；已经损坏或已经加密的异常文件不会因升级而自动修复

## 文件结构

```
mcp-read-file-server/
├── README.md         # 本文档
├── SKILL.md          # 配套 Skill（可选，让 AI 学会自动选用本工具）
├── index.js          # MCP Server stdio 入口（含 shebang，可作可执行入口）
├── lib/              # 生产模块（encryption/files/text/patterns/regex/server）
├── scripts/          # 开发检查工具（check.js：语法+LF 检查）
├── test/             # 仓库内回归/协议/适配测试
├── package.json      # 包配置（bin/files/依赖声明）
├── .gitignore        # Git 忽略规则
└── node_modules/     # 依赖（@modelcontextprotocol/sdk、zod）
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

> 行模式文本带行号，结构化结果含 `lines`、`nextLine`、`truncated`、`totalLines`。到达请求结束行即停止；未扫描到 EOF 时 `totalLines=null`，`nextLine` 是待确认的续读起点，可能已超过 EOF（下一次调用会明确报 `LINE_OUT_OF_RANGE`）。首行加上行号开销超过页预算时返回 `LINE_TOO_LONG`，请改用字符分页，不会返回游标不前进的成功空页。

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
1. 会话开始先调 check_status 确认服务版本与运行状态；它不自动证明解密正常。环境不明时调
   encryption_profile 查看本机扩展名分类与人工策略；
   写入前可用 inspect_write_strategy 预览目标路径的写入策略。
2. write_file/edit_file/copy_path/move_path 默认 writePolicy=auto：
   原明文文件保持明文校验，原受保护文件保持受控写入，新文件默认要求明文。
   明确需要受控写入用 preserve，明确需要明文用 plaintext。
   preserved 不证明 IDEA 等其他程序能解密；Windows 缺少外部读取器时 auto 拒绝写入。
3. 需要长期保持加密/明文的扩展名：用 mark_extension(".java", "protected")
   或 mark_extension(".custom", "unsafe") 标注一次永久生效（独立存储，
   重启与刷新探测不丢失）；mark_extension(".ext", "clear") 恢复自动。
4. edit_file 前必须先 read_file 拿原文，oldString 从原文原样复制
   （含空格与缩进；CRLF/LF 换行差异会自动兼容，无需手工处理）；
   重要修改先 dryRun=true 预览；可用 expectedHash 防止覆盖他人改动。
5. 路径一律使用绝对路径。
6. 写工具返回 isError 时先看 structuredContent 的 code：
   SAFE_WRITE_FAILED/DISK_MISMATCH 表示写入校验失败；检查 changed 和恢复信息，
   不要改用普通 shell 覆盖。出现 recoveryPath 说明回滚
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

测试位于 `test/`，包含基础回归、真实 stdio、Windows 适配器、边界/并发修复以及 `write-policy.test.js` 通用写入状态回归；模拟读取视图与真实驱动验收分开，不触碰真实 profile。可通过 `MCP_TEST_ROOT` 指定独立测试目录。CI 配置覆盖 Windows/Linux × Node 20/22/24。运行依赖：MCP SDK 1.30.0、Zod 4.4.3，间接依赖 fast-uri/qs/Hono 通过 overrides 限定修复版本。

## 故障排查

### 读取到的仍是密文

可能是 Node.js 未被授权解密，也可能是该文件类型、路径或原文件状态不满足解密条件。先保留原文件，确认运行入口与实际 `node.exe` 路径，再核对加密软件配置；不能只凭“程序在白名单”就认定所有文件均可解密。

### MCP Server 无法启动

```bash
# 验证 Node.js 和依赖
node --version
cd mcp-read-file-server && npm ci

# 测试启动
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}}}' | node index.js
```

### MCP 返回成功，但编辑器打开显示密文

Node 可读不等于其他编辑器可读，不能只凭锁图标判断状态。当前版本对所有文件类型统一处理原明文状态。若仍出现异常：

1. 用 `check_status` 确认实际服务为 2.1.0，保留异常文件和当次完整响应，不直接覆盖修复。
2. 查看 `strategy.basis/originalState`、`diskState/diskVerified` 和 warnings，确认是否有显式 preserve 或人工 protected 覆盖自动决策。
3. 使用独立副本验证所需策略，并检查外部读取器是否同样被透明解密。已经异常的受保护文件不会被 auto 自动解密；需要恢复时先核对原始备份。

### 写工具返回 SAFE_WRITE_FAILED / DISK_MISMATCH

safeWrite 全部组合失败返回 `SAFE_WRITE_FAILED`；最终路径校验不一致返回 `DISK_MISMATCH` 并尝试回滚。不回退未经验证的写入，是否恢复成功以 `changed/recoveryPath/rollbackError` 为准。检查目标目录权限、外部进程可用性和实际读取视图；环境已发生变化时再考虑 `refresh_profile` 重探。

### 写工具返回 DISK_UNVERIFIED / PROTECTION_MISMATCH

- `DISK_UNVERIFIED`：无法取得所需外部读取视图。Windows auto 不能据此猜测原文件状态；检查读取器可用性，不要为了通过测试盲目切到 preserve。
- `PROTECTION_MISMATCH`：自动保留受保护文件时，暂存或最终目标的外部视图变成了预期明文；为避免静默改变保护状态而中止或回滚。确实需要明文时应明确指定 plaintext，并用独立样本验证。

### 写工具返回 FILE_BUSY / CONFLICT

- `FILE_BUSY`：另一个 MCP 实例正在操作同一路径、父目录或子路径（锁位于 `~/.mcp-file-locks/`）。确认对方进程结束后重试；异常退出时仅在核对记录中的 PID 后处理残留 `.lock` 或 `.registry-guard`。`LOCK_CLEANUP_FAILED` 和 `cleanupErrors` 会给出未清理路径，不应直接清空整个锁目录
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
