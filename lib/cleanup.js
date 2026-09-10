/** 清理只收集自身错误，不覆盖主操作结果或恢复信息。 */
const fs = require('node:fs/promises');
const { READ_LIMIT, safeEnd } = require('./text');

/** 尝试删除全部指定临时文件，并返回有界的清理诊断。 */
async function cleanupFiles(paths) {
  const errors = [];
  for (const file of paths) {
    try { await fs.rm(file, { force: true }); }
    catch (error) { errors.push({ path: file, code: error.code || 'CLEANUP_FAILED', message: error.message }); }
  }
  return errors;
}

/** 失败保留主异常，成功则附加清理告警；兼容文件结果与MCP响应。 */
function finishCleanup(value, failure, errors) {
  if (failure) {
    if (errors.length) failure.cleanupErrors = [...(failure.cleanupErrors || []), ...errors].slice(0, 100);
    throw failure;
  }
  if (!errors.length) return value;
  const response = value.structuredContent;
  const data = response ? response.data : value;
  data.cleanupErrors = [...(data.cleanupErrors || []), ...errors].slice(0, 100);
  const warning = '操作已完成，但有临时文件或锁未能清理；请查看cleanupErrors，不要重复提交已完成的修改';
  if (response) {
    response.warnings = [...response.warnings, warning];
    const body = value.content.find(item => item.type === 'text');
    if (body) body.text = body.text.slice(0, safeEnd(body.text, READ_LIMIT)) + '\n注意：' + warning;
  } else value.warnings = [...(value.warnings || []), warning];
  return value;
}

module.exports = { cleanupFiles, finishCleanup };
