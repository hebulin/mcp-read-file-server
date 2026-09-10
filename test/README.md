# 回归测试

用途：MCP 1.9.0回归、真实stdio和Windows适配器验收源码。创建日期2026-09-08，关联全面审查修复任务。

仅使用Node内置test runner和项目已有MCP SDK，不安装测试框架。设置MCP_TEST_ROOT到专用D盘测试目录后执行npm test。helper.cjs为每个测试创建独立profile/文件样本，并在结束时先关闭子进程，再校验路径和删除样本。

regression.test.js执行原审查正确行为断言及注入故障验证；protocol.test.js使用真实SDK/stdio；adapters.test.js在Windows上测试实际外部复制进程。其他系统跳过Windows专用用例，此跳过不代表Windows通过。

测试文件属于仓库，不随npm运行包发布。无需卸载依赖；不要删除测试以使CI通过。真实TSD、断电及实际跨盘仍需专门环境验收。

2026-09-09 / 1.9.1：新增review-fixes.test.js，覆盖目录双向重叠、安装前/后回滚失败、部分删源状态、行分页预算边界及范围外长行；沿用Node内置test runner，执行npm test即可，无新增测试依赖。所有故障注入仅作用于独立测试样本。

2026-09-09 / 1.9.2：新增resilience.test.js，覆盖跨实例/跨进程目录与子项锁、无关路径并行、复合清理故障、递归删除的部分失败/取消、Windows真实占用、字面量输出预算与真实stdio心跳。仍使用已有Node/SDK，无新增依赖；运行npm test，测试源随仓库保留，无单独卸载步骤。

2026-09-10 / 1.9.3：新增followup-fixes.test.js，覆盖真实目录别名的工作根保护、空目录移动失败计数、探测与移动互斥、失败后的历史清理诊断，以及glob累计预算/取消/语义和真实stdio心跳。使用现有Node测试运行器，执行npm test，样本隔离到MCP_TEST_ROOT并自动清理；没有新依赖或安装工具。
