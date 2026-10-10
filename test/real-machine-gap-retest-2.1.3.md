# MCP 2.1.3 真机补测任务单

日期：2026-10-10。请将本文件交给加密电脑中的Agent。它针对上一轮报告的漏测/误判，不要求重新运行所有已经取得可靠证据的用例。完整工具验收仍以同目录的real-machine-test-guide-2.1.3.md为准。

## 一、不可改变的产品规则

默认auto且无人工覆盖：**原加密保持加密、原明文保持明文、新建默认明文**。规则按每个文件当次的状态执行，不能按.scss、.java或未来的新后缀猜测。复制/移动新目标继承源状态，覆盖已有目标参考目标原状态。

显式plaintext/preserve与人工mark_extension属于有意覆盖，只能在指定隔离用例中调用，不能用来掩盖auto失败。禁止因编辑器乱码把原受保护文件自动明文化。

本次待测服务版本为2.1.3。默认写入状态规则不变，完整指南的源码指纹已同步2026-10-10 CI修订；上一轮135项回归加上5项适配器预算/诊断回归，当前Windows全套140项通过。先确认initialize/check_status均为2.1.3，再按需要补测G1—G5，不将旧服务进程的结果当作新版结果。

## 二、工作方式

- 保留上次报告/证据及原样本，新建唯一run目录，例如 `D:\AgentWorkFiles\ResultFiles\20261009-MCP2.1.3真机补测\run-<唯一ID>`，禁止覆盖旧run。
- cases必须在真实加密策略生效的目录；profile和evidence独立且在待复制/移动树之外。BASE_DIR/ALLOWED_ROOTS只指向本次cases。并发实例共享本次profile，不使用用户默认profile。
- 只测试，不改源码、版本、加密白名单、编辑器全局配置、全局npm链接或生产MCP启动配置。直接启动用户提供的源码index.js；不要再用安装全局包代替隔离测试。
- 不删失败样本或恢复备份。测试使用人工内容，禁止接触业务原件；不要关闭安全软件或注入fs/加密适配器伪装成真机结果。
- 每个用例分别记录contentResult、stateResult、editorResult、overallResult。核心文件用例缺编辑器证据时overallResult必须BLOCKED，不能写PASS(editor BLOCKED)。纯策略/协议用例的编辑器字段可为NOT_RUN。
- 样本/进程命名、脚本、所有调用和观察时间线一起交付，不能只给脚本自己打印的PASS。原始调用同时记录服务PID、caseId、operationId、时间与完整响应。

## 三、固定内容

下列JSON字符串先解码为内容，再编码为UTF8。标记2_1_1是沿用的样本名，不是服务版本。

```json
{
  "S0": "\uFEFF/* MCP_REAL_2_1_1 中文😀 */\r\n$color: #123456;\r\n.title { color: $color; }\r\n",
  "S1": "\uFEFF/* MCP_REAL_2_1_1 中文😀 */\r\n$color: #654321;\r\n.title { color: $color; }\r\n"
}
```

S0：81字节，SHA-256=`537e68e3d17945b1b952f69f62bfc54fb10489dc4402e46d7ad016b14a534e86`。

S1：81字节，SHA-256=`1325a26dc9481aae2813de5b3888811529ae369939e7b68cad62f7608fc160f8`。

Node视图用file_info或受信任Node完整字节读取；外部视图用已证明能区分E/P的正常外部进程，完整SHA-256、字节数和前16字节来自同一个句柄。一次读取失败不能因hash不等于明文就当作“仍加密”。

关键写入需要同一operationId下的pre、post-0s、post-2s、post-10s，以及编辑器重新加载观察；0/2/10秒不得混用不同写入。不要保存编辑器缓冲区或启用自动格式化来修正实际结果。

## 四、五项定向补测

### G1：真正的原明文.scss再次auto编辑

上轮C06已经成功生成了可读的明文.scss，因此不能只因Node直接创建会加密就跳过这个场景。

1. 在本次独立路径`g1-plain.scss`用现场批准的流程准备S0。可使用一个明确标为SETUP的write_file新建请求，不能把setup成功当作本用例通过。
2. 独立核对Node=S0、外部=S0、均81字节，并由用户/编辑器重新加载确认可读。没有这些基线就BLOCKED，不继续宣称原明文编辑已测。
3. 调用edit_file：path为该文件、oldString=`#123456`、newString=`#654321`、expectedMatches=1、expectedHash=S0_HASH、writePolicy=auto、timeoutMs=60000。
4. 核对响应strategy.originalState=plaintext、basis=target、diskState=plaintext、diskVerified=true；Node和外部在各时间点均为S1/81字节；编辑器重新加载S1正常。
5. 保存相同后缀的E样本与本P样本的独立状态记录，不能用扩展名探测结果代替它们。可增加一个新后缀工作样本复用同一流程。

### G2：可读E基线与未修改对照

上轮证据说明“未经MCP修改的.scss对照也乱码”。它不能证明某个已编辑文件在编辑之前可读，也不能证明生产代码存在新的破坏行为。

1. 用现场正常工作流程生成两份受保护.scss：`g2-control.scss`与`g2-edit.scss`。每份均为S0，Node读S0、外部成功读取到不同的受保护视图。
2. **先**在目标编辑器分别重新加载两份文件，保存操作前可读的时间/截图或用户确认。若任一初始就乱码，本用例立即记BLOCKED: EDITOR_BASELINE_INVALID；不要继续修改该文件来“验证”编辑器损坏。
3. 基线合格后，只对edit执行G1的auto编辑；control始终不改。核对edit的Node=S1、外部仍不同于S1且读取成功；control的Node仍S0。
4. 同时重新加载edit/control。edit应显示S1，control显示S0。分别记录锁图标，它不是加密认证。
5. 如果只能证明两份.scss初始都不可读，保留该建样/环境问题；可以用可读的.java做正向对照，但不能用.java通过替代.scss通过。

### G3：目录复制/移动逐文件校验

分别为copy_path和move_path准备全新目录树，不复用被移动/修改后的源。

| 源项 | 源内容与状态 | 最终目标操作前 | 目标预期 |
| --- | --- | --- | --- |
| `plain.same` | S1 / P | S0 / E | S1 / E，参考已有目标 |
| `protected.same` | S1 / E | S0 / P | S1 / P，参考已有目标 |
| `new-plain.futuretype` | S0 / P | 不存在 | S0 / P，继承源 |
| `中文 文件.futuretype` | S0 / E | 不存在 | S0 / E，继承源 |
| `empty/` | 空目录 | 不存在 | 空目录存在 |

样本后缀和状态必须以实际基线为准。若环境不保护futuretype，使用另一个未知/可受保护后缀并说明；不能伪造E。表中至少P/E混合树必须具备真实可读基线。

1. 在操作前保存`tree-before.json`，每项包含相对路径、完整预期字节/hash、Node/外部基线和编辑器结果。
2. 调用实际copy_path或move_path，auto、overwrite=true。目标若是已有目录，最终位置会再追加源basename，必须先明确最终路径。
3. **独立逐文件读取**目标的完整字节/hash、外部视图与状态，必要时重新加载编辑器。保存`tree-after.json`，逐项与表格预期比较；不能只检查exists或工具返回OK。
4. copy后重新核对源的内容和状态保持；move后核对所有目标正确再记录源不存在。核对空目录，不能用文件数替代内容验证。
5. 若某个新后缀E无法建立，仅该变体BLOCKED，其他已执行项分别报告；没有逐项证据就不能把整树content/state标PASS。

### G4：人工策略刷新和真正重启

只操作本次profile，先完成G1—G3，避免人工标注污染默认策略验证。

