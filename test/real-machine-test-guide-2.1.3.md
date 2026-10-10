# mcp-read-file-server 2.1.3 真实加密电脑验收说明

文档日期：2026-10-10。用途：将本文件完整交给真实加密电脑中的 Agent 执行，生成可供开发端复核的测试报告和原始证据。本文自包含，无需知道此前聊天内容。

当前待测版本：2.1.3（2026-10-10 CI验收修订）。保留原加密保持加密、原明文保持明文、新建默认明文的规则；本次增加5项适配器预算/诊断回归，Windows完整套件为140项。真实适配器验收显式采用30秒单进程、60秒整项预算；生产默认仍为5秒且受请求deadline约束。源码指纹已同步。定向真机补测仍使用real-machine-gap-retest-2.1.3.md。

## 0. 本轮变化与不可改变的规则

2.1.3包含2.1.2已完成的C06修复：新文件在eol省略/auto时不再把CRLF强制转换成LF；空文件或原文没有换行时同样保留输入，包含混合换行。已有换行风格的文件仍沿用原风格，显式lf/crlf仍按要求转换。本轮没有针对.scss添加特判，也没有更改加密判断、暂存提交或回滚算法。

本轮必须分别验证以下规则，不能用一种后缀的结果替代另一种状态：

| 默认auto且无人工覆盖 | 必须满足 |
| --- | --- |
| 原文件为明文P | 修改后仍为明文 |
| 原文件为受保护E | 修改后仍受保护，且实际编辑器仍可读 |
| write_file创建新文件 | 默认明文；没有可靠明文校验能力则拒绝，不能降级成加密文件冒充成功 |
| copy_path/move_path新目标 | 沿用源状态；覆盖已有目标则以目标原状态为准 |

显式writePolicy和人工mark_extension仍是有意的覆盖入口，只在专门的隔离策略用例中使用。主验收必须确认没有人工覆盖。

上一轮观察到受保护.scss编辑后IDEA乱码，但缺少编辑前可读证据；**该兼容性问题尚未确认根因，也没有宣称已经修复**。本轮必须先建立编辑器可读基线、保留未编辑对照，再测写入。若初始文件就乱码，应归为基线不成立，不能归因于本次MCP编辑。

## 1. 给执行 Agent 的任务

请在当前真实加密环境中验收 **mcp-read-file-server 2.1.3**。先核对实际加载的代码，再准备隔离样本，按本文执行测试。最后交付 Markdown 报告及可定位到每次调用的证据。

本轮只测试，不修复源码，不改变包版本，不升级依赖版本，不发布、不提交代码。遇到失败先保存证据，不要修改代码、人工策略或加密软件设置让测试“通过”。确需修复时留待开发端复核。

### 1.1 执行范围

- 可以建立本次专用目录、启动独立测试 MCP 实例、创建/修改/复制/移动/删除本次可丢弃样本，以及在独立 profile 中测试人工策略。
- 使用真实驱动和真实 stdio MCP 调用，不用伪造磁盘视图、替换 fs/加密适配器或直接调用内部 handler 冒充真机验证。仓库自动化测试单独报告。
- 不修改真实业务文件、用户默认 profile、已有人工标注、生产 MCP 配置或加密软件白名单。不要关闭驱动、绕过公司策略、把文件上传到外部服务，或通过更换进程来规避访问控制。
- 允许读取本次样本、测试所需环境信息及启动配置；配置中的令牌、用户名、服务器地址等非必要信息应脱敏。不要收集业务源码或凭据。
- 无法确认测试目录、独立实例或受保护样本时，记录 `BLOCKED` 和具体缺少的条件；可以继续不依赖该条件的测试。不要编造执行结果。
- 每个用例只操作自己的样本路径。出现内容损坏、越界写入、原受保护文件意外成为明文、编辑器异常或恢复备份时，立即暂停该场景的后续写入，先保存证据。其他独立且不依赖该样本的用例可继续。
- 默认不做断电、强杀进程、修改ACL或制造磁盘满。这些不是本次核心验收的前置条件。

### 1.2 状态定义

| 状态 | 判定 |
| --- | --- |
| PASS | 实际执行且满足本用例所有要求，证据完整 |
| FAIL | 已实际执行，结果与预期不符，包括工具成功但内容/状态/编辑器结果不符 |
| BLOCKED | 缺少真实受保护样本、可区分视图的读取器、编辑器访问或必要权限，无法完成验证 |
| NOT_RUN | 尚未执行或可选条件不具备；写明原因 |

正向写入返回错误、原文件未坏，可以记“数据保全通过”，但**不能把正向兼容性用例记为 PASS**。负向用例按预期报错且文件保持不变才是 PASS。

请同时给出 contentResult、stateResult、editorResult、overallResult 四个维度。未观察编辑器的核心写入用例不能填整体PASS，只能标“内容/状态通过，编辑器BLOCKED”。同一个用例的首次失败与复测必须分行，不能把旧FAIL悄悄改掉。不要使用PASS_OR_ENV、PASS(部分BLOCKED)等混合状态；将不同分支拆成唯一子用例ID。

## 2. 先核对待测代码与环境

### 2.1 代码身份门槛（ENV-01，必做）

