// agent 工具 —— 游戏房间 (走 WS 协议 CREATE_GAME_ROOM / GAME_ROOM + 订阅式活动列表)
// 依赖 ctx.ws / ctx.pondState.activeRooms, 内部 GAME_ALIAS 中文/英文 → Java Game 枚举名
import { defineTool } from '../../foundation/tool-core.mjs';

// 中文/英文别名 → Java 服务端 Game 枚举名(对齐 xechat-commons/.../Game.java)
const GAME_ALIAS = {
  '五子棋': 'GOBANG', 'gobang': 'GOBANG',
  '斗地主': 'LANDLORDS', 'landlords': 'LANDLORDS',
  '不贪吃蛇': 'NON_GLUTTONOUS_SNAKE', 'snake': 'NON_GLUTTONOUS_SNAKE', 'gluttonous': 'NON_GLUTTONOUS_SNAKE',
  '2048': 'GAME_2048',
  '数独': 'SUDOKU', 'sudoku': 'SUDOKU',
  '推箱子': 'PUSH_BOX', 'sokoban': 'PUSH_BOX', 'pushbox': 'PUSH_BOX',
  '中国象棋': 'CHINESE_CHESS', 'chess': 'CHINESE_CHESS', 'xiangqi': 'CHINESE_CHESS',
  '俄罗斯方块': 'TETRIS', 'tetris': 'TETRIS',
  '扫雷': 'MINESWEEPER', 'minesweeper': 'MINESWEEPER',
  '爱坤大乐斗': 'IKUN', 'ikun': 'IKUN',
  '大富翁': 'MONOPOLY', 'monopoly': 'MONOPOLY',
  '爱坤麻将': 'MAHJONG', 'mahjong': 'MAHJONG',
};

function resolveGameEnum(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (GAME_ALIAS[s.toLowerCase()]) return GAME_ALIAS[s.toLowerCase()];
  if (GAME_ALIAS[s]) return GAME_ALIAS[s];
  // 已是大写枚举名则直接透传(用枚举名风格而非别名)
  if (/^[A-Z_][A-Z0-9_]*$/.test(s)) return s;
  return null;
}

