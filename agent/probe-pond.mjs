// 跨鱼塘探测 CLI (诊断/验证用): 复用 lib/pond-probe.mjs 的 probePond
// 用法: node probe-pond.mjs <host> [port] [--proxy] [--history N]
//   默认 port=33859, 默认直连; --proxy 走 127.0.0.1:7897
import { probePond } from './lib/platform/pond-probe.mjs';

const host = process.argv[2];
if (!host) { console.log('用法: node probe-pond.mjs <host> [port] [--proxy] [--history N]'); process.exit(1); }
const port = parseInt(process.argv[3], 10) || 33859;
const viaProxy = process.argv.includes('--proxy');
const hi = process.argv.indexOf('--history');
const history = hi >= 0 ? parseInt(process.argv[hi + 1], 10) || 0 : 0;

const r = await probePond({
  host, port, viaProxy,
  proxy: { host: '127.0.0.1', port: 7897 },
  history,
  log: (s) => console.log(s),
});

if (r.error) {
  console.log('✗', r.error);
  process.exit(1);
}
console.log(`=== ${r.host}:${r.port} 在线用户 ===`);
console.log('count:', r.online_count);
for (const u of r.online_users) console.log(`- ${u.username} | ${u.status} | region=${u.region} | role=${u.role}`);
if (r.history_messages && r.history_messages.length) {
  console.log('=== 最近聊天 ===');
  for (const m of r.history_messages.slice(-10)) console.log(`[${m.from}] ${m.content}`);
}
