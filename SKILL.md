---
name: encryption-file-ops
description: 在文件加密软件（天锐绿盾 / IP-Guard / 亿赛通 / 深信服等）环境下，使用 mcp__read-file-server__* 工具替代 AI Agent 内置 Read/Write/Edit/Grep 工具读写明文。当内置工具返回密文/乱码，或用户提到"加密、绿盾、密文、白名单、读不到文件"等关键词时激活。
---

# 加密环境文件操作 Skill

> **本 Skill 负责"教策略"，MCP Server 负责"执行"。**
> 本 Skill 不替代任何 MCP 工具，仅提供使用指引。

## 一、适用场景

### 触发条件（满足任一即激活）
- 内置 `Read/Write/Edit/Grep` 工具返回密文、十六进制乱码、`%TSD-Header-###%` 文件头
- 用户提到关键词：天锐、绿盾、TSD、IP-Guard、亿赛通、深信服、加密软件、白名单、密文、解密失败
- 项目文件头出现 `%TSD-Header-###%` 等加密标识

### 前置条件
- Node.js 进程已被加密软件列为**白名单（受信任进程）**
- `mcp-read-file-server` MCP Server 已配置（见项目 `README.md`）
- 在 `claude mcp list` 中能看到 `read-file-server`

---

## 二、工具映射表

| 场景 | 内置工具（禁用） | MCP 工具（用这个） |
|------|------------------|---------------------|
| 读单个文件 | `Read` | `mcp__read-file-server__read_file` |
| 读 ≥2 个文件 | 多次 `Read` | `mcp__read-file-server__read_files` |
| 写文件 | `Write` | `mcp__read-file-server__write_file` |
| 精确编辑 | `Edit` / `MultiEdit` | `mcp__read-file-server__edit_file` |
| 搜索内容 | `Grep` | `mcp__read-file-server__search_files` |
| 创建目录 | （无） | `mcp__read-file-server__create_directory` |
| 查文件信息 | （无） | `mcp__read-file-server__file_info` |
| 健康检查 | （无） | `mcp__read-file-server__check_status` |

> **强约束**：在加密环境下，**禁止使用** `Read/Write/Edit/MultiEdit/Grep` 内置工具——它们会读到密文或破坏加密结构。

---

## 三、决策树

```
需要读文件
  ├─ 单个 → mcp__read-file-server__read_file
  └─ 多个（≥2）→ mcp__read-file-server__read_files（批量更高效）

需要修改文件
  ├─ 已读过 → 直接 mcp__read-file-server__edit_file
  └─ 未读过 → 先 read_file 拿到明文 → 再 edit_file

需要新建/覆盖文件
  └─ mcp__read-file-server__write_file

需要搜索内容
  └─ mcp__read-file-server__search_files
      ├─ 限定文件类型 → 用 include（如 "*.java,*.xml"）
      └─ 控制返回数量 → 用 maxResults

需要创建目录
  └─ mcp__read-file-server__create_directory

需要判断文件是否存在 / 查大小
  └─ mcp__read-file-server__file_info

工具异常 / 不确定是否生效
  └─ mcp__read-file-server__check_status
```

---

## 四、典型工作流

### 流程 1：读取并修改文件
```
1. mcp__read-file-server__read_file 读取明文
2. 分析内容
3. mcp__read-file-server__edit_file 修改
   - oldString 必须从第 1 步读到的内容里**原样复制**（含空格、缩进、换行）
4. 必要时再 read_file 验证修改结果
```

### 流程 2：批量读多个相关文件
```
1. mcp__read-file-server__read_files
   - paths 参数用英文逗号分隔，如 "D:/proj/A.java,D:/proj/B.java"
2. 统一分析（输出会带"========== 文件: xxx =========="分隔）
```

### 流程 3：在项目中搜索特定代码
```
1. mcp__read-file-server__search_files
   - pattern: 正则表达式（如 "function\s+\w+"、"@GetMapping"）
   - path: 搜索根目录
   - include: 文件名过滤（可选）
2. 根据返回的 file:line 定位，用 read_file 读取具体文件
```

### 流程 4：从零创建新模块
```
1. mcp__read-file-server__create_directory 建包目录
2. mcp__read-file-server__write_file 逐个创建文件
3. read_file 验证（可选）
```

---

## 五、`edit_file` 关键参数详解

| 参数 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| `path` | string | ✅ | - | 文件绝对路径 |
| `oldString` | string | ✅ | - | 要替换的原内容，必须**精确匹配** |
| `newString` | string | ✅ | - | 替换后的新内容 |
| `useRegex` | boolean | ❌ | false | true 时 oldString 当正则，可用 `$1 $2` 引用捕获组 |
| `replaceAll` | boolean | ❌ | false | true 时替换所有匹配项；false 时仅替换第一处 |
| `ignoreCase` | boolean | ❌ | false | 是否忽略大小写（仅字符串模式生效） |

### 常见用法
- **单点替换**：`useRegex=false, replaceAll=false`（默认）
- **批量替换**：`useRegex=true, replaceAll=true`（如改命名）
- **正则提取后重组**：`useRegex=true, newString` 里用 `$1` `$2`

---

## 六、注意事项

1. **路径**：用**绝对路径**最稳（如 `D:/AiJiamiToolsPlugins/...`），相对路径以 MCP Server 启动目录为基准
2. **`edit_file` 前必读**：必须先 `read_file` 拿到明文，再从原文里**原样复制** `oldString`，否则会因为空格/缩进不匹配而失败
3. **不要在 `oldString` 里漏换行**：多行替换时，行末换行符也要复制完整
4. **`write_file` 是覆盖写**：会清空原文件再写入，重要文件修改前建议先 `read_file` 备份内容
5. **`search_files` 自动跳过**：`node_modules`、`.git`、`target`、`build`、`dist`、`.idea`、`.vscode`
6. **大批量搜索**：用 `maxResults` 控制返回数量，避免一次性返回过多结果
7. **工具调用顺序**：复杂任务先 `check_status` 确认 MCP 正常，再正式操作

---

## 七、故障排查

| 现象 | 可能原因 | 解决方案 |
|------|----------|----------|
| 读到的还是密文/乱码 | Node.js 不在加密软件白名单 | 联系管理员把 `node.exe` 加入白名单 |
| `mcp__read-file-server__*` 工具全部不可见 | MCP Server 未配置或未启动 | 见 `README.md` 配置 `.mcp.json` |
| `edit_file` 报"未找到匹配内容" | `oldString` 拼写、缩进、换行不对 | 重新 `read_file` 复制原文，**不要凭记忆写** |
| `edit_file` 报"匹配到 N 处" | 文件中存在重复内容 | 加更长/更唯一的 `oldString` 唯一定位，或 `replaceAll=true` |
| `search_files` 报"正则表达式无效" | 正则语法错误 | 检查 `pattern` 是否需要转义特殊字符 |
| `write_file` 报权限错误 | 文件被占用或目录无写权限 | 关闭占用进程 / 检查目录权限 |
| 工具调用超时 | 文件过大 | 改用 `search_files` 定位后只 `read_file` 关键段 |

---

## 八、与其他工具的关系

| 工具类型 | 在加密环境下 | 备注 |
|----------|--------------|------|
| 内置 `Read/Write/Edit/Grep` | ❌ 禁用 | 会读到密文或破坏加密 |
| 内置 `Bash` | ⚠️ 慎用 | Bash 进程通常不在白名单，`cat`/`sed` 也会读到密文 |
| 内置 `Glob` | ✅ 可用 | 只列文件名，不读内容 |
| 内置 `NotebookEdit` | ⚠️ 慎用 | 同 Edit |
| `mcp__read-file-server__*` | ✅ 主用 | 本 Skill 推广的工具集 |
| `TaskCreate` / `TaskList` | ✅ 可用 | 任务管理，不涉及文件内容 |
| `WebFetch` / `WebSearch` | ✅ 可用 | 网络工具，与本地加密无关 |

> **Bash 特别注意**：在加密环境下，`Bash` 工具的 `cat`/`sed`/`grep` 也会读到密文。如需在终端操作文件，应使用 `node -e` 走 Node.js 白名单进程。
