// Linux 服务入口：node src/server.js
import { createApp } from './app.js';

let app = null;
process.on('unhandledRejection', (error) => {
  app?.captureIncident(error, {
    source: 'process',
    category: 'process',
    severity: 'critical',
    code: 'UNHANDLED_REJECTION'
  });
  console.error('[未处理异常]', error);
});
process.on('uncaughtException', (error) => {
  app?.captureIncident(error, {
    source: 'process',
    category: 'process',
    severity: 'critical',
    code: 'UNCAUGHT_EXCEPTION'
  });
  console.error('[未捕获异常]', error);
  process.exit(1);
});

app = createApp();
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
