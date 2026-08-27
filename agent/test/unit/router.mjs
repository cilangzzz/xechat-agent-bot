// agent 测试 —— Router 路由 / 多智能体指令 / 游戏房间 (fake WS) / list_rooms
import { createRegistry } from '../../../lib/business/tools/index.mjs';
import { Router } from '../../../lib/business/router.mjs';
import { SessionStore } from '../../../lib/business/sessions.mjs';
import { XechatApi } from '../../../lib/platform/xechat-api.mjs';
import { check } from './_state.mjs';
import { fakeApiFetch } from './_fixtures.mjs';

export async function run() {
  // —— 4. Router: 确定性命令 / LLM 兜底 / 多智能体指令 ——
  console.log('[4] Router 路由/多智能体');
  {
    const pondState = { onlineUsers: new Set(['x1']) };
    const sessions = new SessionStore({ historyMax: 5 });
    const api = new XechatApi({ base: 'https://fake', fetchFn: fakeApiFetch });
    const router = new Router({
      cfg: { cmdPrefix: '/小黄鱼', python: { cmd: 'python', timeoutMs: 10000 } },
      sessions, pondState, startTime: Date.now(), api,
    }).bindLlm({
      agentTurn: async () => '【LLM回答】',
      agentRun: async ({ agentName }) => ({ agent: agentName, result: '调研/计算结论' }),
    });
    const rPing = await router.handle({ from: 'u1', text: '/小黄鱼 ping' });
    check('内置命令 ping', rPing === 'pong 🎣');
    const rStats = await router.handle({ from: 'u1', text: '/小黄鱼 stats' });
    check('内置命令 stats 引用 pondState', /在线 1 人/.test(rStats));
    const rGames = await router.handle({ from: 'u1', text: '/小黄鱼 games' });
    check('内置命令 games 走 API', /demo/.test(rGames) && /演示/.test(rGames));
    const rGameDetail = await router.handle({ from: 'u1', text: '/小黄鱼 game demo' });
    check('内置命令 game <名字> 带参', /【demo\(演示\)】/.test(rGameDetail) && /播放: http:\/\/demo/.test(rGameDetail));
    const rFree = await router.handle({ from: 'u1', text: '/小黄鱼 今天几号' });
    check('自由文本走 main agent', rFree === '【LLM回答】');
    const rExplore = await router.handle({ from: 'u1', text: '/小黄鱼 explore 今天天气' });
    check('explore 指令委派子智能体', rExplore === '调研/计算结论', rExplore);
    const rMath = await router.handle({ from: 'u1', text: '/小黄鱼 math 6*7' });
    check('math 指令 python 计算', rMath === '= 42', `实际: ${rMath}`);
    const rTodo = await router.handle({ from: 'u1', text: '/小黄鱼 todo 添加 买菜' });
    check('todo 指令添加', /买菜/.test(rTodo));
    const rTodoList = await router.handle({ from: 'u1', text: '/小黄鱼 todo 显示' });
    check('todo 指令显示', /买菜/.test(rTodoList));
    const rSkills = await router.handle({ from: 'u1', text: '/小黄鱼 skills' });
    check('skills 指令列出技能', /report/.test(rSkills) && /explain/.test(rSkills));
    check('会话已记录(仅 LLM 文本进上下文, 内置命令不进)', sessions.get('u1').history.length === 2);
  }

  // —— 4b. 游戏房间: create-room / close-room 走 fake WS ——
  console.log('[4b] game room 指令(fake WS)');
  {
    const sent = [];
    const fakeWs = {
      sendAction(action, body) { sent.push({ action, body }); },
      sendActionAndWait(action, body, { match, timeoutMs = 8000 } = {}) {
        return new Promise((resolve, reject) => {
          const w = { match, resolve, reject, timer: null, done: false };
          w.timer = setTimeout(() => {
            if (w.done) return;
            w.done = true;
            const i = fakeWs._waiters.indexOf(w);
            if (i >= 0) fakeWs._waiters.splice(i, 1);
            reject(new Error('timeout: ' + action));
          }, timeoutMs);
          fakeWs._waiters.push(w);
          try { fakeWs.sendAction(action, body); } catch (e) {
            if (w.done) return;
            w.done = true;
            clearTimeout(w.timer);
            const i = fakeWs._waiters.indexOf(w);
            if (i >= 0) fakeWs._waiters.splice(i, 1);
            reject(e);
          }
        });
      },
      _feed(m) {
        const t = m.action || m.type;
        const body = m.body || {};
        for (let i = 0; i < this._waiters.length; i++) {
          const w = this._waiters[i];
          let hit = false;
          try { hit = !!w.match(m, t, body); } catch (e) { hit = false; }
          if (hit) {
            w.done = true;
            clearTimeout(w.timer);
            this._waiters.splice(i, 1);
            w.resolve({ msg: m, type: t });
            return;
          }
        }
      },
      _waiters: [],
    };

    const reg = createRegistry({
      startTime: Date.now(),
      pondState: { onlineUsers: new Set() },
      sessions: new SessionStore({}),
      api: new XechatApi({ base: 'https://fake', fetchFn: fakeApiFetch }),
      python: { cmd: 'python', timeoutMs: 10000 },
      web: { enabled: true },
      skills: { enabled: true },
      todo: { maxItems: 20 },
      ws: fakeWs,
    });

    sent.length = 0;
    const pCreate = reg.dispatch('create_room', { game: '五子棋', nums: 2 });
    setImmediate(() => fakeWs._feed({
      action: 'GAME_ROOM_CREATED',
      body: { id: '143012345', game: 'GOBANG', nums: 2, gameMode: null, homeowner: { username: '大黄鱼' } },
    }));
    const r1 = await pCreate;
    check('create_room 返回房间id', r1.roomId === '143012345' && r1.game === 'GOBANG');
    check('create_room 协议层发了 CREATE_GAME_ROOM', sent.length === 1 && sent[0].action === 'CREATE_GAME_ROOM');
    check('create_room 协议层 body.game=GOBANG', sent[0].body.game === 'GOBANG');

    sent.length = 0;
    const rBad = await reg.dispatch('create_room', { game: '不存在的游戏' });
    check('create_room 未知游戏报错', /未知游戏/.test(rBad.error));
    check('create_room 未知游戏不发协议', sent.length === 0);

    sent.length = 0;
    const pClose = reg.dispatch('close_room', { roomId: '143012345' });
    setImmediate(() => fakeWs._feed({
      action: 'GAME_ROOM',
      body: { roomId: '143012345', msgType: 'ROOM_CLOSE' },
    }));
    const r2 = await pClose;
    check('close_room 收到 ROOM_CLOSE → 成功', r2.closed === true && r2.roomId === '143012345');
    check('close_room 协议层发了 GAME_ROOM', sent.length === 1 && sent[0].action === 'GAME_ROOM');
    check('close_room 协议层 msgType=ROOM_CLOSE', sent[0].body.msgType === 'ROOM_CLOSE');

    sent.length = 0;
    const pCloseFail = reg.dispatch('close_room', { roomId: '999999999' });
    setImmediate(() => fakeWs._feed({
      action: 'GAME_ROOM',
      body: { roomId: '999999999', msgType: 'GAME_ERROR', content: '游戏房间不存在！' },
    }));
    const r3 = await pCloseFail;
    check('close_room 收到 GAME_ERROR → 报错', /关闭失败/.test(r3.error) && /不存在/.test(r3.error));

    sent.length = 0;
    const pTimeout = reg.dispatch('close_room', { roomId: '111111111' });
    const r4 = await pTimeout;
    check('close_room 超时也视为成功', r4.closed === true && /无响应/.test(r4.note || ''));

    const regNoWs = createRegistry({
      startTime: Date.now(),
      pondState: { onlineUsers: new Set() },
      sessions: new SessionStore({}),
      api: new XechatApi({ base: 'https://fake', fetchFn: fakeApiFetch }),
      python: { cmd: 'python', timeoutMs: 10000 },
      web: { enabled: true }, skills: { enabled: true }, todo: { maxItems: 20 },
    });
    const r5 = await regNoWs.dispatch('close_room', { roomId: 'x' });
    check('close_room WS 未就绪报错', /WS 客户端未就绪/.test(r5.error));
  }

  // —— 4c. list_rooms 活动房间查询 (订阅式) ——
  console.log('[4c] list_rooms 活动房间查询');
  {
    const now = Date.now();
    const pondState = { onlineUsers: new Set(['u1']), activeRooms: new Map() };
    pondState.activeRooms.set('111111111', { roomId: '111111111', game: 'GOBANG', nums: 2, gameMode: null, homeowner: 'alice', createdAt: now - 5000 });
    pondState.activeRooms.set('222222222', { roomId: '222222222', game: 'LANDLORDS', nums: 3, gameMode: null, homeowner: 'bob', createdAt: now - 3000 });
    pondState.activeRooms.set('333333333', { roomId: '333333333', game: 'GOBANG', nums: 4, gameMode: 'ranked', homeowner: 'carol', createdAt: now - 1000 });
    const reg = createRegistry({
      startTime: Date.now(), pondState, sessions: new SessionStore({}),
      api: new XechatApi({ base: 'https://fake', fetchFn: fakeApiFetch }),
      python: { cmd: 'python', timeoutMs: 1000 }, web: { enabled: false }, skills: { enabled: true }, todo: { maxItems: 20 },
    });

    const rAll = await reg.dispatch('list_rooms', {});
    check('list_rooms 返回总数', rAll.total === 3);
    check('list_rooms 返回按游戏分组', rAll.byGame.GOBANG === 2 && rAll.byGame.LANDLORDS === 1);
    check('list_rooms 房间条目含房主与时长', rAll.rooms.length === 3 && rAll.rooms.some((r) => r.homeowner === 'alice' && r.ageSec >= 5));
    check('list_rooms 默认上限生效', rAll.rooms.length <= 50);

    const rGobang = await reg.dispatch('list_rooms', { game: '五子棋' });
    check('list_rooms 按游戏过滤(中文别名)', rGobang.total === 3 && rGobang.filtered === 2 && rGobang.rooms.every((r) => r.game === 'GOBANG'));

    const rLimit = await reg.dispatch('list_rooms', { limit: 2 });
    check('list_rooms limit 生效', rLimit.rooms.length === 2);

    pondState.activeRooms.delete('111111111');
    const rAfter = await reg.dispatch('list_rooms', {});
    check('list_rooms 关闭后总数 -1', rAfter.total === 2);
    check('list_rooms 关闭后 GOBANG 计数=1', rAfter.byGame.GOBANG === 1);
  }

  // list_rooms 在没有 pondState.activeRooms 时也安全
  {
    const reg = createRegistry({
      startTime: Date.now(), pondState: { onlineUsers: new Set() }, sessions: new SessionStore({}),
      api: new XechatApi({ base: 'https://fake', fetchFn: fakeApiFetch }),
      python: { cmd: 'python', timeoutMs: 1000 }, web: { enabled: false }, skills: { enabled: true }, todo: { maxItems: 20 },
    });
    const r = await reg.dispatch('list_rooms', {});
    check('list_rooms 缺少 activeRooms 报错', r.total === undefined && /订阅未就绪/.test(r.error || ''));
  }
}