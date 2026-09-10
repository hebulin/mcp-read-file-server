/** 正则与字面量编辑共用有界计算线程；主线程负责取消和截止时间。 */
const { Worker } = require('node:worker_threads');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { fault, checkBudget } = require('./text');
let worker = null;
let serial = 0;
const pending = new Map();

/** 终止当前 worker，拒绝所有受该线程故障影响的请求。 */
function stop(error = fault('CANCELLED', '正则任务已取消')) {
  const previous = worker;
  worker = null;
  for (const job of pending.values()) { clearTimeout(job.timer); job.cleanup(); job.reject(error); }
  pending.clear();
  if (previous) previous.terminate().catch(() => {});
}

/** 创建工作线程并分派结果，不让单次回溯阻塞服务主线程。 */
function ensureWorker() {
  if (worker) return worker;
  const current = new Worker(path.join(__dirname, 'regex-worker.js'), { resourceLimits: { maxOldGenerationSizeMb: 128 } });
  worker = current;
  current.on('message', message => {
    const job = pending.get(message.id);
    if (!job) return;
    pending.delete(message.id);
    clearTimeout(job.timer);
    job.cleanup();
    if (performance.now() > job.deadline) job.reject(fault('TIMEOUT', '计算结果到达时已超过操作预算'));
    else if (message.error) job.reject(fault(message.error.code, message.error.message));
    else job.resolve(message.result);
    if (!pending.size) current.unref();
  });
  current.on('error', error => { if (worker === current) stop(fault('REGEX_WORKER_ERROR', error.message)); });
  current.on('exit', code => { if (worker === current) stop(fault('REGEX_WORKER_EXIT', '正则线程退出: ' + code)); });
  return current;
}

/** 分派有硬超时和队列上限的计算任务，连同排队时间一起计入预算。 */
function runTask(task, options = {}) {
  if (pending.size >= 16) return Promise.reject(fault('BUSY', '正则队列已满，请缩小搜索范围'));
  if (options.signal?.aborted) return Promise.reject(fault('CANCELLED', '操作已取消'));
  return new Promise((resolve, reject) => {
    checkBudget(options.signal, options.deadline);
    const current = ensureWorker();
    current.ref();
    const id = ++serial;
    const abort = () => stop(fault('CANCELLED', '正则任务已取消'));
    const deadline = Math.min(options.deadline ?? Infinity, performance.now() + (options.timeoutMs ?? 1000));
    const timer = setTimeout(() => stop(task.operation === 'literal_edit' ? fault('TIMEOUT', '字面量编辑超过时间预算') : fault('REGEX_TIMEOUT', '正则计算超过预算；请简化正则或使用字面量模式')), Math.max(1, deadline - performance.now()));
    options.signal?.addEventListener('abort', abort, { once: true });
    pending.set(id, { resolve, reject, timer, deadline, cleanup: () => options.signal?.removeEventListener('abort', abort) });
    current.postMessage({ id, task });
  });
}

/** 限制用户正则长度后交给工作线程执行。 */
function runRegex(task, options = {}) {
  if (task.pattern.length > 4096) return Promise.reject(fault('INVALID_REGEX', '正则超过 4096 字符'));
  return runTask(task, options);
}

/** 字面量保留原始索引、换行和替换语义，同样具备线程取消能力。 */
function runLiteral(text, edit, ignoreCase, options = {}) {
  return runTask({ operation: 'literal_edit', text, edit, ignoreCase }, options);
}

module.exports = { runRegex, runLiteral, stop };