1. 记录启动入口的绝对路径、实际 Node 可执行文件路径和版本、npm版本、操作系统版本、客户端名称、加密软件/驱动名称和版本、目标编辑器名称和版本。
2. 本地修复不一定已发布到 npm。不要直接使用不带版本的 `npx -y mcp-read-file-server` 并假定是本次代码。优先启动用户提供的完整修复版源码目录中的 `index.js`；不要仅修改旧包的版本号。
3. 通过真实 MCP `initialize`、`tools/list`、`check_status({})` 核对版本为 **2.1.3**，18个工具正常注册；保留原始响应。工具名前缀可因客户端不同而变化，下文均使用短名。
4. 计算下面文件的 SHA-256，与本地实际执行内容比较。当前修复尚未提交，仅相同 Git HEAD 或相同版本字符串不足以证明代码一致。对源码使用同一个受信任 Node 读取其可执行明文字节计算hash，避免把外部进程看到的加密字节当作源码hash。
5. 任何生产文件指纹不一致时，报告 `BLOCKED: BUILD_MISMATCH`，列出差异；停止将结果称为“本次2.1.3修复版验收”。若用户提供了后续合法修改版，可另开明确标识的测试批次，不能擅自修文件匹配指纹。

以下hash按原始字节计算，不先转换换行。若只是传输造成换行变化，也应记录并核对来源，不静默忽略。

```text
package.json          e180f82012aecbe73b44022ceec20e068cbb409a76e2599a8884ae287ce8decc
package-lock.json     a45531648320ada803baaf4c8a458f1f4cdbeedacf985f804d92d7d06bffea89
index.js              dc3417b3277f72bf7bbec964ba36b2647d5c44192651fded7888098d180a2d23
lib/cleanup.js        f94567f0471359cc6eae31221922d3a2396bbe8793556af9a06676cd7ff3fddb
lib/encryption.js     4fafce975b7144e4e58c206a46b6d1623abedb609ff620d15cebd45e5ecb3f57
lib/files.js          88901f59d7ebf43dda36135a8a942418f1cb5754dd6db2d627fc69d8c2fbd0ea
lib/locks.js          8a51d564bdddf81866495aa80be5baba3daf7d5c2ba224aa50464437a70e6e4d
lib/patterns.js       9ffd7c42d264e8c775a7ec8af1f867fda5b788e3b17688fc4726815c06464668
lib/regex-worker.js   9a987490fac2b72d1d4d21ef0d449732e84531e9fbc44584fa6c55b135937797
lib/regex.js          dc66fe69600df44ec10a8fccf42a330609f9aabf6fd57ba91da64cb37f6e14e3
lib/server.js         e0af0b63b2aa88fc45aade2ff460d47713b5ed2e74772b51cef234fce441a54f
lib/text.js           0ae857af0fd943c26edb9cb43866f7631e8d31c0d3c7073989cb695c8929f493
```

预期直接依赖：SDK 1.31.0、Zod 4.4.3；锁定修复依赖：fast-uri 3.1.8、hono 4.13.7、ip-address 10.7.3、proxy-addr 2.0.8。只记录差异，不为追求测试通过更新锁文件。

### 2.2 隔离目录和实例（ENV-02，必做）

优先使用 `D:\AgentWorkFiles\ResultFiles\{当天日期}-MCP2.1.3真机验收\run-{时间或随机ID}`。同名目录已存在则另建唯一run目录，不覆盖上次结果。示例结构：

```text
run-.../
  cases/            # 被测文件，允许修改
  profile/          # 该真实MCP实例独占的缓存、人工策略、锁
  evidence/         # 调用原文、观察结果、截图、hash清单
  report.md         # 最终报告
```

`cases` 必须受与故障现场相同的真实加密策略约束。若上述D盘路径不在加密覆盖范围，不能只在这里成功就宣称通过。请使用用户/管理员已经允许的同策略隔离目录作为 `cases`，在报告中写明实际位置；不要直接在真实项目原件上测试。报告和证据仍保存到本次run目录。

为临时测试实例设置下列环境变量，值必须为实际绝对路径：

```text
MCP_BASE_DIR=<cases绝对路径>
MCP_ALLOWED_ROOTS=["<cases绝对路径>"]
MCP_PROFILE_DIR=<profile绝对路径>
MCP_READ_ONLY=0
MCP_DISABLE_DELETE=0
```

`MCP_ALLOWED_ROOTS` 是JSON数组，Windows反斜杠需正确转义。跨卷测试时才增加专用第二根。不要把整个盘符作为允许根。profile和证据放在待复制/移动目录树之外。

可以使用单独客户端条目，或使用 SDK 启动独立 stdio 子进程；记录实际PID、启动参数与环境。不要假设终端的环境变量会自动传入已运行的客户端。所有参与并发测试的实例必须使用**同一个**本次profile；其他测试批次不可共享。不要停止用户正在使用的其他服务。

## 3. 准备可信样本与三种观察证据

### 3.1 固定内容与预期hash

下面是JSON字符串，先按JSON解码再编码成UTF-8字节；不得把 `\r\n` 或 `\uFEFF` 当作字面文本写入。S0包含BOM、CRLF、中文及emoji，用来检测编码和行尾损坏。为与上一轮直接对比，S0—S3及其hash保持原样；内容中的MCP_REAL_2_1_1只是固定样本标记，不是当前服务版本。

```json
{
  "S0": "\uFEFF/* MCP_REAL_2_1_1 中文😀 */\r\n$color: #123456;\r\n.title { color: $color; }\r\n",
  "S1": "\uFEFF/* MCP_REAL_2_1_1 中文😀 */\r\n$color: #654321;\r\n.title { color: $color; }\r\n",
  "S2": "\uFEFF/* MCP_REAL_2_1_1 中文😀 */\r\n$color: #654321;\r\n.title { color: $color; }\r\n/* APPEND_01 */\r\n",
  "S3": "\uFEFF/* MCP_REAL_2_1_1 中文😀 */\r\n$color: #abcdef;\r\n.caption { color: $color; }\r\n/* APPEND_01 */\r\n"
}
```

