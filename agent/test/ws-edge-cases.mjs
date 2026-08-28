// 鱼塘 xechat-server WebSocket 异常输入测试 demo
// 跑法: BOT_NAME=测试X node test/ws-edge-cases.mjs
//
// 目的: 验证"直接发字符串能不能广播"的几种情况:
//   Case 1: 裸字符串 (不走 WS frame)               → 预期: 关连接
//   Case 2: 合法 WS frame 但内容不是 JSON         → 预期: 静默丢弃, 连接保持
//   Case 3: 合法 WS frame + JSON 但 action=null  → 预期: 静默丢弃
//   Case 4: 合法 WS frame + JSON 但 body=null   → 预期: 回 SYSTEM "Body is null!"
//   Case 5: 合法 WS frame + 完整 CHAT           → 预期: 全服广播 USER 消息
//
// 服务端解码规则 (来自上游代码):
//   WebSocketChannelHandler.channelRead0:
//     - 只接 TextWebSocketFrame (二进制帧忽略)
//     - JSONUtil.toBean(text, Request.class) 抛异常 → log error, 不关连接
//   RequestHandler.exec():
//     - action=null 或 HEARTBEAT → 直接 return
//     - body 为空 → 回 SYSTEM "Body is null!"
//   AbstractActionHandler.handle():
//     - user==null → 回 SYSTEM "请先登录!" + ctx.close()
//   Netty WebSocketServerProtocolHandler:
//     - 收到非 WS frame 的字节 → 协议错误 → exceptionCaught → ctx.close()
import net from 'node:net';
import crypto from 'node:crypto';
import { encodeClientText, decodeServerFrame } from '../lib/foundation/ws-client.mjs';

const HOST = '101.42.19.160';
const PORT = 33859;
const TAG = process.env.BOT_NAME || `边界测试${Math.floor(Math.random() * 100)}`;

// 共享: 通用连接 + 登录 + 接收循环
function connectAndLogin(username, onReady) {
  return new Promise((resolve) => {
    const sock = net.connect(PORT, HOST);
    const uuid = 'web-' + crypto.randomBytes(8).toString('hex');
    let buf = Buffer.alloc(0);
    let handshaked = false;
    let alive = true;
    const state = { sock, alive: () => alive, buf, msgs: [] };

    sock.on('connect', () => {
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
      state.buf = buf;

      if (!handshaked) {
        const i = buf.indexOf('\r\n\r\n');
        if (i < 0) return;
        const head = buf.slice(0, i).toString('latin1');
        buf = buf.slice(i + 4);
        if (!head.includes(' 101 ')) { console.error('[-] 握手失败'); sock.destroy(); return; }
        handshaked = true;
        sock.write(encodeClientText(JSON.stringify({
          action: 'LOGIN',
          body: { username, status: 'FISHING', platform: 'WEB', uuid, pluginVersion: '', reconnected: false },
        })));
      }

      while (true) {
        const fr = decodeServerFrame(buf);
        if (!fr) break;
        buf = buf.slice(fr.consumed);
        state.buf = buf;
        if (fr.opcode === 0x8) { alive = false; state.alive = () => alive; return; }
        if (fr.opcode !== 1) continue;
        let m; try { m = JSON.parse(fr.payload.toString('utf8')); } catch (_) { continue; }
        const t = m.type || m.action;
        if (t === 'USER_STATE' && m.body && m.body.user && m.body.user.username === username && m.body.state === 'ONLINE') {
          console.log(`[+] 已登录: ${username}`);
          resolve(state);
          if (onReady) onReady(state);
          return;
        }
        // 收集所有收到的消息
        if (t === 'SYSTEM') {
          const txt = typeof m.body === 'string' ? m.body : (m.body && m.body.content) || '';
          state.msgs.push({ t, txt: txt.split('\n')[0] });
        } else if (t === 'USER') {
          state.msgs.push({ t, who: m.user && m.user.username, txt: m.body && m.body.content });
        }
      }
    });

    sock.on('error', () => { alive = false; state.alive = () => alive; });
    sock.on('close', () => { alive = false; state.alive = () => alive; });
  });
}

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function runCase1() {
  console.log('\n══════ Case 1: 发送裸字符串 (不走 WS frame) ══════');
  console.log('  代码路径: Netty WebSocketServerProtocolHandler 协议错误');
  console.log('  预期: 服务端关连接');
  let done;
  const p = new Promise((r) => { done = r; });
  await connectAndLogin(TAG + '_c1', async (st) => {
    await sleep(500);
    console.log('  → 发送: hello everyone (裸字符串)');
    st.sock.write('hello everyone');
    await sleep(1500);
    console.log(`  结果: ${st.alive() ? '⚠️ 连接仍存活' : '✅ 连接已断 (服务端踢了)'}`);
    try { st.sock.destroy(); } catch (_) {}
    done();
  });
  await p;
  await sleep(500);
}

async function runCases2to5() {
  console.log('\n══════ Case 2-5: 同一连接跑 4 种边界输入 ══════');
  const st = await connectAndLogin(TAG + '_c25');
  await sleep(800);

  // Case 2
  console.log('\n[Case 2] 合法 WS frame 但内容不是 JSON: "hello"');
  console.log('  预期: JSONUtil.toBean 抛异常 → log error, 不关, 不广播');
  const msgsBefore = st.msgs.length;
  st.sock.write(encodeClientText('hello'));
  await sleep(800);
  console.log(`  结果: ${st.alive() ? '✅ 连接保持' : '❌ 连接被关'}; 收到新消息 ${st.msgs.length - msgsBefore} 条`);

  // Case 3
  console.log('\n[Case 3] 合法 WS frame + JSON 但 action=null: {}');
  console.log('  预期: RequestHandler.exec() 直接 return');
  const msgs3b = st.msgs.length;
  st.sock.write(encodeClientText('{}'));
  await sleep(500);
  console.log(`  结果: ${st.alive() ? '✅ 连接保持' : '❌ 连接被关'}; 收到新消息 ${st.msgs.length - msgs3b} 条`);

  // Case 4
  console.log('\n[Case 4] 合法 WS frame + JSON 但 body=null: {"action":"CHAT"}');
  console.log('  预期 (已登录): 回 SYSTEM "Body is null!"');
  const msgs4b = st.msgs.length;
  st.sock.write(encodeClientText('{"action":"CHAT"}'));
  await sleep(800);
  const c4new = st.msgs.slice(msgs4b);
  console.log(`  结果: ${st.alive() ? '✅ 连接保持' : '❌ 连接被关'}; 收到新消息 ${c4new.length} 条: ${c4new.map((m) => `[${m.t}] ${m.txt || m.who}`).join(', ')}`);

  // Case 5
  console.log('\n[Case 5] 完整 CHAT (应全服广播)');
  const msgs5b = st.msgs.length;
  st.sock.write(encodeClientText(JSON.stringify({
    action: 'CHAT',
    body: { content: `🧪 ${TAG}_c25 边界测试 5: 全服广播应可见`, msgType: 'TEXT', toUsers: null },
  })));
  await sleep(1500);
  const c5new = st.msgs.slice(msgs5b);
  console.log(`  结果: ${st.alive() ? '✅ 连接保持' : '❌ 连接被关'}; 收到新消息 ${c5new.length} 条: ${c5new.map((m) => `[${m.t}] ${m.txt || m.who}`).join(' | ')}`);

  try { st.sock.destroy(); } catch (_) {}
}

(async () => {
  console.log(`🐟 边界测试 (连接到 ${HOST}:${PORT})`);
  await runCase1();
  await runCases2to5();
  console.log('\n══ 测试结束 ══');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });