/** glob 解析及保持原始位置的字符串编辑。 */
const { fault, normalizeEol, detectEol } = require('./text');

/** 按顶层逗号分隔旧版模式列表，保留花括号内的逗号。 */
function splitPatterns(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  const result = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '{') depth++;
    if (value[i] === '}') depth--;
    if (depth < 0) throw fault('INVALID_GLOB', '花括号不匹配');
    if (value[i] === ',' && depth === 0) { result.push(value.slice(start, i).trim()); start = i + 1; }
  }
  if (depth) throw fault('INVALID_GLOB', '花括号不匹配');
  result.push(value.slice(start).trim());
  return result.filter(Boolean);
}

/** 转义正则字面量，圆括号路径不会被解释为语法。 */
function escapeRegex(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** 将有界 glob 转为正则，双星仅在完整路径段时跨目录。 */
function globToRegex(pattern) {
  if (pattern.length > 1024) throw fault('INVALID_GLOB', 'glob 模式过长');
  const glob = pattern.replace(/\\/g, '/');
  let position = 0;
  /** 递归编译花括号组并限制嵌套深度。 */
  function compile(depth = 0) {
    if (depth > 8) throw fault('INVALID_GLOB', 'glob 嵌套超过上限');
    let result = '';
    while (position < glob.length) {
      const ch = glob[position];
      if (depth && (ch === ',' || ch === '}')) break;
      position++;
      if (ch === '{') {
        const branches = [compile(depth + 1)];
        while (glob[position] === ',') { position++; branches.push(compile(depth + 1)); }
        if (glob[position++] !== '}') throw fault('INVALID_GLOB', '花括号不匹配');
        result += '(?:' + branches.join('|') + ')';
      } else if (ch === '*') {
        const segmentStart = position === 1 || glob[position - 2] === '/';
        if (segmentStart && glob[position] === '*' && (position + 1 === glob.length || glob[position + 1] === '/')) {
          position++;
          if (glob[position] === '/') { position++; result += '(?:[^/]+/)*'; }
          else result += '.*';
        } else result += '[^/]*';
      } else if (ch === '?') result += '[^/]';
      else result += escapeRegex(ch);
    }
    return result;
  }
  return new RegExp('^' + compile() + '$');
}

/** 无路径分隔符的 glob 递归匹配 basename，否则匹配相对路径。 */
function globMatcher(patterns) {
  const matchers = splitPatterns(patterns).map(pattern => {
    if (pattern.length > 1024) throw fault('INVALID_GLOB', 'glob模式过长');
    const normalized = pattern.replace(/\\/g, '/');
    return { basename: !normalized.includes('/'), alternatives: expandBraces(normalized).map(tokenizeGlob) };
  });
  return relative => !matchers.length || matchers.some(m => m.alternatives.some(tokens => matchTokens(tokens, m.basename ? relative.split('/').at(-1) : relative)));
}

/** 有上限地展开花括号；不将用户模式交给可能回溯的JS正则。 */
function expandBraces(pattern, depth = 0) {
  if (depth > 8) throw fault('INVALID_GLOB', 'glob嵌套超过上限');
  const start = pattern.indexOf('{');
  if (start < 0) return [pattern];
  let nesting = 1;
  let end = start + 1;
  while (end < pattern.length && nesting) { if (pattern[end] === '{') nesting++; if (pattern[end] === '}') nesting--; end++; }
  if (nesting) throw fault('INVALID_GLOB', '花括号不匹配');
  const branches = splitPatterns(pattern.slice(start + 1, end - 1));
  const expanded = [];
  for (const branch of branches) {
    expanded.push(...expandBraces(pattern.slice(0, start) + branch + pattern.slice(end), depth + 1));
    if (expanded.length > 64) throw fault('GLOB_LIMIT', '花括号展开超过64项');
  }
  return expanded;
}

/** 将glob转换为字面量、单字符和路径段通配token。 */
function tokenizeGlob(pattern) {
  const tokens = [];
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*' && pattern[i + 1] === '*' && (i === 0 || pattern[i - 1] === '/') && (i + 2 === pattern.length || pattern[i + 2] === '/')) {
      i++;
      if (pattern[i + 1] === '/') { i++; tokens.push({ type: 'dirs' }); }
      else tokens.push({ type: 'all' });
    } else if (ch === '*') { if (tokens.at(-1)?.type !== 'star') tokens.push({ type: 'star' }); }
    else if (ch === '?') tokens.push({ type: 'one' });
    else tokens.push({ type: 'literal', value: ch });
  }
  return tokens;
}

