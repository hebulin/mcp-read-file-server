/** MCP 工具适配层：保留工具名，统一参数预算与结构化结果。 */
const fs = require('node:fs/promises');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { z } = require('zod');
const pkg = require('../package.json');
const text = require('./text');
const { globMatcher, applyLiteral, escapeRegex } = require('./patterns');
const { runRegex } = require('./regex');
const { createEncryption } = require('./encryption');
const { createFiles, statMaybe } = require('./files');
const IGNORE = new Set(['node_modules', '.git', 'target', 'build', 'dist', '.idea', '.vscode', '.svn', 'bin', 'obj', 'out', 'vendor']);
const pathSchema = z.string().min(1).max(32768).describe('路径；相对路径以 MCP_BASE_DIR 或服务启动目录为基准');
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/i);
const timeoutSchema = z.number().int().min(100).max(60000).optional();
const policySchema = z.enum(['auto', 'preserve', 'plaintext']).optional();
const patternsSchema = z.union([z.string().max(4096), z.array(z.string().max(1024)).max(100)]).optional();
const outputSchema = z.object({ ok: z.boolean(), code: z.string(), changed: z.boolean(), data: z.record(z.string(), z.unknown()), warnings: z.array(z.string()) });

/** 同时生成一致的结构化结果与无装饰前缀的文本。 */
function result(message, data = {}, { ok = true, code = 'OK', warnings = [] } = {}) {
  const structuredContent = { ok, code, changed: !!data.changed, data, warnings };
  let body = message + (warnings.length ? '\n注意：' + warnings.join('；') : '');
  if (body.length > text.READ_LIMIT + 4096) body = body.slice(0, text.safeEnd(body, text.READ_LIMIT)) + '\n输出已截断，请分页';
  return { content: [{ type: 'text', text: body }], structuredContent, ...(ok ? {} : { isError: true }) };
}

