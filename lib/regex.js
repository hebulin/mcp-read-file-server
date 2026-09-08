/** 复用正则 worker；每个调用独立截止，超时后重建线程。 */
const { Worker } = require('node:worker_threads');
const path = require('node:path');
const { fault } = require('./text');
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
    if (message.error) job.reject(fault('INVALID_REGEX', message.error));
    else job.resolve(message.result);
    if (!pending.size) current.unref();
  });
  current.on('error', error => { if (worker === current) stop(fault('REGEX_WORKER_ERROR', error.message)); });
  current.on('exit', code => { if (worker === current) stop(fault('REGEX_WORKER_EXIT', '正则线程退出: ' + code)); });
  return current;
}

/** 运行有硬超时和队列上限的正则任务。 */
function runRegex(task, options = {}) {
  if (task.pattern.length > 4096) return Promise.reject(fault('INVALID_REGEX', '正则超过 4096 字符'));
  if (pending.size >= 16) return Promise.reject(fault('BUSY', '正则队列已满，请缩小搜索范围'));
  if (options.signal?.aborted) return Promise.reject(fault('CANCELLED', '操作已取消'));
  return new Promise((resolve, reject) => {
    const current = ensureWorker();
    current.ref();
    const id = ++serial;
    const abort = () => stop(fault('CANCELLED', '正则任务已取消'));
    const timer = setTimeout(() => stop(fault('REGEX_TIMEOUT', '正则计算超过预算；请简化正则或使用字面量模式')), options.timeoutMs ?? 1000);
    options.signal?.addEventListener('abort', abort, { once: true });
    pending.set(id, { resolve, reject, timer, cleanup: () => options.signal?.removeEventListener('abort', abort) });
    current.postMessage({ id, task });
  });
}

module.exports = { runRegex, stop };
