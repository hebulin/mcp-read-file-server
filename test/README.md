# 回归测试

用途：MCP回归、真实stdio和Windows适配器验收源码。创建日期2026-09-08；当前2.1.0验收关联通用文件写入状态修复任务。

仅使用Node内置test runner和项目已有MCP SDK，不安装测试框架。设置MCP_TEST_ROOT到专用D盘测试目录后执行npm test。helper.cjs为每个测试创建独立profile/文件样本，并在结束时先关闭子进程，再校验路径和删除样本。

regression.test.js执行原审查正确行为断言及注入故障验证；protocol.test.js使用真实SDK/stdio；adapters.test.js在Windows上测试实际外部复制进程。其他系统跳过Windows专用用例，此跳过不代表Windows通过。

测试文件属于仓库，不随npm运行包发布。无需卸载依赖；不要删除测试以使CI通过。真实TSD、断电及实际跨盘仍需专门环境验收。

2026-09-23 / 2.1.0：新增write-policy.test.js，覆盖所有类型共用的原文件状态决策、明文安全中转、受保护状态保留、新建/复制/移动、显式策略与人工覆盖、外部视图失败及最终校验回滚；protocol.test.js补充Windows无读取器时auto拒绝写入。计划见write-policy-plan.md。使用既有Node测试运行器，无新工具或依赖；执行npm test，测试样本放在MCP_TEST_ROOT且自动清理。本地完整验收需允许cscript等真实Windows子进程启动。

review-fixes.test.js覆盖目录双向重叠、安装前/后回滚失败、部分删源状态、行分页预算边界及范围外长行。resilience.test.js覆盖跨实例/跨进程路径锁、复合清理故障、递归删除部分失败、Windows真实占用、字面量预算与stdio心跳。followup-fixes.test.js覆盖工作根别名保护、移动计数、策略探测互斥、历史清理诊断，以及glob累计预算/取消。

本次验证：Windows / Node24.18.0，全套93测试通过（0失败/取消/跳过），19个JS/CJS文件语法与LF检查通过，npm audit --omit=dev为0漏洞，npm pack --dry-run确认2.1.0发布清单不含测试及临时文件。沙箱拒绝启动cscript时曾出现环境性失败，在允许启动该进程后完整复核通过。真实加密电脑上的2.1.0驱动兼容性仍需现场验收。
