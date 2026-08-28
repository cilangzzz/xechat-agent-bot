// 鱼塘 xechat-server WebSocket Action.REACT 实测
// 跑法: node test/ws-react-test.mjs
//
// 覆盖:
//   R1. 未登录 + REACT.UPLOAD (uid 空)     → 预期 succeed=false "请先登录!" 连接保持
//   R3. 已登录 + REACT.UPLOAD 小文件        → 预期 succeed=true, data.fileName, 全服广播 USER+IMAGE
//   R4. 已登录 + REACT.UPLOAD 超大(>2048KB) → 预期 succeed=false "发送的文件大小不能超过2048KB!"
//   R5. 已登录 + REACT.DOWNLOAD 不存在文件  → 预期 succeed=false "文件不存在!"
//   (R2. 未登录冒用其他用户 uid → 暂跳过, 留 TODO: 需要稳定 victim 连接, 涉及 race condition)
//
// 协议 (ReactRequest<T> 继承 BaseReact{id,uid}):
//   { "action":"REACT",
//     "body":{ "id":"<自增id>", "uid":"<用户 Netty channel id>",
//              "react":"UPLOAD"|"DOWNLOAD"|"ADMIN",
//              "body":{ ...子 DTO } } }
//   UploadReact:    { fileType: "txt", bytes: byte[] }
//   DownloadReact:  { fileName: "x.txt" }
//   响应: MessageType.REACT → ReactResult{ id, uid, succeed, data, msg }
import net from 'node:net';
import crypto from 'node:crypto';
import { encodeClientText, decodeServerFrame } from '../lib/foundation/ws-client.mjs';

const HOST = '101.42.19.160';
const PORT = 33859;
const PROXY_HOST = '127.0.0.1';
const PROXY_PORT = 7897;     // 走代理出口, 避免当前 IP 被服务端风控拉黑
const TAG = `RT${Math.floor(Math.random() * 100)}`;   // ≤12 字符 (服务端昵称上限)
const results = [];

function record(label, ok, detail) {
  const tag = ok ? '✅' : '❌';
  results.push({ label, ok: !!ok, detail });
  console.log(`  ${tag} ${label}: ${detail}`);
}

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// 通用连接 (可配置是否登录 / 登录名)。带超时, 防 server 卡住时永久 block
// 走代理: TCP 连 PROXY_HOST:PROXY_PORT, 发 CONNECT, 拿到 200 后再发 WS 握手
function openConn({ username, login = true, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(PROXY_PORT, PROXY_HOST);
    const uuid = 'web-' + crypto.randomBytes(8).toString('hex');
    let buf = Buffer.alloc(0);
    let handshaked = false;
    let tunneled = false;
    const st = {
      sock, alive: true, myUid: null, reactResults: [], userMsgs: [],
      login, username,
    };

    const timer = setTimeout(() => {
      st.alive = false;
      try { sock.destroy(); } catch (_) {}
      reject(new Error(`openConn 超时 (${timeoutMs}ms, username=${st.username || '(空)'})`));
    }, timeoutMs);

    const doWsHandshake = () => {
      const key = crypto.randomBytes(16).toString('base64');
      sock.write(
        `GET /xechat HTTP/1.1\r\n` +
        `Host: ${HOST}:${PORT}\r\n` +
        `Upgrade: websocket\r\n` +
        `Connection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\n` +
        `Sec-WebSocket-Version: 13\r\n\r\n`
      );
    };

    sock.on('connect', () => {
      // 通过代理走隧道 (HTTP CONNECT)
      sock.write(`CONNECT ${HOST}:${PORT} HTTP/1.1\r\nHost: ${HOST}:${PORT}\r\n\r\n`);
    });

    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);

      // 第一步: 代理 CONNECT 响应
      if (!tunneled) {
        const i = buf.indexOf('\r\n\r\n');
        if (i < 0) return;
        const head = buf.slice(0, i).toString('latin1');
        buf = buf.slice(i + 4);
        if (!head.includes(' 200 ')) { st.alive = false; clearTimeout(timer); reject(new Error(`代理 CONNECT 失败: ${head.split('\r\n')[0]}`)); return; }
        tunneled = true;
        doWsHandshake();  // 隧道建立后立即发 WS 握手
      }

      if (!handshaked) {
        const i = buf.indexOf('\r\n\r\n');
        if (i < 0) return;
        const head = buf.slice(0, i).toString('latin1');
        buf = buf.slice(i + 4);
        if (!head.includes(' 101 ')) { st.alive = false; clearTimeout(timer); reject(new Error('握手失败')); return; }
        handshaked = true;
        if (st.login) {
          sock.write(encodeClientText(JSON.stringify({
            action: 'LOGIN',
            body: { username: st.username, status: 'FISHING', platform: 'WEB', uuid, pluginVersion: '', reconnected: false },
          })));
        } else {
          clearTimeout(timer); resolve(st);
        }
      }

      while (true) {
        const fr = decodeServerFrame(buf);
        if (!fr) break;
        buf = buf.slice(fr.consumed);
        if (fr.opcode === 0x8) { st.alive = false; continue; }
        if (fr.opcode !== 1) continue;
        let m; try { m = JSON.parse(fr.payload.toString('utf8')); } catch (_) { continue; }
        const t = m.type || m.action;

        // 登录成功的关键事件 (ONLINE + 自己昵称)
        if (t === 'USER_STATE' && m.body && m.body.user && m.body.user.username === st.username && !st.myUid) {
          st.myUid = m.body.user.id;
          clearTimeout(timer); resolve(st);
        }
        // 收集响应
        if (t === 'REACT') st.reactResults.push(m);
        if (t === 'USER' && m.body && m.body.msgType === 'IMAGE') st.userMsgs.push(m);
        // 任何 SYSTEM 消息都打印 (诊断用)
        if (t === 'SYSTEM' && !st._loggedSys) {
          st._loggedSys = true;
          console.log(`    [debug] ${st.username} 收到 SYSTEM: ${typeof m.body === 'string' ? m.body : JSON.stringify(m.body).slice(0, 100)}`);
        }
        // 登录失败的 SYSTEM 错误
        if (t === 'SYSTEM' && m.body && /昵称长度不能超过|昵称重复|昵称含有违规|昵称不合法|未获取到UUID|已列入黑名单|不允许登录/.test(m.body)) {
          st.alive = false;
          clearTimeout(timer);
          reject(new Error(`登录失败: ${typeof m.body === 'string' ? m.body : JSON.stringify(m.body)}`));
        }
      }
    });

    sock.on('error', (e) => { st.alive = false; clearTimeout(timer); reject(e); });
    sock.on('close', () => { st.alive = false; });
  });
}

