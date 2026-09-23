---
name: encryption-file-ops
description: 在Node.js为加密软件白名单进程的环境中，使用文件操作MCP安全读取、编辑与校验文件；根据结构化结果处理明文、受控写入与失败恢复。
---

# 加密环境文件操作

使用前确认Node.js受信任，并配置read-file-server。版本2.1.0提供18个工具，最低Node20。

## 工具选择

- 读取：read_file、read_files；大文件使用read_file_partial和nextOffset/nextLine。
- 编辑：edit_file，多个修改用edits数组；先dryRun预览，需要时指定expectedHash和expectedMatches。
- 写入/追加：write_file；不要自行绕过错误改用普通shell覆盖。
- 搜索：search_files，普通文本优先mode=literal；include优先传数组。隐藏项用showHidden，构建目录用useDefaultIgnore=false。
- 文件名/目录：find_files、list_directory；信息与指纹：file_info。
- 复制/移动/删除：copy_path、move_path、remove_path；删除可先dryRun。
- 策略：inspect_write_strategy、encryption_profile、mark_extension、refresh_profile。

## 必须理解的结果

1. 优先读取structuredContent的ok、code、changed、data和warnings，不能只看人类文本。
2. isError=true时可能存在目录操作部分目标；查看changed/partial/sourceRetained。递归删除还需查看removedCount/partialTruncated/failedPath。单文件回滚失败时查看recoveryPath并保留备份。cleanupErrors只是清理诊断，成功修改后不得因清理告警重复追加。
3. contentVerified表示Node可见内容一致；diskVerified表示外部进程可见字节也与预期载荷一致，不是绕过透明解密读取原始磁盘。preserved不保证IDEA等其他程序能解密，unknown不能声称已验证明文。
4. check_status基础调用不探测环境。文件可读取也不能直接推断解密正常，可信expectedHash匹配才提供明确内容对照。
5. 文本工具只支持有效UTF8；UTF16、GBK、非法字节或NUL被拒绝时，必须先明确转换编码，不能强制按UTF8写回。

## 写入策略

- mark_extension(category=protected)永久记录保持受控写入，等价于默认使用preserve；unsafe要求验证磁盘明文；clear可清除两者。
- refresh_profile只更新自动观察，不删除手工策略。
- writePolicy=auto在没有人工覆盖时逐文件观察原状态：原明文保持明文校验，原受保护文件保持受控写入；新文件默认要求明文，不凭探测样本的protected分类自动加密。所有扩展名及无后缀文件使用同一规则。
- 复制/移动覆盖已有目标参考目标原状态；新目标参考源状态。目录逐文件判断，不能拿一个后缀的探测结果代替所有文件的基线。
- 显式writePolicy优先于人工标注；preserve只校验Node内容并告警，不保证原明文状态或编辑器可读。plaintext要求外部明文验证，失败中止或回滚。
- strategy.basis说明explicit/override/target/source/new_file/unverified；originalState记录auto观察到的基线，文件状态不缓存。user_unsafe也可能只是当次显式plaintext，不代表新增永久标注。
- Windows auto缺少外部读取器时返回DISK_UNVERIFIED；已配置读取器但本次读取失败也中止。PROTECTION_MISMATCH表示原受保护文件将意外变为明文；不得绕过错误继续写入。
- 旧v2人工unsafe和自动encrypted记录无法区分；升级后需要永久强制明文的后缀应重新标注unsafe。protected会迁移。
- 使用绝对路径；相对路径以MCP_BASE_DIR或服务启动目录为基准。

## 编辑约定

edits与oldString/newString/useRegex等单次字段互斥；批量ignoreCase可用。默认只改第一处，expectedMatches可要求唯一匹配。CRLF/LF/CR差异会适配，新文本跟随原行尾，未匹配区域保持不变；BOM自动保留。正则超过预算返回REGEX_TIMEOUT，改为更具体的模式或字面量，不重复发起同一灾难性正则。

## 预算与恢复

单页40万字符、完整文本修改16MB、搜索单文件5MB。字符offset使用UTF16单元，必须沿用nextOffset以免切开代理对。行分页不保证提前给出总行数。复制/移动目录逐文件验证，但不是跨文件事务；出现失败时根据partial处理。复制/移动遇到符号链接会明确拒绝，不自动跟随。

不要删除.mcp-backup-*、recoveryPath或正在运行进程的锁。进程异常退出后，先比对目标与备份，再恢复；不能承诺任意断电后自动恢复。测试必须使用独立MCP_PROFILE_DIR和MCP_TEST_ROOT，避免覆盖真实人工策略。开发验收执行npm run check、npm test、npm audit，真实TSD环境另用专门样本验证。
