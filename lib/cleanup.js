/** 清理只收集自身错误，不覆盖主操作结果或恢复信息。 */
const fs = require('node:fs/promises');
const { READ_LIMIT, safeEnd } = require('./text');

/** 尝试删除全部指定临时文件，并返回有界的清理诊断。 */
async function cleanupFiles(paths) {
  const errors = [];
  for (const entry of paths) {
    const file = typeof entry === 'string' ? entry : entry.path;
    try { await fs.rm(file, { force: true, ...(typeof entry === 'object' && entry.recursive ? { recursive: true } : {}) }); }
    catch (error) { errors.push({ path: file, code: error.code || 'CLEANUP_FAILED', message: error.message }); }
  }
  return errors;
}

/** 合并跨层传递的清理诊断，避免同一失败在上下文和异常中重复出现。 */
function mergeCleanup(...groups) {
  const unique = new Map();
  for (const item of groups.flat()) unique.set(JSON.stringify([item.path, item.code, item.message]), item);
  return [...unique.values()].slice(0, 100);
}

/** 辅助流程保留原返回值/主错误，把清理问题汇总到同一请求上下文。 */
async function withCleanup(paths, action, context = {}) {
  let value, failure;
  try { value = await action(); } catch (error) { failure = error; }
  const errors = await cleanupFiles(paths);
  context.cleanupErrors ||= [];
  const merged = mergeCleanup(context.cleanupErrors, errors);
  context.cleanupErrors.splice(0, context.cleanupErrors.length, ...merged);
  if (failure) return finishCleanup(undefined, failure, errors);
  return value;
}

/** 失败保留主异常，成功则附加清理告警；兼容文件结果与MCP响应。 */
function finishCleanup(value, failure, errors) {
  if (failure) {
    if (errors.length) failure.cleanupErrors = mergeCleanup(failure.cleanupErrors || [], errors);
    throw failure;
  }
  if (!errors.length) return value;
  const response = value.structuredContent;
  const data = response ? response.data : value;
  data.cleanupErrors = mergeCleanup(data.cleanupErrors || [], errors);
  const warning = '操作已完成，但有临时文件或锁未能清理；请查看cleanupErrors，不要重复提交已完成的修改';
  if (response) {
    if (!response.warnings.includes(warning)) response.warnings.push(warning);
    const body = value.content.find(item => item.type === 'text');
    if (body && !body.text.includes(warning)) body.text = body.text.slice(0, safeEnd(body.text, READ_LIMIT)) + '\n注意：' + warning;
  } else value.warnings = [...new Set([...(value.warnings || []), warning])];
  return value;
}

module.exports = { cleanupFiles, finishCleanup, mergeCleanup, withCleanup };
