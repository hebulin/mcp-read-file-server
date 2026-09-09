# 回归测试

用途：MCP 1.9.0回归、真实stdio和Windows适配器验收源码。创建日期2026-09-08，关联全面审查修复任务。

仅使用Node内置test runner和项目已有MCP SDK，不安装测试框架。设置MCP_TEST_ROOT到专用D盘测试目录后执行npm test。helper.cjs为每个测试创建独立profile/文件样本，并在结束时先关闭子进程，再校验路径和删除样本。

regression.test.js执行原审查正确行为断言及注入故障验证；protocol.test.js使用真实SDK/stdio；adapters.test.js在Windows上测试实际外部复制进程。其他系统跳过Windows专用用例，此跳过不代表Windows通过。

测试文件属于仓库，不随npm运行包发布。无需卸载依赖；不要删除测试以使CI通过。真实TSD、断电及实际跨盘仍需专门环境验收。

2026-09-09 / 1.9.1：新增review-fixes.test.js，覆盖目录双向重叠、安装前/后回滚失败、部分删源状态、行分页预算边界及范围外长行；沿用Node内置test runner，执行npm test即可，无新增测试依赖。所有故障注入仅作用于独立测试样本。