| 内容 | UTF-8字节数（含BOM） | SHA-256 |
| --- | ---: | --- |
| S0 | 81 | `537e68e3d17945b1b952f69f62bfc54fb10489dc4402e46d7ad016b14a534e86` |
| S1 | 81 | `1325a26dc9481aae2813de5b3888811529ae369939e7b68cad62f7608fc160f8` |
| S2 | 98 | `419c62968df9aac7daf51a0228645acda9463b083613c8a4be3cff66bdc919f8` |
| S3 | 100 | `62492df974c84b70f0ede67bad456da9518a39897a21f4fbc3a1c2c52dbfbde4` |

其他样本的预期hash必须在操作前，由明确的输入字节/期望变换独立计算并保存。不能读操作后的目标文件计算hash，再拿同一个hash证明它正确。

### 3.2 三种观察方式（ENV-03，必做）

每个关键写入用例都要有操作前和操作后的以下证据：

1. **Node视图**：使用被测服务的 `file_info({path,calculateHash:true})` 得到hash和 `sizeReadable`；必要时通过同一Node可执行文件读取完整字节独立核对BOM/行尾/内容。`sizeOnDisk` 是文件系统元数据，不能代替明文字节数。
2. **外部进程视图**：使用独立启动的PowerShell/pwsh或现场批准的读取器，以流方式读取完整文件并计算SHA-256、实际读取字节数和前16字节十六进制；记录读取进程绝对路径和版本、退出码、读取错误。不能把 `Get-Content` 解码后的字符串hash当作原始读取字节hash，也不能只检查 `%TSD` 头。一次观察中的hash、大小、前缀应来自同一个打开句柄。
3. **目标编辑器视图**：使用实际发生过问题的编辑器重新从磁盘加载目标文件，记录文本是否与预期一致、是否乱码/密文/不能打开，以及锁图标现象。编辑器应关闭自动保存、格式化保存等对样本的干扰；打开后不保存。截图或人工确认必须标明文件、时间及本次重新加载动作。旧缓冲区画面不能作为写入后的证据。

若Agent没有编辑器控制能力，请保留自动证据，并请用户完成该项观察。未观察不能填PASS。锁图标只作辅助，不能独立判定加密状态。

外部读取器也可能在透明解密白名单内。两个进程hash相同只能证明两个视图一致，**不能直接证明底层磁盘是明文**。必须用下面已知受保护对照样本验证读取器能否区分状态。不得以磁盘驱动/原始扇区读取或关闭安全软件绕过此限制。

### 3.3 现场建样方法和基线（ENV-04，必做）

在加密策略生效的同一目录准备两类可丢弃样本，尽量使用相同后缀（优先 `.scss`，另选至少一种现场确实受保护的后缀）。通过现场正常且已获准的编辑器/加密流程建样，记录创建者和方法。

| 基线类别 | 必须满足的条件 |
| --- | --- |
| P：原明文对照 | Node内容等于S0；经过受保护对照验证的外部读取器也读到S0；目标编辑器能正确打开 |
| E：原受保护对照 | 通过现场正常受保护流程建立；Node内容等于S0；外部读取器看到不同于S0的字节；目标编辑器在修改前能正确打开 |

不能仅通过被测MCP写出样本再用其自身返回值证明初始状态正确。优先使用现场正常流程建立文件；记录每个工作样本的创建方法，而不只记录c01的两个样本。复制、另存或改名都可能改变加密状态，因此任何工作副本都要重新检查基线。

**对E的硬性门槛：**先在IDEA或用户实际目标编辑器中重新加载，确认S0可读并保存时间/截图或用户确认，之后才允许开始C03/C04/C08等修改。由Node直接创建的受保护文件若修改前就乱码，只能作为“建样方式兼容性”诊断，不能当作合格E，也不能把后续乱码算成MCP破坏。

**对同后缀P的补测：**上一轮C06和C07已观察到明文.scss，因此不能仅因Node直接创建.scss会加密就断言该目录无法存在P。优先使用现场批准的明文建样方式；必要时可用独立的、明确标注为setup的plaintext请求建立可丢弃样本。此setup本身不是待测auto结果，且必须用固定S0 oracle、独立外部完整hash和编辑器重新加载三者确认，稳定后才开始auto修改。setup失败或无法独立确认时才BLOCKED；禁止关闭驱动或更改全局策略。

如果无法同时建立P和E，或外部进程对E也读到S0，对应状态保持验收标为BLOCKED。不要修改白名单强行获得差异；普通读写用例仍可执行，但结论必须限定范围。

每个关键后缀至少设置三个独立路径：E-control（始终不修改）、E-edit（auto修改）、P-edit（auto修改）。三者都先做完整基线，尤其确认两个E在编辑器中原本可读。操作E-edit后，同时重新加载E-control。基线不合格时停止该正向用例，留下证据后更换正常建样流程，不在不合格文件上连续试写。

如果历史27字节明文SCSS样本仍可获得，可以另建经确认的可丢弃副本，增加历史回归用例；其实际内容/hash单独记录，不用本文S0冒充历史原件。

### 3.4 保存时间点

关键成功写入后：立即、约2秒、约10秒分别记录Node和外部视图；至少在10秒时重新加载编辑器。环境有已知更长延迟时另加一次30秒观察。不要在观察期间再次写文件。

这些时间点用于发现驱动异步处理或编辑器缓存；记录实际时间，不要求精准到毫秒。为每次修改分配operationId，同一个operationId下记录post-0s、post-2s、post-10s三个Node/外部快照，不能用三次不同写入后的观察凑数。先确认建样后的状态已稳定。加密后的外部hash可能因重新加密而变化，E写入后的通过条件是“Node等于期望、外部仍不同于期望、编辑器仍可读”，不是要求外部hash永远等于旧密文hash。

## 4. 原始调用记录和通用检查

### 4.1 每次调用必须留存

