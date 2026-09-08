/** 严格 UTF-8、有限内存分页、文件指纹与换行处理。 */
const fs = require('node:fs');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const READ_LIMIT = 400000;
const EDIT_BYTES = 16 * 1024 * 1024;
const SCAN_BYTES = 64 * 1024 * 1024;

/** 创建可被 MCP 结构化返回的业务错误。 */
function fault(code, message, details = {}) {
  return Object.assign(new Error(message), { code, ...details });
}

/** 检查取消请求和整次操作截止时间。 */
function checkBudget(signal, deadline = Infinity) {
  if (signal?.aborted) throw fault('CANCELLED', '操作已取消');
  if (performance.now() > deadline) throw fault('TIMEOUT', '操作超过时间预算');
}

/** 按 UTF-8 严格增量解码；不把残缺多字节序列替换成乱码。 */
async function* textChunks(file, options = {}) {
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const stream = fs.createReadStream(file, { highWaterMark: 65536 });
  let bytes = 0;
  let first = true;
  try {
    for await (const chunk of stream) {
      checkBudget(options.signal, options.deadline);
      bytes += chunk.length;
      if (bytes > (options.maxBytes ?? SCAN_BYTES)) throw fault('FILE_TOO_LARGE', '读取超过字节预算');
      if (first && chunk.length >= 2 && ((chunk[0] === 255 && chunk[1] === 254) || (chunk[0] === 254 && chunk[1] === 255))) {
        throw fault('UNSUPPORTED_ENCODING', '检测到 UTF-16；当前文本工具仅接受有效 UTF-8，请先显式转换编码');
      }
      first = false;
      let text;
      try { text = decoder.decode(chunk, { stream: true }); }
      catch { throw fault('INVALID_UTF8', '文件不是有效 UTF-8，已拒绝操作以保留原始字节'); }
      if (text.includes('\0')) throw fault('BINARY_FILE', '检测到 NUL 字节，拒绝按普通文本处理');
      yield text;
    }
    try {
      const tail = decoder.decode();
      if (tail) yield tail;
    } catch { throw fault('INVALID_UTF8', '文件末尾存在不完整 UTF-8 字符'); }
  } finally { stream.destroy(); }
}

/** 调整 UTF-16 单元边界，保证分页不会切断 Unicode 代理对。 */
function safeEnd(text, limit) {
  let end = Math.min(text.length, limit);
  const code = text.charCodeAt(end - 1);
  if (end < text.length && code >= 0xd800 && code <= 0xdbff) end++;
  return end;
}

/** 读取有限字符窗口；offset/nextOffset 使用去 BOM 后的 UTF-16 单元偏移。 */
async function readText(file, options = {}) {
  const limit = options.limit ?? READ_LIMIT;
  const offset = options.offset ?? 0;
  let content = '';
  let skipped = 0;
  let first = true;
  let hasBom = false;
  let truncated = false;
  let totalChars = 0;
  for await (let chunk of textChunks(file, options)) {
    if (first && chunk.length) {
      hasBom = chunk.charCodeAt(0) === 0xfeff;
      if (hasBom) chunk = chunk.slice(1);
      first = false;
    }
    totalChars += chunk.length;
    if (skipped < offset) {
      const take = Math.min(chunk.length, offset - skipped);
      if (take < chunk.length && chunk.charCodeAt(take) >= 0xdc00 && chunk.charCodeAt(take) <= 0xdfff) {
        throw fault('INVALID_OFFSET', 'offset 落在 Unicode 代理对中间，请使用上次返回的 nextOffset');
      }
      chunk = chunk.slice(take);
      skipped += take;
    }
    content += chunk;
    if (content.length > limit) {
      const end = safeEnd(content, limit);
      if (content.length > end) { content = content.slice(0, end); truncated = true; break; }
    }
  }
  return { content, hasBom, truncated, totalChars: truncated ? null : totalChars, offset, nextOffset: truncated ? offset + content.length : null, size: Buffer.byteLength(content) };
}

/** 有上限地读取完整编辑文本；严格解码失败时调用方不得写回。 */
async function readFull(file, options = {}) {
  return readText(file, { ...options, limit: Infinity, maxBytes: EDIT_BYTES });
}

/** 流式枚举行，兼容 CRLF、LF 和单 CR，并限制单行体量。 */
async function* textLines(file, options = {}) {
  let pending = '';
  let first = true;
  for await (let chunk of textChunks(file, options)) {
    if (first && chunk.length) { if (chunk.charCodeAt(0) === 0xfeff) chunk = chunk.slice(1); first = false; }
    pending += chunk;
    let start = 0;
    for (let i = 0; i < pending.length; i++) {
      const ch = pending[i];
      if (ch !== '\r' && ch !== '\n') continue;
      if (ch === '\r' && i === pending.length - 1) break;
      const line = pending.slice(start, i);
      if (line.length > READ_LIMIT) throw fault('LINE_TOO_LONG', '单行超过 40 万字符，请使用字符分页');
      yield line;
      if (ch === '\r' && pending[i + 1] === '\n') i++;
      start = i + 1;
    }
    pending = pending.slice(start);
    if (pending.length > READ_LIMIT + 1) throw fault('LINE_TOO_LONG', '单行超过 40 万字符，请使用字符分页');
  }
  if (pending.endsWith('\r')) yield pending.slice(0, -1);
  else if (pending) yield pending;
}

/** 按行分页，达到输出预算即停，不为统计总行数读取整文件。 */
async function readLines(file, start, end, options = {}) {
  const lines = [];
  let lineNo = 0;
  let chars = 0;
  let nextLine = null;
  for await (const line of textLines(file, options)) {
    lineNo++;
    if (lineNo < start) continue;
    if (lineNo > end || chars + line.length + 16 > READ_LIMIT) { nextLine = lineNo; break; }
    lines.push({ line: lineNo, text: line });
    chars += line.length + 16;
  }
  if (lineNo === 0 && start === 1) { lines.push({ line: 1, text: '' }); lineNo = 1; }
  if (!lines.length && start > lineNo) throw fault('LINE_OUT_OF_RANGE', '起始行超出已读取文件的总行数');
  return { lines, nextLine, truncated: nextLine !== null, totalLines: nextLine === null ? lineNo : null };
}

/** 流式计算真实读取字节的 SHA-256、字节数及前缀，不经过文本转码。 */
async function fingerprint(file, options = {}) {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(file, { highWaterMark: 65536 });
  let size = 0;
  let prefix = Buffer.alloc(0);
  try {
    for await (const chunk of stream) {
      checkBudget(options.signal, options.deadline);
      size += chunk.length;
      if (size > (options.maxBytes ?? Infinity)) throw fault('FILE_TOO_LARGE', '文件超过处理预算');
      if (prefix.length < 16) prefix = Buffer.concat([prefix, chunk.subarray(0, 16 - prefix.length)]);
      hash.update(chunk);
    }
  } finally { stream.destroy(); }
  return { hash: hash.digest('hex'), size, prefix: prefix.toString('hex') };
}

/** 计算已有载荷的独立指纹，避免写入后与目标自身比较。 */
function payloadFingerprint(payload) {
  const buffer = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  return { hash: crypto.createHash('sha256').update(buffer).digest('hex'), size: buffer.length, prefix: buffer.subarray(0, 16).toString('hex') };
}

/** 选择原文本主导行尾，CR-only 文件保持原风格。 */
function detectEol(text) {
  const counts = { '\r\n': 0, '\n': 0, '\r': 0 };
  for (const match of text.matchAll(/\r\n|\r|\n/g)) counts[match[0]]++;
  return Object.keys(counts).reduce((best, key) => counts[key] > counts[best] ? key : best, '\n');
}

/** 只规范化调用方传入的新文本，不改动未编辑区域。 */
function normalizeEol(text, eol) { return text.replace(/\r\n|\r|\n/g, eol); }

module.exports = { READ_LIMIT, EDIT_BYTES, SCAN_BYTES, fault, checkBudget, safeEnd, textChunks, textLines, readText, readFull, readLines, fingerprint, payloadFingerprint, detectEol, normalizeEol };