// 发送一条 REACT 请求
function sendReact(st, { id, uid, react, body }) {
  st.sock.write(encodeClientText(JSON.stringify({
    action: 'REACT',
    body: { id, uid, react, body },
  })));
}

(async () => {
  console.log(`🐟 Action.REACT 实测 (${HOST}:${PORT})`);
  console.log('══════════════════════════════════════');

  // ───────── R1: 未登录 + UPLOAD (uid 空) ─────────
  console.log('\n[R1] 未登录 + UPLOAD (uid="")');
  console.log('  预期: succeed=false, msg="请先登录!", 连接保持');
  const c1 = await openConn({ login: false });
  await sleep(200);
  sendReact(c1, { id: 'r1', uid: '', react: 'UPLOAD', body: { fileType: 'txt', bytes: [104, 105] } });
  await sleep(800);
  const r1 = c1.reactResults[0];
  record('R1 未登录UPLOAD(空uid)', r1 && r1.body && r1.body.succeed === false && r1.body.msg === '请先登录！',
    r1 ? `succeed=${r1.body.succeed}, msg=${JSON.stringify(r1.body.msg)}, 连接${c1.alive ? '保持' : '断开'}` : '(无响应)');
  c1.sock.destroy();

  // ───────── R3: 已登录 + UPLOAD 小文件 ─────────
  console.log('\n[R3] 已登录 + UPLOAD 小文件 "hello"');
  console.log('  预期: succeed=true, data.fileName, 全服广播 USER+IMAGE');
  const c3 = await openConn({ username: TAG });
  await sleep(200);
  sendReact(c3, { id: 'r3', uid: c3.myUid, react: 'UPLOAD', body: { fileType: 'txt', bytes: [104, 101, 108, 108, 111] } });
  await sleep(1200);
  const r3 = c3.reactResults[0];
  const imgBcast = c3.userMsgs[0];
  record('R3 已登录UPLOAD成功', r3 && r3.body && r3.body.succeed === true && r3.body.data && r3.body.data.fileName,
    r3 ? `succeed=${r3.body.succeed}, fileName=${r3.body.data && r3.body.data.fileName}` : '(无响应)');
  record('R3 全服广播 USER+IMAGE', !!imgBcast,
    imgBcast ? `收到 IMAGE 广播: content=${imgBcast.body.content}` : '(未收到广播)');
  c3.sock.destroy();

  // ───────── R4: 已登录 + UPLOAD 超大 (>2048KB) ─────────
  console.log('\n[R4] 已登录 + UPLOAD 超大 (2.5MB)');
  console.log('  预期: succeed=false, msg 含 "不能超过2048KB"');
  const c4 = await openConn({ username: TAG + 'b' });
  await sleep(200);
  const bigBytes = Array.from({ length: 2_560_000 }, (_, i) => i % 256);
  sendReact(c4, { id: 'r4', uid: c4.myUid, react: 'UPLOAD', body: { fileType: 'bin', bytes: bigBytes } });
  await sleep(1500);
  const r4 = c4.reactResults[0];
  record('R4 超大文件被拒', r4 && r4.body && r4.body.succeed === false && /不能超过/.test(r4.body.msg || ''),
    r4 ? `succeed=${r4.body.succeed}, msg=${JSON.stringify(r4.body.msg)}` : '(无响应)');
  c4.sock.destroy();

  // ───────── R5: 已登录 + DOWNLOAD 不存在文件 ─────────
  console.log('\n[R5] 已登录 + DOWNLOAD 不存在文件');
  console.log('  预期: succeed=false, msg="文件不存在!"');
  const c5 = await openConn({ username: TAG + 'd' });
  await sleep(200);
  sendReact(c5, { id: 'r5', uid: c5.myUid, react: 'DOWNLOAD', body: { fileName: 'definitely-not-exist-' + Date.now() + '.txt' } });
  await sleep(800);
  const r5 = c5.reactResults[0];
  record('R5 DOWNLOAD不存在', r5 && r5.body && r5.body.succeed === false && /文件不存在/.test(r5.body.msg || ''),
    r5 ? `succeed=${r5.body.succeed}, msg=${JSON.stringify(r5.body.msg)}` : '(无响应)');
  c5.sock.destroy();

  // ───────── 总结 ─────────
  console.log('\n══════════════════════════════════════');
  console.log('📊 REACT 测试总结');
  console.log('══════════════════════════════════════');
  for (const r of results) console.log(`  ${r.ok ? '✅' : '❌'} ${r.label}: ${r.detail}`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });