/** 将用户正则隔离在可终止线程，主线程保持 MCP 心跳响应。 */
const { parentPort } = require('node:worker_threads');
const { applyLiteral, escapeRegex } = require('./patterns');
const { EDIT_BYTES, fault } = require('./text');

/** 按UTF8字节预算拼接，跨片段的代理对只按合并后的四字节计数。 */
function boundedBuilder() {
  const parts = [];
  const chunks = [];
  let bytes = 0, last = -1;
  /** 在保存片段前核对预算，避免先构造超大替换结果。 */
  function append(value) {
    if (!value) return;
    const first = value.charCodeAt(0);
    bytes += Buffer.byteLength(value) - (last >= 0xd800 && last <= 0xdbff && first >= 0xdc00 && first <= 0xdfff ? 2 : 0);
    last = value.charCodeAt(value.length - 1);
    if (bytes - (last >= 0xd800 && last <= 0xdbff ? 2 : 0) > EDIT_BYTES) throw fault('FILE_TOO_LARGE', '编辑结果超过16MB预算');
    parts.push(value);
    if (parts.length >= 1024) { chunks.push(parts.join('')); parts.length = 0; }
  }
  /** 最后核对孤立代理项后一次拼接有界结果。 */
  function finish() {
    if (bytes > EDIT_BYTES) throw fault('FILE_TOO_LARGE', '编辑结果超过16MB预算');
    return chunks.concat(parts.join('')).join('');
  }
  return { append, finish };
}

/** 流式展开JS替换标记，保留$$、整匹配、前后文、数字与命名捕获组语义。 */
function appendReplacement(builder, replacement, match, original) {
  let cursor = 0;
  const tokens = match.groups === undefined ? /\$(\$|&|`|'|[0-9]{1,2})/g : /\$(\$|&|`|'|[0-9]{1,2}|<[^>]*>)/g;
  for (const token of replacement.matchAll(tokens)) {
    builder.append(replacement.slice(cursor, token.index));
    const key = token[1];
    let value = token[0];
    if (key === '$') value = '$';
    else if (key === '&') value = match[0];
    else if (key === '`') value = original.slice(0, match.index);
    else if (key === "'") value = original.slice(match.index + match[0].length);
    else if (key[0] === '<') {
      if (match.groups !== undefined) value = match.groups[key.slice(1, -1)] ?? '';
    } else {
      const number = Number(key);
      if (number > 0 && number < match.length) value = match[number] ?? '';
      else if (key.length === 2 && Number(key[0]) > 0 && Number(key[0]) < match.length) value = (match[Number(key[0])] ?? '') + key[1];
    }
    builder.append(value);
    cursor = token.index + token[0].length;
  }
  builder.append(replacement.slice(cursor));
}

/** 一边枚举匹配一边构造有界结果，单次替换仍统计全部匹配数。 */
function editRegex(task, regex) {
  const builder = boundedBuilder();
  let count = 0, replaced = 0, cursor = 0;
  for (const match of task.text.matchAll(regex)) {
    if (++count > 100000) throw fault('MATCH_LIMIT', '匹配数超过上限');
    if (!task.replaceAll && replaced) continue;
    builder.append(task.text.slice(cursor, match.index));
    appendReplacement(builder, task.replacement, match, task.text);
    cursor = match.index + match[0].length;
    replaced++;
  }
  builder.append(task.text.slice(cursor));
  return { updated: builder.finish(), matched: count, replaced };
}

/** 执行有限输出的匹配或编辑，超时由父线程终止整个 worker。 */
function execute(task) {
  if (task.operation === 'literal_edit') return applyLiteral(task.text, task.edit, task.ignoreCase);
  const regex = new RegExp(task.literal ? escapeRegex(task.pattern) : task.pattern, 'gm' + (task.ignoreCase ? 'i' : ''));
  if (task.operation === 'edit') {
    return editRegex(task, regex);
  }
  const results = [];
  let chars = 0;
  let truncated = false;
  const lines = task.text.split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length; i++) {
    regex.lastIndex = 0;
    for (const match of lines[i].matchAll(regex)) {
      const value = task.onlyMatching ? match[0] : lines[i];
      const context = task.contextLines ? {
        before: lines.slice(Math.max(0, i - task.contextLines), i),
        after: lines.slice(i + 1, i + 1 + task.contextLines),
      } : undefined;
      const hit = { line: i + 1, text: value, ...(context ? { context } : {}) };
      const cost = JSON.stringify(hit).length + 32;
      if (results.length >= task.limit || chars + cost > task.maxChars) { truncated = true; break; }
      results.push(hit);
      chars += cost;
      if (!task.onlyMatching) break;
    }
    if (truncated) break;
  }
  return { results, truncated };
}

parentPort.on('message', message => {
  try { parentPort.postMessage({ id: message.id, result: execute(message.task) }); }
  catch (error) { parentPort.postMessage({ id: message.id, error: { code: error.code || (message.task.operation === 'literal_edit' ? 'EDIT_FAILED' : 'INVALID_REGEX'), message: error.message, details: { ...(error.matched !== undefined ? { matched: error.matched } : {}) } } }); }
});