/** 动态规划匹配glob，复杂度有明确上限，不存在灾难性回溯。 */
function matchTokens(tokens, value) {
  if (tokens.length * value.length > 1000000) throw fault('GLOB_LIMIT', 'glob匹配超过计算预算');
  let previous = new Uint8Array(value.length + 1);
  previous[0] = 1;
  for (const token of tokens) {
    const current = new Uint8Array(value.length + 1);
    let reachable = false;
    for (let j = 0; j <= value.length; j++) {
      if (token.type === 'star' || token.type === 'all') current[j] = previous[j] || (j > 0 && current[j - 1] && (token.type === 'all' || value[j - 1] !== '/')) ? 1 : 0;
      else if (token.type === 'dirs') { current[j] = previous[j] || (j > 0 && value[j - 1] === '/' && reachable) ? 1 : 0; reachable ||= !!previous[j]; }
      else if (j > 0) current[j] = previous[j - 1] && (token.type === 'one' ? value[j - 1] !== '/' : value[j - 1] === token.value) ? 1 : 0;
    }
    previous = current;
  }
  return !!previous[value.length];
}

/** 归一行尾并记录规范化字符在原字符串中的位置。 */
function normalizeMapped(text) {
  const removed = [];
  const normalized = text.replace(/\r\n|\r/g, (match, offset) => {
    if (match.length === 2) removed.push(offset - removed.length);
    return '\n';
  });
  /** 二分计算边界之前被折叠的CRLF数量，不为每个字符保存一个整数。 */
  function map(position) {
    let low = 0;
    let high = removed.length;
    while (low < high) { const mid = (low + high) >>> 1; if (removed[mid] < position) low = mid + 1; else high = mid; }
    return position + low;
  }
  return { text: normalized, map };
}

/** 有上限地统计匹配，仅保留实际需要替换的位置。 */
function literalMatches(text, needle, ignoreCase, replaceAll) {
  const selected = [];
  let count = 0;
  for (const match of text.matchAll(new RegExp(escapeRegex(needle), ignoreCase ? 'giu' : 'gu'))) {
    if (++count > 100000) throw fault('MATCH_LIMIT', '匹配数超过十万，请缩小编辑范围');
    if (replaceAll || !selected.length) selected.push(match);
  }
  return { selected, count };
}

/** 字面量匹配始终使用原始索引；可选换行兼容，不使用变长 toLowerCase。 */
function applyLiteral(original, edit, ignoreCase = false) {
  if (!edit.oldString) throw fault('EMPTY_MATCH', 'oldString 不能为空');
  const replacement = normalizeEol(edit.newString, detectEol(original));
  let haystack = original;
  let needle = edit.oldString;
  let map = null;
  let matches = literalMatches(haystack, needle, ignoreCase, edit.replaceAll);
  if (!matches.count) {
    const normalized = normalizeMapped(original);
    haystack = normalized.text;
    map = normalized.map;
    needle = normalizeEol(needle, '\n');
    matches = literalMatches(haystack, needle, ignoreCase, edit.replaceAll);
  }
  if (!matches.count) throw fault('NO_MATCH', '未找到匹配内容；请检查空格、缩进和原文版本');
  if (edit.expectedMatches !== undefined && matches.count !== edit.expectedMatches) throw fault('MATCH_COUNT_MISMATCH', '实际匹配数与 expectedMatches 不一致', { matched: matches.count });
  const chosen = matches.selected;
  let updated = original;
  for (const match of chosen.reverse()) {
    const start = map ? map(match.index) : match.index;
    const end = map ? map(match.index + match[0].length) : match.index + match[0].length;
    updated = updated.slice(0, start) + replacement + updated.slice(end);
  }
  return { updated, matched: matches.count, replaced: chosen.length, eolAdapted: !!map };
}

module.exports = { splitPatterns, escapeRegex, globToRegex, globMatcher, applyLiteral };
