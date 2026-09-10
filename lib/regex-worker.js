/** 将用户正则隔离在可终止线程，主线程保持 MCP 心跳响应。 */
const { parentPort } = require('node:worker_threads');
const { applyLiteral } = require('./patterns');

/** 执行有限输出的匹配或编辑，超时由父线程终止整个 worker。 */
function execute(task) {
  if (task.operation === 'literal_edit') return applyLiteral(task.text, task.edit, task.ignoreCase);
  const regex = new RegExp(task.pattern, 'gm' + (task.ignoreCase ? 'i' : ''));
  if (task.operation === 'edit') {
    let count = 0;
    for (const ignored of task.text.matchAll(regex)) {
      void ignored;
      if (++count > 100000) throw new Error('匹配数超过上限');
    }
    const replacer = task.replaceAll ? regex : new RegExp(task.pattern, 'm' + (task.ignoreCase ? 'i' : ''));
    return { updated: task.text.replace(replacer, task.replacement), matched: count, replaced: task.replaceAll ? count : Math.min(count, 1) };
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
  catch (error) { parentPort.postMessage({ id: message.id, error: { code: error.code || (message.task.operation === 'literal_edit' ? 'EDIT_FAILED' : 'INVALID_REGEX'), message: error.message } }); }
});