建议按 `evidence/<用例ID>/` 分目录，保存：

- 请求工具名、完整参数、开始/结束时间、耗时、请求ID与实际服务PID。
- 原始MCP响应，包括 `content`、`isError`、完整 `structuredContent`；不要只摘“成功/失败”。不存在的字段记为“未返回”，不补写推测值。
- `ok/code/changed`、`hash`、`strategy`、`diskState/diskVerified/contentVerified/protectionObserved`、`via`、`warnings`。
- 失败时保留 `reasons/matched/createdDirectories/cleanupErrors/partial/sourceRetained/removedSourceCount/recoveryPath/rollbackError` 等实际返回字段。
- 操作前后各视图、预期hash、编辑器截图/观察记录，以及残留文件列表。

正常UTF8样本写入成功应满足Node明文hash/字节数等于独立预期。P的auto写入成功应返回明文校验结果且三视图一致；E的auto写入成功应保持外部不同于明文，通常有 `diskState=preserved`、`protectionObserved=true`，但 `diskVerified=false`。这个false不是失败，也不是保证其他编辑器可解密。

手工/显式preserve的成功仅表示Node内容校验，可能没有originalState/protectionObserved；不能套用auto的字段要求。

### 4.2 失败后的处理

- 正向用例失败后保留第一次结果，最多在确认环境原因后使用**全新独立样本**复测一次；首次失败仍列入报告，不能覆盖。
- 不把auto失败改成preserve或plaintext后成功当作auto通过；不同策略是不同用例。
- 失败且 `changed=false` 时核对目标和源是否仍存在、Nodehash是否保持、是否确有新增目录。如果新增父目录，2.1.3应返回 `changed=true` 与 `createdDirectories`，不能据此声称文件内容已改。
- `changed=true` 或有partial时逐项核实，不重复执行追加、移动或删除。
- 出现恢复备份时保存路径及其Node/外部hash；不要直接删除 `.mcp-backup-*`。锁残留先记录文件内容与PID，不直接清空profile。
- 检查辅助文件残留使用平台目录枚举或 `list_directory(showHidden=true)`；`find_files/search_files` 会过滤 `.mcp-*`，不能靠它们证明没有残留。

## 5. 核心真实加密验收（必做）

占位符 `<F>`、`<SRC>`、`<DST>` 必须替换成当前用例的真实绝对路径；不要把占位符原样发送。示例是MCP工具参数，S0/S1等指按第3节解码后的完整字符串。

每个写入用例使用全新、已重新确认状态的样本；不要用一次失败后的文件继续整串操作。

### C01：状态工具与自动探测

1. 先调用 `check_status({})`；它只验证服务存活，`decryptionVerified=false`是预期，不是加密验收结论。
2. 调用 `encryption_profile({"timeoutMs":60000})`，保存完整输出。确认cachePath/policyDir落在本次profile，`overrides`没有历史人工覆盖，记录byteReader和availableProcesses。
3. 分别对P、E调用 `check_status({"path":"<F>","expectedHash":"<S0_HASH>"})`，应内容匹配并 `decryptionVerified=true`。
4. 分别调用 `inspect_write_strategy({"path":"<F>","writePolicy":"auto","timeoutMs":60000})`。P预期basis=target、originalState=plaintext；E预期basis=target、originalState=protected。调用前后目标内容不变。
5. 缺少外部读取器时Windows auto应拒绝，不能据此宣布实际写入通过。先报告环境阻塞；不要改策略掩盖它。

### C02：最重要的回归——原明文auto编辑

对P/S0执行：

```json
{"path":"<F>","oldString":"#123456","newString":"#654321","expectedMatches":1,"expectedHash":"537e68e3d17945b1b952f69f62bfc54fb10489dc4402e46d7ad016b14a534e86","writePolicy":"auto","timeoutMs":60000}
```

调用工具：`edit_file`。最终必须是S1、81字节，BOM/CRLF保持；P外部视图仍等于S1，编辑器重新加载仍显示正常文本。记录返回strategy和是否使用安全中转via。出现“Node正常、编辑器密文/乱码”即FAIL，即使工具ok=true。

在 `.scss`、一种真实受保护的其他后缀、`.txt`、无后缀、点文件（如 `.real-sample`）、大小写后缀（如 `.SCSS`）、含中文/空格/括号的文件名分别执行。样本名避开内部保留前缀 `.mcp-`。每个变体单列结果，无法建P基线的变体标BLOCKED。

### C03：原受保护auto编辑

对E/S0执行与C02相同的请求。Node必须变为S1；外部视图仍不同于S1；编辑器仍能正确打开S1。不得因工具返回preserved而免做编辑器观察。外部变成明文是严重失败，立即保留证据并暂停该场景。

至少覆盖 `.scss`（若确实受保护）和一种现场确认受保护的其他后缀。同目录同后缀的P和E结果必须分别记录，不能用扩展名分类代替单文件判断。

### C04：覆盖写入、追加与批量编辑

P和E各执行一次以下流程，每一步成功且观察稳定后才进入下一步：

1. `write_file`，参数 `{path:<F>,content:<S1>,mode:"overwrite",eol:"auto",expectedHash:<S0_HASH>,writePolicy:"auto",timeoutMs:60000}`，应S1。
2. `write_file`，参数 `{path:<F>,content:"/* APPEND_01 */\n",mode:"append",eol:"auto",expectedHash:<S1_HASH>,writePolicy:"auto",timeoutMs:60000}`，应S2；输入LF应适配原CRLF，原文和BOM不得丢失。
3. `edit_file`，参数如下，应S3：

```json
{"path":"<F>","edits":[{"oldString":".title","newString":".caption","expectedMatches":1},{"oldString":"#654321","newString":"#abcdef","expectedMatches":1}],"expectedHash":"419c62968df9aac7daf51a0228645acda9463b083613c8a4be3cff66bdc919f8","writePolicy":"auto","timeoutMs":60000}
```

每一步均核对独立预期hash和状态保持，不能只检查最后一步。

### C05：预览与相同内容提交

- P、E/S0各调用一次C02编辑参数加 `dryRun:true`：应changed=false、proposedHash=S1_HASH；实际文件仍S0，三视图状态不变。
- P、E/S0各调用 `write_file` 写入完整S0、auto：内容已正确且状态满足策略时changed=false，但仍应返回与基线一致的实际校验结果，不应悄悄改变保护状态。

### C06：全新文件的auto策略与2.1.3行尾修复

在确认受保护策略生效的目录，对不存在的路径调用write_file：

```json
{"path":"<F>","content":"\uFEFF/* MCP_REAL_2_1_1 中文😀 */\r\n$color: #123456;\r\n.title { color: $color; }\r\n","mode":"overwrite","overwrite":false,"writePolicy":"auto","timeoutMs":60000}
```

分别使用省略eol和eol=auto，必须保持S0的81字节和原hash，不能再次得到78字节LF版本。至少覆盖.scss、现场另一受保护后缀、.txt、一个未知后缀、无后缀和点文件，均按同一规则验收。

另用独立小文件验证下表，每项操作前保存期望字节及hash；参数mode分别覆盖overwrite和append（新路径append也会创建文件）：

| 场景 | 输入/设置 | 预期 |
| --- | --- | --- |
| 全新路径，auto | LF、CRLF、CR、混合换行；各测有/无BOM | 输入行尾逐字节保留 |
| 空文件、仅BOM文件、无换行单行文件，auto | 含CRLF的新内容 | 没有旧行尾可继承时保留输入；BOM按原文件规则保持 |
| 已有LF/CRLF/CR文件，auto | 混合行尾的新内容 | 本次载荷转换为原文件主导行尾 |
| 新/旧文件，显式lf或crlf | 混合行尾的新内容 | 本次载荷转换为指定行尾；append不重写已有部分 |

例如混合输入可用JSON字符串"甲\r\n乙\n丙\r"；auto新建保持原样，lf为"甲\n乙\n丙\n"，crlf为"甲\r\n乙\r\n丙\r\n"。不要更改期待值去匹配错误输出。

正向兼容性通过：新文件Node与外部均等于S0，编辑器可读，basis=new_file。即使目录探测为protected，也不能仅凭这一分类把新文件自动变成受保护文件。

如环境没有任何可行明文写入路径，允许实现拒绝提交以保全数据，但本正向用例记FAIL/环境阻塞说明，不记PASS；单列“失败保全”结果。若创建了父目录，核对createdDirectories/changed。不要改用preserve补作通过。

### C07：显式策略对照（与auto分开）

1. 在P、E工作副本上分别使用 `writePolicy:"plaintext"` 写入S1。成功必须Node和外部都等于S1且编辑器可读；对E这是**仅针对可丢弃样本的显式状态转换**。策略不允许或不可验证则应失败并保留原文件，按正向兼容性与失败保全分别报告。
2. 在P、E其他工作副本上分别使用 `writePolicy:"preserve"` 写入S1。成功要求Node=S1，通常diskState=preserved、diskVerified=false并带校验范围告警。记录外部及编辑器实况；preserve不承诺原P仍明文。若编辑器不可读，记录为使用兼容性失败，不能把它与auto的状态保持要求混淆。

### C08：复制与移动的状态依据

对 `copy_path` 和 `move_path` 分别执行下表，策略auto、超时60000。源与目标内容故意不同，避免误入“相同内容未修改”分支。

| 源 | 目标操作前 | 预期目标内容/状态 | 策略依据 |
| --- | --- | --- | --- |
| P/S1 | 不存在 | S1，P | source |
| E/S1 | 不存在 | S1，E | source |
| E/S1 | P/S0 | S1，P | target |
| P/S1 | E/S0 | S1，E | target |

示例：`{source:<SRC>,destination:<DST>,writePolicy:"auto",overwrite:true,timeoutMs:60000}`。目标若是已有目录，最终路径是其下的源basename；操作前就计算并确认最终路径，再核对响应destination，防止检查错文件。

复制/移动返回的data是汇总结果，可能不包含strategy；未返回的字段记“未返回”，不要伪造，也不要仅因缺字段判失败。逐文件核对操作前后的状态及独立内容预期。

复制成功源必须保留且内容不变；移动成功应先有正确且可用的目标，再确认源已删除。失败时核对源是否保留、目标实际变化与partial/sourceRetained一致。任何未正确保存目标却删掉源的现象为严重FAIL。

### C09：混合目录逐文件策略

准备同一源树：P文件、E文件（尽量同后缀）、一个Unicode路径文件、一个空子目录。记录每个文件hash和P/E基线。

对全新目标分别执行auto目录复制和目录移动，核对每个目标文件的内容、状态和编辑器结果，以及空目录。再建立部分目标已存在且P/E状态与源相反的目标树做覆盖复制，确认已有目标参考目标状态，新目标参考源状态。

目录返回结果是汇总，不能强求其data含每个子文件的strategy；逐文件独立观察，并在完成后对目标调用inspect_write_strategy核对当前状态。目录操作不是整树事务，失败的partial及源保留情况必须逐项核对。

### C10：刷新、重启与人工策略隔离

先完成C01—C09，避免人工覆盖影响auto基线。下列操作只能作用于本次profile与可丢弃样本。

1. `mark_extension({extension:".scss",category:"protected"})`，再inspect该后缀工作副本的auto，应basis=override、mode=preserve。
2. 对独立工作副本显式plaintext写入，核对该写入响应的strategy.basis=explicit、mode=plaintext；如再用inspect验证，也必须传writePolicy=plaintext。另发inspect(writePolicy=auto)时，人工protected仍会返回basis=override、mode=preserve，这是正常行为。不要用auto检查结果反证先前显式plaintext的优先级。写入结果按C07判定。
3. `refresh_profile({timeoutMs:60000})`，再正常关闭并重启同一测试实例，确认手工protected仍存在。
4. 改为category=unsafe，auto应走plaintext人工覆盖；再clear，确认auto回到单文件target/new_file依据，不能继续命中旧人工策略。
5. clear后再次正常重启，使用新的P/E副本各重复C02/C03一次，确认缓存不会把一种文件状态错误套到另一种。

若现场后缀不是.scss，使用实际选定的后缀并记录。不得对用户默认profile调用mark_extension或refresh_profile。

## 6. 防损坏与本轮修复验收

### N01：过期hash与禁止覆盖（必做）

对P、E工作副本分别执行：

- 用64个`0`作为expectedHash调用edit_file，预期CONFLICT，内容/状态不变。
- 对已存在文件调用write_file并设overwrite=false，预期ALREADY_EXISTS，内容不变。
- copy_path对已存在且内容不同的目标设overwrite=false，预期ALREADY_EXISTS，源和目标均不被破坏。

### N02：批量原子性与实际匹配数（必做）

对S0调用edits：第一项把#123456替换为#654321，第二项匹配一个确定不存在的标记。预期NO_MATCH，目标仍S0，第一项不得部分提交。

另对含`aa`的工作样本，oldString=a、newString=b、expectedMatches=3，分别测试字面量和正则模式。应MATCH_COUNT_MISMATCH，data.matched=2，文件不变。

expectedMatches约束的是总匹配数，不是本次替换数。若要把aa改为ba，用replaceAll=false并省略expectedMatches，或设expectedMatches=2；预期matched=2、replaced=1。设expectedMatches=1应拒绝，不能把这个正确拒绝列为缺陷。

### N03：非UTF8及二进制防损坏（必做）

用已知字节分别准备UTF16LE+BOM、非法UTF8（如`FF FE`以外的孤立`80`字节）、含NUL样本；先保存字节hash。

edit_file以及write_file的append分别应拒绝，错误码按实际对应UNSUPPORTED_ENCODING、INVALID_UTF8或BINARY_FILE，原始Node可见字节hash保持不变。不要为了让用例执行而把它们转换成UTF8。

对一个小型已知二进制文件单独测试copy_path/move_path；这两种工具可复制字节，应校验完整hash，不能因文本接口拒绝就推断复制失败。

### N04：正则体量预算（必做）

准备1000个ASCII `a` 的新样本。调用edit_file：oldString=a、newString为20000个ASCII `b`、useRegex=true、replaceAll=true。实际输入字符串由脚本构造，不发送“重复20000次”的描述文字。

预期FILE_TOO_LARGE，原始1000字节hash不变，无新目标安装；随后check_status和一次小规模正常编辑仍成功。后续小编辑用oldString=a、newString=b、replaceAll=false，并省略expectedMatches或设为1000，期望matched=1000、replaced=1和b后接999个a。必须在同一服务PID中完成恢复验证；重启另一实例后的成功不能证明原实例恢复。不要用数GB载荷测试。

### N05：长literal、glob和只读工具（必做）

- 准备包含4096个连续`.`的单行，search_files设mode=literal、pattern为这4096个`.`、onlyMatching=true，应匹配完整内容，不能INVALID_REGEX。
- 建立`index.js`、`src/index.js`和`other.txt`，find_files的pattern=`{,src/}*.js`应返回前两项，不含other.txt。
- 对S0调用read_file、read_files、file_info、list_directory；核对读取内容、hasBom和文件信息。read_file返回的content去掉BOM，不能把content字符串自身hash与含BOM字节hash直接混比。
- read_file_partial分别使用chars与lines；字符分页严格沿用nextOffset，不切断emoji。行页沿用nextLine；它可能是候选续读行，下一次LINE_OUT_OF_RANGE不应误判为内容丢失。

### N06：真实文件占用与失败状态（条件必做）

在独立样本上用Windows允许的只读独占句柄（FileShare.None）保持占用，再执行一次write_file或move_path。记录实际EACCES/EBUSY等系统错误、耗时与文件状态，释放句柄后再次只读核对基线。

不同驱动可能允许rename或以不同方式处理共享模式，不能硬编码只有一个错误码。若操作成功，应核对成功结果和源/目标；若失败，应核对保全。不能把“创建独占句柄失败”冒充工具处理占用正确。

如果故障只发生在首次读取阶段，只能证明读取失败处理，不能声称验证了“提交后回滚”。提交后故障没有自然触发则在报告中填NOT_RUN，不注入fs故障冒充真机回滚。

### N07：父目录变化、辅助残留（可触发时必记录）

如果真实环境下对`cases/new-parent/child/file.scss`写入在父目录创建后失败，核对changed=true、createdDirectories与实际新增目录一致。不要手工破坏profile、关闭读取器或改权限专门制造这个分支。

观察到清理失败时，应同时保留原始主错误和cleanupErrors；若主操作成功，则核对已完成内容，只记录告警，不重复追加。未自然触发的复合错误写NOT_RUN，仓库注入测试可作为补充证据但不能代替真实事件。若只成功创建了目录及文件，只能将“成功创建目录”记PASS，“父目录已创建后写入失败”仍为NOT_RUN。

### N08：并发与取消隔离（具备SDK/多实例能力时必做）

1. **无版本前置条件的并发追加：**两个真实MCP实例共享本次profile，同时向同一个P文件追加不同短标记。两个请求均省略expectedHash；正常完成时每个标记恰好出现一次，原文不丢。记录两个响应，并在全部完成后再独立读取最终hash和完整内容，不能只引用第二个写入响应自证。
2. **有版本前置条件的并发冲突：**另起全新样本，两个请求都携带同一个初始expectedHash。预期一个成功、另一个CONFLICT；文件只含成功请求的标记，不能要求两次都成功。这是冲突保护正向用例，不是并发丢失缺陷。
3. 通过实际SDK取消一个排队中的计算请求，确认另一个独立请求不被连带CANCELLED。运行中的耗时正则可用有限样本`a`重复40次后加`!`、模式`^(a+)+$`，仅使用dryRun并设置受支持的timeoutMs，不写盘。
4. 用tools/list或check_status记录耗时任务期间的响应性；任务超时/取消后再做普通读取/小编辑，服务应继续可用。不要靠杀死整个MCP进程模拟单请求取消。

所用SDK 1.31.0支持请求级AbortSignal：client.callTool(params, undefined, { signal: controller.signal, timeout: 60000 })，取消时调用controller.abort()。先挂好catch/记录拒绝，避免未处理Promise拒绝。客户端取消可能表现为Promise拒绝而非工具返回CANCELLED，应保存实际客户端异常与后续其他请求结果。

排队取消使用不同文件，避免其实是在同一文件锁上等待。先启动有界的慢正则dryRun，再启动待取消和应存活的两个独立计算请求；在慢请求运行期间取消第二个。记录请求时间线以证明入队/取消关系。另测运行请求取消、自然超时后继续使用。只取消本次测试请求，不杀整个服务。

若无法建立真实并发/取消时间线，记录BLOCKED并明确“客户端限制”还是“测试脚本尚未实现”；不能因为没有编写调用就声称SDK不支持。不要直接调用lib/regex冒充协议测试。

### N09：范围、删除与只读配置（必做）

- create_directory只创建本次cases下的子目录。对该子目录remove_path先dryRun=true，应未删除；再仅删除其专用样本，核对实际移除和changed。
- 对cases工作根做remove_path并设dryRun=true，应PROTECTED_ROOT。测试时不对盘符根发实际删除请求。
- 在run下、cases之外准备无敏感内容的专用哨兵文件。调用read_file应PATH_OUTSIDE_ROOTS；不要拿真实私人文件测试越界。
- 启动另一个隔离实例设MCP_READ_ONLY=1，读取应成功、write_file应READ_ONLY；dryRun预览可用，但锁目录可能发生内部写入，不把“目标未改”解释为整个机器绝对零写入。
- 另一个隔离实例设MCP_DISABLE_DELETE=1，remove_path应DELETE_DISABLED。该配置只禁remove_path，不能推断move_path也被禁用。

结束这些临时实例后恢复主测试实例的预期配置，报告每个实例的PID/环境。

## 7. 可选扩展与自动化对照

### X01：跨卷

只有存在已获准的第二个独立测试根时执行。记录源/目标的卷标、文件系统和加密策略，区分不同卷与不同物理磁盘；两个盘符可能只是同一卷的别名。

在两方向对P/E工作副本执行C08的复制/移动，核对目标内容、状态、编辑器与源保留。没有第二卷则NOT_RUN，不能用同卷两个目录冒充跨卷通过。

### X02：历史现场样本

如有原始27字节SCSS或“无锁密文”复现条件，用全新副本重复auto、plaintext、preserve三个独立分支。记录**第一次**操作前后字节数/hash/前缀/编辑器显示/锁图标，优先保留能重现旧故障的证据。不能复现就明确写未复现，不推断已解决该特定现象。

### X03：仓库自动化

若待测完整源码含test目录和既有依赖，可在独立测试根/profile中运行 `npm run check` 和 `npm test`，保存日志及退出码。当前2.1.3 CI修订完整套件在Windows预期140项（包括Windows子测试），21个JS/CJS语法检查；此前未补强测试的2.1.2为130项，不能混同。

自动化使用模拟视图和故障注入的部分必须标明“模拟回归”。实际Windows适配器、stdio和文件占用结果另列。自动化140项通过**不代替C02/C03的真实驱动与编辑器观察**。沙箱限制导致失败时记录环境原因，不改断言、跳过用例或静默切换运行权限。

本次不要求真实创建一万项/129层目录；相关预算已有模型回归，若另做实体压力测试应单独申请并限定资源。

### X04：断电/强杀

默认NOT_RUN。本实现不承诺任意断电后自动恢复。不要为此次验收强杀用户编辑器、驱动或生产服务，也不要断电。若以后专门授权隔离崩溃试验，应另定时间点、备份和恢复判据。

## 8. 报告与证据交付

### 8.1 交付文件

至少生成：

```text
report.md                       # 按下方模板填写
evidence/environment.json        # 版本、实例配置、驱动/编辑器信息，已脱敏
evidence/build-hashes.json       # 实际源码hash与匹配结果
evidence/fixtures.json           # 每个样本的建样方法、P/E依据、编辑前编辑器观察、期望字节/hash
evidence/calls.jsonl             # 每次实际MCP请求、完整响应、耗时、用例ID
evidence/observations.jsonl      # operationId、pre/post-0s/2s/10s、Node/外部/编辑器观察
evidence/observer-sources/       # 本次观察器/测试驱动脚本及其hash，便于复核读取方法
evidence/screenshots/           # 如能获得，只截测试文件，排除业务信息
```

保存执行脚本和外部读取器脚本本身，以便复核其是否用同一句柄计算完整字节hash、是否保留首次失败和是否使用正确参数。脚本中的非必要环境信息脱敏。初始化响应、进程启动/正常退出记录也纳入证据。

用例ID必须同时出现在report、calls和observations中。派生子用例使用`C02-scss-P`、`C08-move-E-to-P`等唯一ID。UTF8保存JSON/Markdown；日志不能只有终端截图。外部进程观察失败也保存错误与退出码。

报告和补充观察全部完成后，再生成证据文件hash清单（含report和所有分阶段原始文件；清单自身除外）。清单须覆盖测试驱动脚本、截图以及完整日志，核对聚合记录与分阶段记录一致。追加用户观察后，同步更新report和environment中的观察状态，不留下“已观察/未观察”矛盾；保留原始记录，不覆盖时间线。报告先交给用户，由用户转回开发端；不自行发送邮件、上传云盘或联系其他Agent。

交付前确认用户能打开report.md和JSON证据。若报告本身也受到加密策略约束，只能采用现场允许的导出/共享方式，记录可读性和实际位置；不能私自解密或更改策略。源码指纹、样本预期hash和每次调用证据均需保留，不仅交付摘要。

保留失败样本、恢复备份及其所在原路径直到复核完成。复制到归档目录可能改变加密状态，副本只能作附加证据，不能替代原路径现场；如复制，记录方法并重新核对Node/外部视图。不要仅为“清理目录”删除唯一失败证据。

正常关闭本次启动的测试实例，记录状态。成功样本只有在报告及证据完整后才按现场约束清理；本轮默认可先保留，清楚列出路径/用途。仅凭`.mcp-`或临时目录名不能批量删除。

### 8.2 report.md模板

复制以下模板并填写真实结果；没有观察的字段写“未观察/未返回”，不得用预期值填充实际值。

```markdown
# MCP 2.1.3 真实加密电脑验收报告

## 结论
- 测试批次/日期/时区：
- 总体状态：PASS / FAIL / BLOCKED / 部分完成
- 可确认通过的范围：
- 不能确认的范围及原因：
- 首要失败用例：
- 是否出现内容损坏、意外明文化、源文件误删、编辑器不可读：
- 是否修改源码/版本/依赖/全局策略：否；如有偏离，列出具体内容

## 环境与代码身份
- OS / Node / Node绝对路径 / npm：
- 客户端 / 驱动 / 目标编辑器版本：
- 实际index.js路径、PID、启动参数：
- initialize版本 / check_status版本 / 工具数量：
- 源码指纹匹配：12/12或差异列表；证据路径：
- cases / profile / 证据根目录：
- MCP_BASE_DIR / MCP_ALLOWED_ROOTS / READ_ONLY / DISABLE_DELETE：
- 实际加密覆盖范围与确认依据：
- 外部读取器路径/版本，能否区分已知受保护E：
- 是否具备编辑器重新加载证据：

## 样本基线
| 样本ID | 路径 | 创建方法/进程 | 后缀 | P/E/未知及依据 | 期望hash/字节 | Node hash/字节 | 外部hash/字节/前缀 | 编辑器修改前状态 | 证据 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |

## 用例汇总
| 用例ID/尝试序号 | 实际执行 | overallResult | contentResult | stateResult | editorResult | 期望与实际摘要 | 数据保全 | 耗时 | 证据路径 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |

## 关键写入三视图
| 用例ID/operationId/时间点 | 期望hash/字节 | Node hash/字节 | 外部hash/字节/前缀/进程 | 编辑器重新加载时间及结果 | 锁图标 | 与基线状态是否一致 |
| --- | --- | --- | --- | --- | --- | --- |

## 失败与阻塞详情（每项单独记录）
### 用例ID
- 前置样本、路径和状态：
- 完整请求参数：
- 原始响应文件：
- ok/code/changed：
- strategy / diskState / diskVerified / contentVerified / protectionObserved / via：
- warnings / reasons / matched / createdDirectories / cleanupErrors：
- partial / sourceRetained / removedSourceCount / recoveryPath / rollbackError：
- 失败前后可信预期、Node与外部hash：
- 编辑器修改前、修改后及未编辑对照的真实观察：
- 能否区分建样就不可读与修改后才不可读：
- 源/目标/备份/锁当前状态：
- 首次失败与复测结果分别说明：
- 初步判断：产品缺陷 / 环境限制 / 证据不足；依据：
- 提交开发端复核的问题：

## 自动化及可选项
- 仓库测试：命令/退出码/数量/通过失败跳过/日志位置：
- 哪些为模拟测试，哪些为真实进程/文件测试：
- 跨卷：实际卷信息与结果，或NOT_RUN原因：
- 历史27字节样本：可用性及结果：
- 提交后回滚/复合清理故障：实际触发还是未触发：
- 断电/强杀：默认NOT_RUN：

## 文件与清理
- 最终报告及证据清单/hash清单：
- 保留的失败样本、备份、锁及原路径/原因：
- 已删除的本次成功样本/临时辅助文件：
- 本次启动实例是否均正常关闭：
- 是否存在待用户处理事项：
```

### 8.3 总体通过门槛

只有代码身份匹配、ENV前置条件成立、C01—C10核心场景有实际证据且通过，并完成必做N项，才能给出“本机、本驱动、本目录策略与该编辑器组合下核心验收通过”。条件用例若受限，应限定结论而不是写“所有场景通过”。

缺少E样本或可区分的外部视图、没有编辑器实测、核心正向操作仅安全失败，均不能给出完整通过结论。跨卷、自然故障分支和强杀未执行时，不阻止对已测核心范围作限定结论，但必须列明未覆盖范围。

执行完成后，在聊天中给用户：总体状态、通过/失败/阻塞/未执行数量、前三个需要复核的问题，以及report.md和证据目录的实际路径。开发端将基于原始证据复核，不以执行Agent的一句“全部通过”作为最终确认。
