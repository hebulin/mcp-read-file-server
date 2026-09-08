/** 检查生产/测试JavaScript语法和发布入口LF行尾，不执行功能测试。 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
/** 遍历源码目录并收集JavaScript文件。 */
function collect(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? collect(full) : /\.(js|cjs)$/.test(entry.name) ? [full] : [];
  });
}
const files = [path.join(root, 'index.js'), ...['lib', 'scripts', 'test'].filter(dir => fs.existsSync(path.join(root, dir))).flatMap(dir => collect(path.join(root, dir)))];
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) process.exit(1);
  if (fs.readFileSync(file, 'utf8').includes('\r')) throw new Error('源码必须使用LF: ' + file);
}
console.log('语法和LF检查通过，共 ' + files.length + ' 个文件');