/** 返回有界的前后差异片段，避免预览复制整个大文件。 */
function preview(before, after) {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let tail = 0;
  while (tail < before.length - start && tail < after.length - start && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
  const from = Math.max(0, start - 100);
  return { offset: from, before: before.slice(from, Math.min(before.length - tail + 100, from + 4000)), after: after.slice(from, Math.min(after.length - tail + 100, from + 4000)), abbreviated: Math.max(before.length, after.length) - tail - from > 4000 };
}

/** 创建服务并允许测试注入独立加密适配器。 */
function createServer(options = {}) {
  const server = new McpServer({ name: 'read-file-server', version: pkg.version });
  const encryption = options.encryption || createEncryption(options);
  const files = createFiles(encryption, options);
  const handlers = {};

  /** 包装工具的截止时间、取消、只读限制和可恢复错误字段。 */
  function register(name, description, schema, readOnly, action) {
    const handler = async (args, extra = {}) => {
      const context = { signal: extra.signal, deadline: performance.now() + (args.timeoutMs ?? 15000) };
      try {
        if (files.readOnly && !readOnly && !args.dryRun) throw text.fault('READ_ONLY', '服务以只读模式运行');
        return await action(args, context);
      } catch (error) {
        return result('操作失败：' + error.message, { changed: !!error.changed,
          ...(error.recoveryPath ? { recoveryPath: error.recoveryPath, rollbackError: error.rollbackError } : {}),
          ...(error.partial ? { partial: error.partial, sourceRetained: error.sourceRetained } : {}),
        }, { ok: false, code: error.code || 'INTERNAL_ERROR' });
      }
    };
    handlers[name] = handler;
    server.registerTool(name, { description, inputSchema: schema, outputSchema, annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, openWorldHint: false } }, handler);
  }

  register('read_file', '严格读取UTF8；最多40万字符，完整读取时返回hash，截断时返回nextOffset。', { path: pathSchema }, true, async (args, context) => {
    const data = await text.readText(await files.resolve(args.path), context);
    if (!data.truncated) data.hash = text.payloadFingerprint((data.hasBom ? '\uFEFF' : '') + data.content).hash;
    return result(data.content + (data.truncated ? '\n文件已截断，请用read_file_partial和nextOffset继续读取' : ''), data);
  });
  register('read_files', '批量严格读取UTF8，最多100个文件，总内容预算40万字符，逐项返回状态。', { paths: z.union([z.array(pathSchema).min(1).max(100), z.string().min(1).max(32768)]) }, true, async (args, context) => {
    const paths = Array.isArray(args.paths) ? args.paths : args.paths.split(',').map(p => p.trim()).filter(Boolean);
    if (!paths.length || paths.length > 100) throw text.fault('INVALID_PATHS', '文件列表需要1至100项');
    let remaining = text.READ_LIMIT;
    const entries = [];
    for (const value of paths) {
      text.checkBudget(context.signal, context.deadline);
      if (remaining <= 0) { entries.push({ path: value, code: 'BUDGET_EXHAUSTED' }); continue; }
      try {
        const data = await text.readText(await files.resolve(value), { ...context, limit: remaining });
        remaining -= data.content.length + value.length + 50;
        entries.push({ path: value, ok: true, ...data });
      } catch (error) { entries.push({ path: value, ok: false, code: error.code, error: error.message }); }
    }
    const ok = entries.some(item => item.ok);
    return result(entries.map(item => '文件: ' + item.path + '\n' + (item.content ?? item.error ?? item.code)).join('\n\n'), { entries }, { ok, code: ok ? 'OK' : 'READ_FAILED' });
  });
  register('read_file_partial', '字符/行分页。offset按去BOM后的UTF16单元计算，请使用nextOffset；行模式流式读取并返回nextLine。', {
    path: pathSchema, mode: z.enum(['chars', 'lines']), charCount: z.number().int().min(1).max(text.READ_LIMIT).optional(), offset: z.number().int().min(0).max(text.SCAN_BYTES).optional(), startLine: z.number().int().min(1).max(10000000).optional(), endLine: z.number().int().min(1).max(10000000).optional(), timeoutMs: timeoutSchema,
  }, true, async (args, context) => {
    if (args.mode === 'chars' && args.charCount === undefined) throw text.fault('MISSING_PARAMETER', 'chars模式必须提供charCount');
    if (args.mode === 'lines' && args.startLine === undefined) throw text.fault('MISSING_PARAMETER', 'lines模式必须提供startLine');
    if (args.mode === 'lines' && (args.endLine ?? args.startLine) < args.startLine) throw text.fault('INVALID_RANGE', 'endLine不能小于startLine');
    const file = await files.resolve(args.path);
    const data = args.mode === 'chars' ? await text.readText(file, { ...context, limit: args.charCount, offset: args.offset ?? 0 }) : await text.readLines(file, args.startLine, args.endLine ?? args.startLine, context);
    return result(args.mode === 'chars' ? data.content : data.lines.map(line => String(line.line).padStart(6) + ' | ' + line.text).join('\n'), data);
  });
  register('write_file', '写入或追加UTF8，暂存校验后提交，失败保留原文件；支持BOM/EOL、hash冲突检查、禁止覆盖和显式策略。', {
    path: pathSchema, content: z.string().max(text.EDIT_BYTES), mode: z.enum(['overwrite', 'append']).optional(), eol: z.enum(['auto', 'lf', 'crlf']).optional(), expectedHash: hashSchema.optional(), overwrite: z.boolean().optional(), writePolicy: policySchema, timeoutMs: timeoutSchema,
  }, false, async (args, context) => {
    const file = await files.resolve(args.path, { write: true });
    return files.locked([file], async () => {
      const before = await files.previous(file, context);
      const old = before ? await text.readFull(file, context) : { content: '', hasBom: false };
      const eol = args.eol === 'crlf' ? '\r\n' : args.eol === 'lf' ? '\n' : text.detectEol(old.content);
      let addition = text.normalizeEol(args.content, eol);
      if (addition.startsWith('\uFEFF')) addition = addition.slice(1);
      const payload = (old.hasBom || (!before && args.content.startsWith('\uFEFF')) ? '\uFEFF' : '') + (args.mode === 'append' ? old.content : '') + addition;
      if (Buffer.byteLength(payload) > text.EDIT_BYTES) throw text.fault('FILE_TOO_LARGE', '文本写入/追加超过16MB预算');
      const data = await files.write(file, payload, { ...context, expectedHash: args.expectedHash?.toLowerCase() ?? before?.hash ?? null, overwrite: args.overwrite, writePolicy: args.writePolicy });
      return result('写入成功: ' + file, data, { warnings: data.warnings || [] });
    }, context);
  });

  const editShape = { oldString: z.string().min(1).max(text.EDIT_BYTES), newString: z.string().max(text.EDIT_BYTES), replaceAll: z.boolean().optional(), expectedMatches: z.number().int().min(1).max(100000).optional() };
  register('edit_file', '单次或批量编辑互斥；全部匹配成功后暂存提交。支持dryRun预览、expectedHash/expectedMatches、换行兼容和限时正则。', {
    path: pathSchema, oldString: editShape.oldString.optional(), newString: editShape.newString.optional(), edits: z.array(z.object(editShape)).min(1).max(200).optional(), replaceAll: z.boolean().optional(), useRegex: z.boolean().optional(), ignoreCase: z.boolean().optional(), expectedMatches: editShape.expectedMatches, expectedHash: hashSchema.optional(), dryRun: z.boolean().optional(), writePolicy: policySchema, timeoutMs: timeoutSchema,
  }, false, async (args, context) => {
    if (args.edits && ['oldString', 'newString', 'useRegex', 'replaceAll', 'expectedMatches'].some(key => args[key] !== undefined)) throw text.fault('AMBIGUOUS_EDIT', 'edits与单次编辑参数不能同时提供');
    if (!args.edits && (args.oldString === undefined || args.newString === undefined)) throw text.fault('MISSING_PARAMETER', '请提供oldString/newString或edits');
    const file = await files.resolve(args.path, { write: !args.dryRun });
    return files.locked([file], async () => {
      const before = await files.previous(file, context);
      if (!before) throw text.fault('ENOENT', '文件不存在');
      if (args.expectedHash && args.expectedHash.toLowerCase() !== before.hash) throw text.fault('CONFLICT', 'expectedHash与当前文件不一致');
      const original = await text.readFull(file, context);
      let updated = original.content;
      let replaced = 0;
      let matched = 0;
      for (const item of args.edits || [args]) {
        text.checkBudget(context.signal, context.deadline);
        const change = args.useRegex ? await runRegex({ operation: 'edit', text: updated, pattern: item.oldString, replacement: text.normalizeEol(item.newString, text.detectEol(updated)), replaceAll: item.replaceAll === true, ignoreCase: args.ignoreCase }, { ...context, timeoutMs: Math.max(1, Math.min(1000, context.deadline - performance.now())) }) : applyLiteral(updated, item, args.ignoreCase);
        if (!change.matched) throw text.fault('NO_MATCH', '未找到匹配内容，文件未修改');
        if (item.expectedMatches !== undefined && item.expectedMatches !== change.matched) throw text.fault('MATCH_COUNT_MISMATCH', '实际匹配数与expectedMatches不一致');
        updated = change.updated;
        if (Buffer.byteLength(updated) > text.EDIT_BYTES) throw text.fault('FILE_TOO_LARGE', '编辑结果超过16MB预算');
        replaced += change.replaced;
        matched += change.matched;
      }
      const payload = (original.hasBom ? '\uFEFF' : '') + updated;
      const details = { matched, replaced, originalHash: before.hash, proposedHash: text.payloadFingerprint(payload).hash, preview: preview(original.content, updated) };
      if (args.dryRun) return result('编辑预览完成，文件未修改', { changed: false, dryRun: true, ...details });
      const data = await files.write(file, payload, { ...context, expectedHash: before.hash, writePolicy: args.writePolicy });
      return result('编辑成功: ' + file + '\n实际替换 ' + replaced + ' 处，共匹配 ' + matched + ' 处', { ...data, ...details }, { warnings: data.warnings || [] });
    }, context);
  });

  /** 遍历目录并记录访问错误；不跟随符号链接，内部暂存文件永远不作为结果。 */
  async function* walk(root, args, errors, context) {
    const st = await fs.lstat(root);
    if (st.isFile()) { yield { file: root, relative: path.basename(root), type: 'file' }; return; }
    if (!st.isDirectory()) throw text.fault('NOT_DIRECTORY', '根路径不是普通文件或目录');
    const excluded = new Set(args.useDefaultIgnore === false ? [] : IGNORE);
    for (const entry of args.exclude || []) excluded.add(entry);
    let visited = 0;
    /** 每一层检查深度、扫描数量、取消和时间预算。 */
    async function* visit(dir, depth) {
      if (depth > 128) throw text.fault('DEPTH_LIMIT', '目录深度超过128层');
      let handle;
      try { handle = await fs.opendir(dir); }
      catch (error) { if (errors.length < 100) errors.push({ path: dir, code: error.code }); return; }
      for await (const entry of handle) {
        text.checkBudget(context.signal, context.deadline);
        if (++visited > 100000) throw text.fault('SCAN_LIMIT', '扫描超过十万项，请缩小范围');
        if (entry.name.startsWith('.mcp-') || (!args.showHidden && entry.name.startsWith('.'))) continue;
        if (entry.isDirectory() && excluded.has(entry.name)) continue;
        const file = path.join(dir, entry.name);
        const relative = path.relative(root, file).replace(/\\/g, '/');
        if (entry.isSymbolicLink()) { yield { file, relative, type: 'symlink' }; continue; }
        yield { file, relative, type: entry.isDirectory() ? 'directory' : 'file' };
        if (entry.isDirectory()) yield* visit(file, depth + 1);
      }
    }
    yield* visit(root, 0);
  }
  const scanShape = { path: pathSchema, maxResults: z.number().int().min(1).max(2000).optional(), showHidden: z.boolean().optional(), useDefaultIgnore: z.boolean().optional(), exclude: patternsSchema, timeoutMs: timeoutSchema };
  register('search_files', '按行搜索，支持literal/regex、include数组与花括号、隐藏项开关。单文件5MB，总输出40万字符，错误明确报告；正则限时执行。', {
    ...scanShape, pattern: z.string().max(4096), include: patternsSchema, ignoreCase: z.boolean().optional(), onlyMatching: z.boolean().optional(), mode: z.enum(['regex', 'literal']).optional(), contextLines: z.number().int().min(0).max(10).optional(),
  }, true, async (args, context) => {
    const root = await files.resolve(args.path);
    const include = globMatcher(args.include);
    const errors = [];
    const skipped = { binary: 0, large: 0, unreadable: 0 };
    const results = [];
    const limit = args.maxResults ?? 200;
    let budget = text.READ_LIMIT;
    let scanned = 0;
    let truncated = false;
    const exclude = Array.isArray(args.exclude) ? args.exclude : (args.exclude || '').split(',').filter(Boolean);
    for await (const entry of walk(root, { ...args, exclude }, errors, context)) {
      if (entry.type !== 'file' || !include(entry.relative)) continue;
      if (results.length >= limit || budget <= 0) { truncated = true; break; }
      let content;
      try {
        const st = await fs.stat(entry.file);
        if (st.size > 5 * 1024 * 1024) { skipped.large++; continue; }
        content = (await text.readText(entry.file, { ...context, limit: Infinity, maxBytes: 5 * 1024 * 1024 })).content;
      } catch (error) {
        if (['CANCELLED', 'TIMEOUT'].includes(error.code)) throw error;
        if (error.code === 'FILE_TOO_LARGE') skipped.large++;
        else if (['BINARY_FILE', 'INVALID_UTF8', 'UNSUPPORTED_ENCODING'].includes(error.code)) skipped.binary++;
        else skipped.unreadable++;
        if (errors.length < 100) errors.push({ path: entry.file, code: error.code });
        continue;
      }
      scanned++;
      const found = await runRegex({ operation: 'search', text: content, pattern: args.mode === 'literal' ? escapeRegex(args.pattern) : args.pattern, ignoreCase: args.ignoreCase, onlyMatching: args.onlyMatching, limit: limit - results.length, maxChars: budget, contextLines: args.contextLines ?? 0 }, { ...context, timeoutMs: Math.max(1, Math.min(1000, context.deadline - performance.now())) });
      for (const hit of found.results) {
        const cost = entry.file.length + JSON.stringify(hit).length + 64;
        if (cost > budget) { truncated = true; break; }
        results.push({ path: entry.file, ...hit });
        budget -= cost;
      }
      if (found.truncated || truncated) { truncated = true; break; }
    }
    const warnings = errors.length ? ['部分文件/目录未能扫描，详见errors和skipped；无匹配不代表这些文件没有内容'] : [];
    return result('找到 ' + results.length + ' 处匹配（扫描 ' + scanned + ' 个文件）\n' + results.map(hit => hit.path + ':' + hit.line + ':' + hit.text).join('\n') + (truncated ? '\n结果已截断，请缩小范围' : ''), { results, scanned, skipped, errors, truncated }, { warnings, ok: scanned > 0 || !errors.length, code: scanned === 0 && errors.length ? 'SCAN_INCOMPLETE' : 'OK' });
  });
  register('find_files', '按glob递归查找，支持花括号、字面括号路径、隐藏项及默认忽略开关。', { ...scanShape, pattern: z.string().min(1).max(1024) }, true, async (args, context) => {
    const root = await files.resolve(args.path);
    const matches = globMatcher([args.pattern]);
    const entries = [];
    const errors = [];
    let truncated = false;
    let budget = text.READ_LIMIT;
    const exclude = Array.isArray(args.exclude) ? args.exclude : (args.exclude || '').split(',').filter(Boolean);
    for await (const entry of walk(root, { ...args, exclude }, errors, context)) {
      if (!matches(entry.relative)) continue;
      budget -= entry.file.length + entry.relative.length + 64;
      if (entries.length >= (args.maxResults ?? 500) || budget < 0) { truncated = true; break; }
      entries.push(entry);
    }
    return result(entries.map(entry => entry.type.toUpperCase() + ' ' + entry.file).join('\n') || '未找到匹配项', { entries, errors, truncated }, { warnings: errors.length ? ['部分目录未能扫描'] : [], ok: !!entries.length || !errors.length, code: !entries.length && errors.length ? 'SCAN_INCOMPLETE' : 'OK' });
  });
  register('list_directory', '列目录的文件/目录/链接类型与元数据，支持分页。', { path: pathSchema, showHidden: z.boolean().optional(), offset: z.number().int().min(0).max(1000000).optional(), maxResults: z.number().int().min(1).max(2000).optional() }, true, async (args, context) => {
    const root = await files.resolve(args.path);
    const entries = [];
    let seen = 0;
    let nextOffset = null;
    const handle = await fs.opendir(root);
    for await (const entry of handle) {
      text.checkBudget(context.signal, context.deadline);
      if (!args.showHidden && entry.name.startsWith('.')) continue;
      if (seen++ < (args.offset ?? 0)) continue;
      if (entries.length >= (args.maxResults ?? 500)) { nextOffset = seen - 1; break; }
      try {
        const st = await fs.lstat(path.join(root, entry.name));
        entries.push({ name: entry.name, type: st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'directory' : 'file', sizeOnDisk: st.size, modifiedTime: st.mtime.toISOString() });
      } catch (error) { entries.push({ name: entry.name, error: error.code }); }
    }
    return result(entries.map(entry => (entry.type || 'ERROR').toUpperCase() + ' ' + entry.name).join('\n') || '空目录', { entries, nextOffset, truncated: nextOffset !== null });
  });
  register('file_info', '查询大小/时间/链接；流式计算可读字节数及hash，不经文本解码。calculateHash=false可只查元数据。', { path: pathSchema, calculateHash: z.boolean().optional(), timeoutMs: timeoutSchema }, true, async (args, context) => {
    const file = await files.resolve(args.path, { leaf: true });
    const st = await statMaybe(file);
    if (!st) return result('路径不存在', { path: file, exists: false });
    const data = { path: file, exists: true, type: st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'directory' : 'file', sizeOnDisk: st.size, modifiedTime: st.mtime.toISOString(), createdTime: st.birthtime.toISOString() };
    if (st.isSymbolicLink()) data.symlinkTarget = await fs.readlink(file);
    if (st.isFile() && args.calculateHash !== false) { const fp = await text.fingerprint(file, context); data.sizeReadable = fp.size; data.sizePlaintext = fp.size; data.hash = fp.hash; }
    return result(JSON.stringify(data, null, 2), data);
  });
  register('create_directory', '递归创建目录，受只读模式与allowedRoots约束。', { path: pathSchema }, false, async args => {
    const dir = await files.resolve(args.path, { write: true });
    const existed = !!(await statMaybe(dir));
    await fs.mkdir(dir, { recursive: true });
    return result('目录已创建: ' + dir, { path: dir, changed: !existed });
  });
  const transferShape = { source: pathSchema, destination: pathSchema, overwrite: z.boolean().optional(), writePolicy: policySchema, timeoutMs: timeoutSchema };
  register('copy_path', '逐文件复制和验证。目标已有目录时放入其下；失败返回部分目标并保留源，不自动跟随链接。', transferShape, false, async (args, context) => {
    const data = await files.transfer(args.source, args.destination, false, { ...context, overwrite: args.overwrite, writePolicy: args.writePolicy });
    return result('复制完成: ' + data.destination, data, { warnings: data.warnings || [] });
  });
  register('move_path', '复制验证后再删源，同路径不操作；同盘/跨盘使用相同校验流程。', transferShape, false, async (args, context) => {
    const data = await files.transfer(args.source, args.destination, true, { ...context, overwrite: args.overwrite, writePolicy: args.writePolicy });
    return result('移动完成: ' + data.destination, data, { warnings: data.warnings || [] });
  });
  register('remove_path', '删除文件/目录或链接。recursive=false仅删空目录，dryRun仅预览；拒绝删除工作根/盘符根。', { path: pathSchema, recursive: z.boolean().optional(), dryRun: z.boolean().optional() }, false, async (args, context) => {
    const data = await files.remove(args.path, { ...context, recursive: args.recursive, dryRun: args.dryRun });
    return result(args.dryRun ? '删除预览，未修改文件' : '删除完成', data);
  });
  register('check_status', '心跳不触发探测；可选文件前缀检查，只在expectedHash可信对照一致时确认内容，不凭能读取推断解密正常。', { path: pathSchema.optional(), expectedHash: hashSchema.optional() }, true, async (args, context) => {
    const data = { version: pkg.version, node: process.version, baseDir: files.baseDir, readOnly: files.readOnly, decryptionVerified: false };
    if (!args.path) return result('read-file-server 运行中；本次未验证解密能力', data);
    const file = await files.resolve(args.path);
    const sample = await text.readText(file, { ...context, limit: 200 });
    if (sample.content.startsWith('%TSD')) throw text.fault('CIPHERTEXT_DETECTED', '检测到TSD密文头，不能认定解密正常');
    data.readable = true;
    data.validUtf8Sample = true;
    if (args.expectedHash) {
      const fp = await text.fingerprint(file, context);
      if (fp.hash !== args.expectedHash.toLowerCase()) throw text.fault('HASH_MISMATCH', '内容与可信hash不一致');
      data.decryptionVerified = true;
    }
    return result(args.expectedHash ? '读取内容与可信明文hash一致' : '文件前缀可读取为UTF8；尚未证明解密成功', data);
  });
  register('encryption_profile', '查看自动探测和独立手工策略；首次调用会创建隔离探测样本与缓存。', { timeoutMs: timeoutSchema }, false, async (_args, context) => {
    const data = await encryption.summary(context);
    return result(JSON.stringify(data, null, 2), data);
  });
  register('refresh_profile', '刷新自动探测缓存，保留手工protected/unsafe策略。', { timeoutMs: timeoutSchema }, false, async (_args, context) => {
    await encryption.refresh(context);
    const data = await encryption.summary(context);
    return result('自动探测已刷新，手工策略保持不变\n' + JSON.stringify(data, null, 2), data);
  });
  register('mark_extension', '独立保存策略：protected保留受控写入，unsafe必须验证明文，clear清除手工覆盖；刷新与TTL不丢失标注。', { extension: z.string().min(1).max(33), category: z.enum(['protected', 'unsafe', 'clear']) }, false, async args => {
    const data = await encryption.mark(args.extension, args.category);
    return result('策略已更新: ' + data.extension + ' = ' + data.category, { ...data, changed: true });
  });
  register('inspect_write_strategy', '检查有效写入策略；在已存在目标目录创建并清理随机探测样本，不修改目标文件。', { path: pathSchema, writePolicy: policySchema, timeoutMs: timeoutSchema }, false, async (args, context) => {
    const file = await files.resolve(args.path);
    const data = await encryption.strategy(file, args.writePolicy, context);
    return result(JSON.stringify(data, null, 2), data);
  });
  return { server, handlers, encryption, files };
}
module.exports = { createServer, result, preview };
