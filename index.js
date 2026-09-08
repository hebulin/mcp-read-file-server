#!/usr/bin/env node
/** MCP stdio入口，导入模块不启动服务，工具实现位于lib。 */
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { createServer } = require('./lib/server');
const { stop } = require('./lib/regex');
/** 连接stdio，并在连接关闭时释放正则线程。 */
async function main() {
  const { server } = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  server.server.onclose = () => stop();
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main, createServer };