export function buildGameTools(ctx) {
  return [
    defineTool({
      id: 'create_room',
      description: '在鱼塘创建一个游戏房间(CREATE_GAME_ROOM 协议), 返回房间id/游戏/人数/模式。游戏名支持中文(五子棋/斗地主/...)或英文枚举名(GOBANG/LANDLORDS/...)。',
      parameters: {
        type: 'object',
        properties: {
          game: { type: 'string', description: '游戏名, 中文(如「五子棋」)或英文枚举名(如「GOBANG」)' },
          nums: { type: 'integer', description: '几人房, 默认 2' },
          gameMode: { type: 'string', description: '游戏模式(可选, 不同游戏含义不同, 如地主局数)' },
        },
        required: ['game'],
      },
      budget: 4000,
      run: async ({ game, nums = 2, gameMode }) => {
        const ws = ctx.ws;
        if (!ws || !ws.sendActionAndWait) return { error: 'WS 客户端未就绪(agent 启动异常?)' };
        const enumName = resolveGameEnum(game);
        if (!enumName) return { error: `未知游戏: ${game}。可用: ${Object.keys(GAME_ALIAS).filter(k => /[一-龥]/.test(k)).join('、')}` };
        const body = { game: enumName, nums, gameMode: gameMode || null };
        try {
          const { msg } = await ws.sendActionAndWait('CREATE_GAME_ROOM', body, {
            match: (m, t) => t === 'GAME_ROOM_CREATED',
            timeoutMs: 6000,
          });
          const r = msg.body || {};
          if (!r || !r.id) return { error: '服务端未返回房间id', raw: r };
          return {
            roomId: r.id, game: r.game, nums: r.nums, gameMode: r.gameMode,
            homeowner: r.homeowner && r.homeowner.username,
          };
        } catch (e) {
          return { error: '创建超时或连接断开: ' + (e.message || e) };
        }
      },
    }),
    defineTool({
      id: 'close_room',
      description: '关闭鱼塘上的游戏房间(GAME_ROOM 协议, msgType=ROOM_CLOSE)。返回关闭结果。',
      parameters: {
        type: 'object',
        properties: {
          roomId: { type: 'string', description: '目标房间ID(如 "143210987")' },
        },
        required: ['roomId'],
      },
      budget: 4000,
      run: async ({ roomId }) => {
        const ws = ctx.ws;
        if (!ws || !ws.sendActionAndWait) return { error: 'WS 客户端未就绪(agent 启动异常?)' };
        const body = { roomId, msgType: 'ROOM_CLOSE' };
        try {
          const { msg } = await ws.sendActionAndWait('GAME_ROOM', body, {
            // 失败: 服务端回 GAME_ROOM + msgType=GAME_ERROR(且房间号不一致)
            // 成功: 服务端向房内玩家广播 GAME_ROOM + msgType=ROOM_CLOSE
            match: (m, t, b) => t === 'GAME_ROOM' && b && (b.msgType === 'GAME_ERROR' || b.msgType === 'ROOM_CLOSE'),
            timeoutMs: 2500,
          });
          const b = msg.body || {};
          if (b.msgType === 'GAME_ERROR') {
            return { error: `关闭失败: ${b.content || '服务端拒绝'}` };
          }
          return { closed: true, roomId };
        } catch (e) {
          // 超时也视为成功: 服务端已成功关闭但未对发起者广播任何东西
          if (/timeout/i.test(e.message || '')) return { closed: true, roomId, note: '无响应但服务端通常已关闭' };
          return { error: '关闭失败: ' + (e.message || e) };
        }
      },
    }),
    defineTool({
      id: 'list_rooms',
      description: '列出当前活动的鱼塘游戏房间: 总数/按游戏分组计数/完整列表(房间ID+游戏+人数+房主+创建时间)。数据靠订阅全服局广播(GAME_ROOM_CREATED/ROOM_CLOSE)增量维护, agent 在线时长越久越准; 启动前已存在的房间不会被发现。',
      parameters: {
        type: 'object',
        properties: {
          game: { type: 'string', description: '可选, 只返回 game 该游戏的房间(中文或枚举名, 如「五子棋」/GOBANG)' },
          limit: { type: 'integer', description: '最多返回多少条, 默认 50' },
        },
      },
      run: async ({ game, limit = 50 } = {}) => {
        const rooms = ctx.pondState && ctx.pondState.activeRooms;
        if (!rooms) return { error: '房间订阅未就绪', count: 0, rooms: [] };
        const all = [...rooms.values()];
        // 按 game 枚举名过滤(支持中文别名)
        let filtered = all;
        if (game) {
          const enumName = resolveGameEnum(game);
          filtered = all.filter((r) => r.game === enumName || r.game === String(game).toUpperCase());
        }
        // 按游戏分组计数
        const byGame = {};
        for (const r of all) {
          const k = r.game || '?';
          byGame[k] = (byGame[k] || 0) + 1;
        }
        const items = filtered.slice(0, Math.max(1, Math.min(500, limit))).map((r) => ({
          roomId: r.roomId,
          game: r.game,
          nums: r.nums,
          gameMode: r.gameMode,
          homeowner: r.homeowner,
          ageSec: Math.floor((Date.now() - (r.createdAt || Date.now())) / 1000),
        }));
        return {
          total: all.length,          // 当前活动房间总数
          filtered: filtered.length,  // 经过滤后返回的条数
          byGame,                     // 按游戏枚举名计数
          rooms: items,
          note: '基于订阅增量维护, 启动前已存在的房间不会被发现; 准确性受 agent 在线时长影响',
        };
      },
    }),
  ];
}