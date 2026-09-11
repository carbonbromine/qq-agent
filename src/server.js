// headless 入口：node src/server.js（不带 Electron 窗口，浏览器访问控制台）
import { createApp } from './app.js';

process.on('unhandledRejection', (error) => console.error('[未处理异常]', error));
process.on('uncaughtException', (error) => {
  console.error('[未捕获异常]', error);
  process.exit(1);
});

const app = createApp();
app.start().catch((error) => {
  console.error('[启动失败]', error);
  process.exit(1);
});

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => process.exit(1), 25000);
  deadline.unref();
  try { await app.stop(); process.exit(0); }
  catch (error) { console.error(error); process.exit(1); }
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
