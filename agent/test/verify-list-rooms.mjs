// list_rooms 真实环境验证: 监听 GAME_ROOM_CREATED / ROOM_CLOSE 全服广播
// 验证: 活动房间订阅能正确反映外部用户的房间创建/关闭
// 用法: node test/verify-list-rooms.mjs [host] [port] [durationSec]
import { WsClient } from '../lib/ws-client.mjs';
import { createRegistry } from '../lib/tools.mjs';
import { Router } from '../lib/router.mjs';
import { SessionStore } from '../lib/sessions.mjs';
import { XechatApi } from '../lib/xechat-api.mjs';
import { createLlm } from '../lib/llm.mjs';

const HOST = process.argv[2] || 'lesscoding.net';
const PORT = parseInt(process.argv[3] || '33859', 10);
const DUR = parseInt(process.argv[4] || '20', 10); // 监听秒数

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const abort = new Promise((_, rej) => setTimeout(() => rej(new Error('global timeout')), (DUR + 15) * 1000));
  const main = (async () => {
    const name = 'lsr_' + Date.now().toString(36).slice(-5);
    const ws = new WsClient({
      host: HOST, port: PORT,
      proxy: { host: '127.0.0.1', port: 0 }, direct: true,
      username: name, status: 'FISHING', cmdPrefix: '/x',
      heartbeatMs: 25000, staleTimeoutMs: 90000, replaySkipMs: 2000,
      logToConsole: false,
    });
    const pond = { onlineUsers: new Set(), snapshotAt: Date.now(), activeRooms: new Map() };
    let loggedIn = false;
    ws.onMessage = (m) => {
      const t = m.action || m.type, b = m.body || {};
      // 复用 agent.mjs 里的订阅逻辑
      if (t === 'USER_STATE' && b.state === 'ONLINE' && b.user && b.user.username === name && !loggedIn) loggedIn = true;
      if (t === 'GAME_ROOM_CREATED' && b.id) pond.activeRooms.set(b.id, { roomId: b.id, game: b.game, nums: b.nums, gameMode: b.gameMode, homeowner: b.homeowner && b.homeowner.username, createdAt: Date.now() });
      if (t === 'GAME_ROOM' && b.msgType === 'ROOM_CLOSE' && b.roomId) pond.activeRooms.delete(b.roomId);
    };
    ws.runOnce().catch(() => {});
    const t0 = Date.now();
    while (Date.now() - t0 < 8000 && !loggedIn) await sleep(80);
    if (!loggedIn) throw new Error('登录超时');
    console.log(`[+] 监听者 ${name} 已登录`);
    const init = pond.activeRooms.size;

    // 让监听者自己也开几个房间,验证 list_rooms 计入自己开的
    const llm = createLlm({ apiKey: 'k', base: 'https://fake', model: 'm', timeoutMs: 100, maxTokens: 10, temperature: 1, mock: true, maxToolIterations: 1 });
    const reg = createRegistry({
      startTime: Date.now(), pondState: pond, sessions: new SessionStore({}),
      api: new XechatApi({ base: 'https://dld.lesscoding.net', timeoutMs: 5000 }),
      python: { cmd: 'python', timeoutMs: 1000 }, web: { enabled: false }, skills: { enabled: true }, todo: { maxItems: 20 },
      ws,
    });
    const router = new Router({
      cfg: { cmdPrefix: '/x', username: name, python: { cmd: 'python', timeoutMs: 1000 }, web: { enabled: false }, adopt: { enabled: false } },
      sessions: new SessionStore({}), pondState: pond, startTime: Date.now(),
      api: new XechatApi({ base: 'https://dld.lesscoding.net', timeoutMs: 5000 }), ws,
    }).bindLlm(llm);

    console.log(`[*] 持续监听 ${DUR}s, 同时创建 3 个房间 + 关闭 2 个...`);
    // 主动创建 3 个房间,等回包,再关闭 2 个
    const myIds = [];
    for (let i = 0; i < 3; i++) {
      try {
        const reply = await router.handle({ from: 'tester', text: `/x create-room 五子棋 ${2 + i}`, isLive: true, onThinking: () => {} });
        const m = reply.match(/id=(\d+)/);
        if (m) myIds.push(m[1]);
      } catch (_) {}
    }
    console.log(`[+] 监听者创建 ${myIds.length} 个房间: ${myIds.join(', ')}`);
    await sleep(500);

    // 关闭 2 个
    for (let i = 0; i < 2; i++) {
      const id = myIds.shift();
      if (id) await router.handle({ from: 'tester', text: `/x close-room ${id}`, isLive: true, onThinking: () => {} });
    }

    // 等外部活动 (监听其他用户的创建/关闭)
    console.log(`[*] 现在监听外部活动 ${DUR}s (其它用户创建/关闭的房间会进 activeRooms)...`);
    await sleep(DUR * 1000);

    const r = await reg.dispatch('list_rooms', {});
    console.log('\n===== 最终 list_rooms 结果 =====');
    console.log(`活动房间总数: ${r.total} (开局=${init}, 现=${pond.activeRooms.size})`);
    console.log(`按游戏: ${Object.entries(r.byGame).map(([g, n]) => `${g}=${n}`).join(' · ') || '(无)'}`);
    if (r.rooms.length) {
      console.log('前 10 个:');
      for (const it of r.rooms.slice(0, 10)) {
        console.log(`  ${it.roomId} · ${it.game}${it.gameMode ? `(${it.gameMode})` : ''} · ${it.nums}人 · 房主=${it.homeowner || '?'} · ${it.ageSec}s前`);
      }
    }

    // 用 router rooms 指令渲染一遍
    const reply = await router.handle({ from: 'tester', text: '/x rooms 5', isLive: true, onThinking: () => {} });
    console.log('\n===== /x rooms 指令输出 =====');
    console.log(reply);

    try { ws.stop(); } catch (_) {}
    process.exit(0);
  })();

  try {
    await Promise.race([main, abort]);
  } catch (e) {
    console.error('异常:', e.message || e);
    process.exit(2);
  }
})();