1. mark_extension(.scss, protected)，inspect(auto)应返回basis=override、mode=preserve。
2. inspect显式plaintext应返回basis=explicit、mode=plaintext；另一个inspect(auto)仍应命中人工protected，两者不能混淆。
3. 实际调用refresh_profile(timeoutMs=60000)，保留请求和完整响应，并核对protected标注仍存在。
4. 正常关闭该测试MCP实例，启动**新PID**，使用同一profile。不要重建、清空或重写缓存。保存两个PID及启动/退出记录，确认标注保持且读取了刷新后的缓存。
5. 改unsafe并确认auto为plaintext人工覆盖，再clear，关闭并再次重启；确认标注没有复活。对独立已有P/E样本的auto inspect应回到basis=target并分别反映原状态。
6. 结束前保持本次profile无人工覆盖。记录是否清除成功，不能处理用户默认profile。

### G5：有时间线证明的排队取消隔离

上轮`'a'.repeat(40)`可以直接匹配`^(a+)+$`，慢任务49ms已完成，取消发生在之后，因此没有测到排队。

1. 建立三个不同文件。slow内容必须为`'a'.repeat(40) + '!'`；另两个cancel/survive内容为`abc`。全部使用dryRun，避免取消测试实际改文件。
2. 先发一个正常小dryRun预热worker，再启动slow的edit_file（oldString=`^(a+)+$`、useRegex=true、newString=x、dryRun=true）。保存Promise是否已settled及起止时间。工具内部计算预算约1秒，不能把timeoutMs=60000误认为正则会运行60秒。
3. 在slow仍pending时启动cancel与survive两个不同文件的计算请求。等待短时间让请求进入服务，再次确认三个Promise都未结束；若slow已结束，判本次时序无效，用新尝试记录重测，不能判PASS。
4. 调用cancel请求的AbortController.abort()。SDK 1.31.0调用形式为 `client.callTool(params, undefined, { signal: controller.signal, timeout: 60000 })`。提前挂好catch，保存实际客户端拒绝。不能杀MCP进程模拟取消。
5. 取消后确认slow仍pending、survive未被连带拒绝，tools/list或check_status继续正常响应。随后取消slow，确认survive成功。记录取消时间点与慢任务实际结束时间，避免客户端本地取消被误当作线程隔离通过。
6. 读取三个文件的完整hash确认dryRun未写盘。另做自然超时后同一PID内继续读取/小dryRun的恢复对照。

可以直接参照新源码test/protocol.test.js中“现场补测N08”用例的时间线与断言，但现场调用必须仍走真实SDK/stdio，不能用lib/regex内部函数替代。

## 五、交付与判定

交付`report.md`、完整calls.jsonl、observations.jsonl、fixtures.json、tree-before/after、observer-sources、实际初始化/启动/关闭记录及最终manifest。每个辅助脚本保存源码和hash。用户补充编辑器观察后同步report/environment，最后再生成manifest。

每个子用例使用唯一caseId和尝试号。报告表至少包括：

| caseId/attempt | 实际执行 | contentResult | stateResult | editorResult | overallResult | 关键证据 | 缺失条件/原因 |
| --- | --- | --- | --- | --- | --- | --- | --- |

不得写死PASS。必须确认工具响应ok/code、实际完整内容、外部读取成功与状态，再分别计算各维度。原始错误和第一次失败保留；只有参数错误或基线失败时，标清“测试前提无效”，不要伪装成产品修复。

G1/G3涉及的编辑器维度未观察时，整体不得PASS。G2的初始E不可读时是基线BLOCKED，不是“已证明MCP把可读文件破坏”。G4缺刷新调用或新PID不算完成。G5慢任务已结束时不算排队取消通过。

无需为了这份补测重做C06已通过的19项换行场景，也不要求跨卷或强杀。失败样本与证据原路径保留至开发端复核，禁止把副本状态当成原路径状态。完成后将报告交给用户，由用户转回开发端；不要自行上传或发送给第三方。
