// 鱼塘 xechat-server WebSocket 直接连接 demo —— 零 npm 依赖
//
// 跑法:
//   node test/ws-direct-connect.mjs                 # 用默认参数 (101.42.19.160:33859, 大黄鱼)
//   BOT_NAME="测试小明" node test/ws-direct-connect.mjs  # 自定义昵称
//
// 这个脚本只 import lib/foundation/ws-client.mjs 里的 encodeClientText / decodeServerFrame
// 两个纯函数 (无副作用), 不依赖 WsClient 类, 用 node:net + 手写 WS 握手直接连。
// 演示: TCP 直连 → WS Upgrade → LOGIN → 收 ONLINE_USERS → 收 SYSTEM 欢迎 → 发 CHAT → HEARTBEAT → 退出。
import net from 'node:net';
import crypto from 'node:crypto';
import { encodeClientText, decodeServerFrame } from '../lib/foundation/ws-client.mjs';

// —— 1. 配置 (改成你环境实际地址) ——
const HOST = '101.42.19.160';
const PORT = 33859;                // WS 通道端口 (Netty server P+1)
const USERNAME = process.env.BOT_NAME || `直连测试${Math.floor(Math.random() * 100)}`;
const STATUS = 'FISHING';
const RUN_MS = 12_000;             // demo 跑多久自动退出
const HEARTBEAT_MS = 25_000;

// —— 2. TCP 直连 + WS Upgrade ——
const sock = net.connect(PORT, HOST);
const uuid = 'web-' + crypto.randomBytes(8).toString('hex');
let buf = Buffer.alloc(0);
let handshaked = false;
let loggedIn = false;
let msgCount = 0;

sock.on('connect', () => {
  console.log(`[+] TCP 已连 ${HOST}:${PORT}`);
  // RFC6455: 客户端必须发送 Sec-WebSocket-Key, 服务端用 magic GUID 计算 Accept 回回 (这里只校验 101)
  const key = crypto.randomBytes(16).toString('base64');
  sock.write(
    `GET /xechat HTTP/1.1\r\n` +
    `Host: ${HOST}:${PORT}\r\n` +
    `Upgrade: websocket\r\n` +
    `Connection: Upgrade\r\n` +
    `Sec-WebSocket-Key: ${key}\r\n` +
    `Sec-WebSocket-Version: 13\r\n\r\n`
  );
});

sock.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);

  // —— 2.1 握手响应: 直到 \r\n\r\n
  if (!handshaked) {
    const i = buf.indexOf('\r\n\r\n');
    if (i < 0) return;
    const head = buf.slice(0, i).toString('latin1');
    buf = buf.slice(i + 4);
    if (!head.includes(' 101 ')) {
      console.error(`[-] WS 握手失败: ${head.split('\r\n')[0]}`);
      sock.destroy();
      return;
    }
    handshaked = true;
    console.log('[+] WS 握手成功, 发送 LOGIN');

    // —— 2.2 登录 (LoginDTO, 参考 ws-protocol.md §5)
    const login = {
      action: 'LOGIN',
      body: {
        username: USERNAME,
        status: STATUS,
        platform: 'WEB',                     // IDEA/WEB/COMMAND
        uuid,
        pluginVersion: '',                  // WEB 平台不比对版本, 留空
        reconnected: false,
      },
    };
    sock.write(encodeClientText(JSON.stringify(login)));
  }

  // —— 2.3 解析服务端帧 (参考 ws-client.mjs decodeServerFrame)
  while (true) {
    const fr = decodeServerFrame(buf);
    if (!fr) break;
    buf = buf.slice(fr.consumed);

    if (fr.opcode === 0x8) {                 // close 帧
      console.log('[-] 服务端主动关闭');
      sock.destroy(); return;
    }
    if (fr.opcode !== 1) continue;           // 非文本帧跳过

    let m;
    try { m = JSON.parse(fr.payload.toString('utf8')); }
    catch (_) { continue; }
    msgCount++;
    const t = m.type || m.action;
    const u = m.user && m.user.username;

    // —— 2.4 关键事件识别 ——
    if (t === 'ONLINE_USERS') {
      const list = (m.body && m.body.userList) || [];
      console.log(`[+] ONLINE_USERS (${list.length} 人): ${list.slice(0, 5).map((x) => x.username).join(', ')}${list.length > 5 ? '…' : ''}`);
      if (!loggedIn) {
        loggedIn = true;
        // 演示: 登录后 1 秒发一条 CHAT 消息到公共聊天
        setTimeout(() => {
          const chat = { action: 'CHAT', body: { content: `你好, 我是 ${USERNAME}, 通过原生 net.connect 直连 ws (无第三方 ws 库)`, msgType: 'TEXT', toUsers: null } };
          sock.write(encodeClientText(JSON.stringify(chat)));
          console.log('[→] 已发 CHAT');
        }, 1000);
      }
    } else if (t === 'SYSTEM') {
      const txt = typeof m.body === 'string' ? m.body : (m.body && m.body.content) || '';
      console.log(`[SYS] ${txt.split('\n')[0]}`);
      if (/欢迎/.test(txt)) console.log(`[+] 收到欢迎语, 视为已上线`);
      if (/黑名单|重复|不合法|为空|未获取|禁言|拒绝/.test(txt)) {
        console.error(`[!] 登录被拒, 退出`);
        sock.destroy(); return;
      }
    } else if (t === 'USER' && u !== USERNAME) {
      // 别人聊天 (过滤掉自己的回显)
      const txt = typeof m.body === 'object' ? m.body.content : m.body;
      console.log(`[${u}] ${txt}`);
    } else if (t === 'USER_STATE') {
      const who = u || '?';
      const state = m.body && m.body.state;
      console.log(`[*] ${who} ${state === 'ONLINE' ? '上线' : '离线'}`);
    } else if (t === 'STATUS_UPDATE') {
      console.log(`[*] ${u} 状态 → ${m.user && m.user.status}`);
    } else if (t === 'GAME_ROOM_CREATED') {
      console.log(`[GAME] 房间已创建: ${m.body && m.body.id} (${m.body && m.body.game})`);
    } else {
      console.log(`[?] type=${t}, body=${JSON.stringify(m.body).slice(0, 80)}`);
    }
  }
});

sock.on('error', (e) => console.error(`[-] socket error: ${e.code || e.message}`));
sock.on('close', () => console.log(`[-] socket 关闭, 共收到 ${msgCount} 条消息`));

// —— 3. 心跳 (HEARTBEAT 服务端不回包, 单纯续期) ——
const hb = setInterval(() => {
  if (!sock.destroyed) {
    sock.write(encodeClientText(JSON.stringify({ action: 'HEARTBEAT' })));
  }
}, HEARTBEAT_MS);

// —— 4. demo 限时 ——
setTimeout(() => {
  console.log(`[*] ${RUN_MS / 1000}s 到, 主动断开`);
  clearInterval(hb);
  // 发送 close 帧 (0x88 + 0x00 长度 + 掩码)
  const mask = crypto.randomBytes(4);
  sock.write(Buffer.concat([Buffer.from([0x88, 0x80]), mask]));
  sock.destroy();
}, RUN_MS);