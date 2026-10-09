# 2026-10-08 审查修复与验收报告

本次在 `D:\Projects\mcp-read-file-server` 完成上轮六项缺陷修复，以及取消隔离、诊断字段两项优化。基线为 `1f90798`，按用户后续要求将包版本升至2.1.1；修改尚未提交或发布。下述120项完整测试在版本标识仍为2.1.0时完成，升版仅同步版本元数据和文档，未改变功能实现。

## 修复与专项覆盖

| 分组 | 实现及验收内容 | 测试数 |
| --- | --- | ---: |
| A1 父目录状态 | 策略失败、暂存失败、部分mkdir失败均正确报告changed/createdDirectories；保留其他操作加入的内容 | 3 |
| A2 清理诊断 | 外部复制、原子配置、手工策略、目录探测、初始探测、安全中转的主错误与清理错误分别保留；成功提交附告警 | 7 |
| A3 正则预算 | worker内限制UTF8结果大小；超限不写盘；392组原生replace语义对照，另测多位捕获组、前后文扩张和16MB代理对边界 | 4 |
| A4 字面量搜索 | 4096字符元字符输入可匹配，非法正则仍拒绝 | 1 |
| A5 目录预算 | 复制/移动统计已有目录；一万项、128层边界及越界；实际目录合并、空目录保留与移动 | 6 |
| A6 glob | 空分支、重复/嵌套空分支、同步/异步语义对照 | 1 |
| A7 任务隔离 | 排队取消、排队超时、运行取消、运行超时、16项队列及全局stop后恢复 | 3 |
| A8 协议诊断 | reasons/matched传递；真实stdio下的长literal、glob、超限和后续心跳 | 2 |
| 合计 | `audit-fixes.test.js` | 27 |

目录极限测试采用受控的只读虚拟目录模型，复用实际遍历/路径检查/锁/预算逻辑，未创建一万多个实体目录；实际文件操作另有独立样本验证。故障注入只作用于当前夹具路径，每项测试后恢复fs方法。

## 最终验证

环境：Windows，Node.js v24.18.0，npm 12.0.2。

后续2.1.1升版验证：20文件语法/LF检查通过；package.json与package-lock.json的两个根版本字段一致；真实stdio初始化和check_status均返回2.1.1，18个工具正常注册；git diff --check通过。功能实现未变，本轮没有重复执行完整120项回归。

| 验证项 | 结果 |
| --- | --- |
| `npm test` | 120通过，0失败，0取消，0跳过；约12.62秒，包含原93项和新增27项 |
| 原生替换语义矩阵 | 4种文本 × 7种模式 × 7种替换字符串 × 单次/全部 = 392组，全部一致 |
| `npm run check` | 20个JS/CJS文件语法与LF检查通过 |
| `git diff --check` | 无空白错误；README仅提示本机Git换行转换策略 |
| `npm audit --omit=dev --json` | 0漏洞 |
| `npm ls --all --json` | 退出码0，无缺失或无效依赖 |
| `npm pack --dry-run --json` | 14个发布文件，包含全部9个lib模块，不含test、node_modules和临时文件；没有生成或发布压缩包 |
| Windows真实外部复制器 | PowerShell、cmd、robocopy、cscript均通过特殊路径与二进制内容测试 |
| 真实协议/并发/文件占用 | stdio、跨进程锁、Windows文件占用、junction根保护等现有回归全部通过 |

最初沙箱执行出现cscript失败和两项junction权限错误（合计4个失败计数，包含父测试）。经授权在沙箱外、相同项目隔离样本路径复核后全部通过；没有跳过测试或削弱断言。依赖升级后重新运行最终全套测试并得到上述120/120结果。

## 依赖安全修复

联网审计最初发现5个受公告影响的包。按同一主版本的修复范围更新，Zod和其他依赖不变。

| 依赖 | 原版本 | 最终锁定版本 | 公告 |
| --- | --- | --- | --- |
| @modelcontextprotocol/sdk | 1.30.0 | 1.31.0 | [OAuth凭据绑定](https://github.com/advisories/GHSA-6qxp-vccf-f47h) |
| fast-uri | 3.1.7 | 3.1.8 | [主机名大小写归一](https://github.com/advisories/GHSA-hrr3-gc8f-f4qj) |
| hono | 4.13.5 | 4.13.7 | [JSX字符串转义](https://github.com/advisories/GHSA-hxh3-vqpv-xpqv) |
| ip-address | 10.5.0 | 10.7.3 | [地址族边界](https://github.com/advisories/GHSA-j6r3-76f7-8jcv) |
| proxy-addr | 2.0.7 | 2.0.8 | [代理信任子网](https://github.com/advisories/GHSA-jqcg-44mw-7w3h) |

SDK公告明确排除MCP服务端及stdio客户端；当前项目入口也没有启用HTTP/OAuth或JSX服务。本次消除依赖审计告警，不据此声称这些网络攻击路径已能直接攻击当前stdio服务。

没有新增技能、工具或测试框架。上述五个包保留在项目 `node_modules/` 的各自目录，其README.md均追加用途、版本、安装日期、关联任务和使用/卸载说明。说明不随包发布，重新安装依赖可能覆盖本地补充记录。

## 复现命令与隔离要求

在项目根目录运行以下命令。完整Windows验收需要能够启动cscript和创建junction。

```powershell
$taskTemp = Join-Path (Get-Location) '.agent-tmp\audit-20261008'
New-Item -ItemType Directory -Force -Path "$taskTemp\tests", "$taskTemp\profile", "$taskTemp\temp", "$taskTemp\npm-cache" | Out-Null
$env:MCP_TEST_ROOT = "$taskTemp\tests"
$env:MCP_PROFILE_DIR = "$taskTemp\profile"
$env:TEMP = "$taskTemp\temp"
$env:TMP = "$taskTemp\temp"
$env:npm_config_cache = "$taskTemp\npm-cache"
npm run check
npm test
npm audit --omit=dev
npm ls --all
npm pack --dry-run --json
```

以上环境变量只修改当前PowerShell会话。自动化夹具会清理样本；缓存和日志应在验证结束、确认路径属于本次任务后清理。

## 验证范围及手动验收

本次没有实际运行Linux或Node20/22；现有CI矩阵仍覆盖这些组合，但没有提交/推送以触发新一轮CI。

真实TSD驱动、不同物理卷、断电/强杀恢复尚未现场验证。模拟受保护视图的测试全部通过，但不代表真实驱动兼容性已经通过。

1. 应用本地修复时，让MCP客户端启动 `node D:\Projects\mcp-read-file-server\index.js`，再重启该MCP服务；使用已发布npm包的配置不会自动加载本地改动。
2. 在真实加密电脑准备可丢弃的原明文、原受保护文件副本，分别执行auto覆盖、追加、编辑、复制和移动；核对可信原文/hash、外部读取视图、目标编辑器可读性及失败后的源文件。不要使用唯一原件。
3. 需要验证实际跨盘或强杀恢复时，在隔离源/目标上记录路径与预期hash。异常后先保留并比较目标、`.mcp-backup-*`、`.mcp-stage-*`及锁PID，不直接批量删除；当前实现仍是异常回滚，不保证任意断电自动恢复。

## 文件管理

源码、测试、计划、本报告及项目记忆保留在原项目目录。临时样本、TAP日志、审计原始输出、npm下载缓存和临时profile位于 `.agent-tmp/audit-20261008/`，其测试结果已汇总于本报告，收尾时删除。原有 `smithery.yaml`、`test/write-policy-plan.md` 保留。依赖保留在默认项目安装位置。
