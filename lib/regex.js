/** 正则与字面量编辑共用有界计算线程；排队、取消和截止时间按请求隔离。 */
const { Worker } = require('node:worker_threads');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { fault, checkBudget } = require('./text');
let worker = null;
let running = null;
let serial = 0;
const pending = new Map();

/** 释放指定任务的定时器和取消监听，只完成该任务。 */
function settle(id, error, value) {
  const job = pending.get(id);
  if (!job) return;
  pending.delete(id);
  clearTimeout(job.timer);
  job.cleanup();
  if (error) job.reject(error); else job.resolve(value);
}

/** 丢弃当前线程，旧线程的迟到消息不能影响后续请求。 */
function retireWorker() {
  const previous = worker;
  worker = null;
  running = null;
  if (previous) previous.terminate().catch(() => {});
}

/** 服务关闭时取消全部任务；普通取消不使用此全局入口。 */
function stop(error = fault('CANCELLED', '正则任务已取消')) {
  retireWorker();
  for (const id of pending.keys()) settle(id, error);
}

/** 取消排队任务不影响线程；取消运行任务时重建线程继续处理其他请求。 */
function cancel(id, error) {
  if (!pending.has(id)) return;
  if (running === id) retireWorker();
  settle(id, error);
  dispatch();
}

/** 创建工作线程并只接收当前线程、当前任务的结果。 */
function ensureWorker() {
  if (worker) return worker;
  const current = new Worker(path.join(__dirname, 'regex-worker.js'), { resourceLimits: { maxOldGenerationSizeMb: 128 } });
  worker = current;
  current.on('message', message => {
    if (worker !== current || running !== message.id) return;
    const job = pending.get(message.id);
    running = null;
    if (job) {
      const error = performance.now() > job.deadline ? fault('TIMEOUT', '计算结果到达时已超过操作预算') :
        message.error ? fault(message.error.code, message.error.message, message.error.details) : null;
      settle(message.id, error, message.result);
    }
    dispatch();
  });
  current.on('error', error => {
    if (worker === current) {
      const id = running;
      retireWorker();
      if (id !== null) settle(id, fault('REGEX_WORKER_ERROR', error.message));
      dispatch();
    }
  });
  current.on('exit', code => {
    if (worker !== current) return;
    const id = running;
    retireWorker();
    if (id !== null) settle(id, fault('REGEX_WORKER_EXIT', '正则线程退出: ' + code));
    dispatch();
  });
  return current;
}

/** 只将一个任务送入线程，其余保留在主线程队列以便单独取消。 */
function dispatch() {
  if (running !== null) return;
  for (const [id, job] of pending) {
    try {
      checkBudget(job.signal, job.deadline);
      const current = ensureWorker();
      running = id;
      current.ref();
      current.postMessage({ id, task: job.task });
      return;
    } catch (error) {
      retireWorker();
      settle(id, error);
    }
  }
  worker?.unref();
}

/** 每个任务独立计时，排队时间同样计入硬预算，最多保留16个请求。 */
function runTask(task, options = {}) {
  if (pending.size >= 16) return Promise.reject(fault('BUSY', '正则队列已满，请缩小搜索范围'));
  return new Promise((resolve, reject) => {
    checkBudget(options.signal, options.deadline);
    const id = ++serial;
    const abort = () => cancel(id, fault('CANCELLED', '正则任务已取消'));
    const deadline = Math.min(options.deadline ?? Infinity, performance.now() + (options.timeoutMs ?? 1000));
    const timer = setTimeout(() => cancel(id, task.operation === 'literal_edit' ? fault('TIMEOUT', '字面量编辑超过时间预算') : fault('REGEX_TIMEOUT', '正则计算超过预算；请简化正则或使用字面量模式')), Math.max(1, deadline - performance.now()));
    pending.set(id, { resolve, reject, timer, deadline, task, signal: options.signal, cleanup: () => options.signal?.removeEventListener('abort', abort) });
    options.signal?.addEventListener('abort', abort, { once: true });
    dispatch();
  });
}

/** 限制用户输入长度；字面量的内部转义不占用用户输入预算。 */
function runRegex(task, options = {}) {
  if (task.pattern.length > 4096) return Promise.reject(fault('INVALID_REGEX', '搜索或正则模式超过 4096 字符'));
  return runTask(task, options);
}

/** 字面量保留原始索引、换行和替换语义，同样具备线程取消能力。 */
function runLiteral(text, edit, ignoreCase, options = {}) {
  return runTask({ operation: 'literal_edit', text, edit, ignoreCase }, options);
}

module.exports = { runRegex, runLiteral, stop };
