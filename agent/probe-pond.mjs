// 跨鱼塘探测: 连接目标鱼塘 WS 端口, 用一次性昵称登录, 抓 ONLINE_USERS 后立即断开
// 用法: node probe-pond.mjs <host> [port] [--proxy]
//   默认 port=33859, 默认直连; --proxy 走 127.0.0.1:7897
// 说明: 登录即被服务端推送完整在线列表(ws-protocol.md §5.3), 拿完即走, 不发言。
import { WsClient } from './lib/ws-client.mjs';

const target = process.argv[2] || 'lesscoding.net';
const port = parseInt(process.argv[3] || '33859', 10);
const viaProxy = process.argv.includes('--proxy');
// 一次性访客昵称(≤12字符, 不重复、不含敏感词即通过校验)
const username = '巡塘员' + Math.floor(Math.random() * 90 + 10);

const client = new WsClient({
  host: target,
  port,
  proxy: { host: '127.0.0.1', port: 7897 },
  direct: !viaProxy,
  username,
  status: 'FISHING',
  heartbeatMs: 25000,
  staleTimeoutMs: 90000,
  replaySkipMs: 2000,
  cmdPrefix: '/x',
  log: (s) => console.log(s),
});

let finished = false;
const finish = (code = 0) => {
  if (finished) return;
  finished = true;
  try { client.stop(); } catch (e) {}
  setTimeout(() => process.exit(code), 300);
};

client.onMessage = (m) => {
  const t = m.type || m.action;
  if (t === 'ONLINE_USERS' && m.body && Array.isArray(m.body.userList)) {
    const list = m.body.userList;
    console.log('=== ONLINE_USERS ===');
    console.log('count:', list.length);
    for (const u of list) {
      console.log(`- ${u.username} | ${u.status} | region=${u.shortRegion || '-'} | role=${u.role || 'USER'}`);
    }
    finish(0);
  } else if (t === 'SYSTEM') {
    const txt = typeof m.body === 'string' ? m.body : (m.body && m.body.content) || '';
    console.log('[SYS]', txt.split('\n')[0]);
  } else if (t === 'HISTORY_MSG') {
    const n = Array.isArray(m.body?.msgList) ? m.body.msgList.length : 0;
    console.log(`[HISTORY] ${n} msgs`);
  } else if (t === 'USER_STATE') {
    const u = m.body?.user;
    if (u && u.username === username) console.log(`[LOGIN-OK] self online, waiting ONLINE_USERS...`);
  } else if (t !== 'USER' && t !== 'HEARTBEAT') {
    console.log(`[MSG:${t}]`, JSON.stringify(m).slice(0, 300));
  }
};

client.runOnce().then((why) => {
  console.log('disconnected:', why);
  finish(why === 'stopped' ? 0 : 1);
});

setTimeout(() => {
  if (!finished) { console.log('TIMEOUT: no ONLINE_USERS within 15s'); finish(1); }
}, 15000);
