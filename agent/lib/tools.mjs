// 鱼塘 agent 智能体 —— 内置工具注册表 (v2, references: opencode tool 体系)
// 每个工具通过 defineTool 定义, 统一获得: 参数校验、输出截断、状态回调。
// 依赖运行时上下文(ctx), 由 Router 在构造 ToolRegistry 时注入:
//   { startTime, sessions, pondState, api, proxy, python, web, memory, skills,
//     delegate(opts) 子代理委托通道, subagentDepth, todo }
// 新增工具: delegate(子代理) / todo_list·todo_update(待办) / remember·recall(持久记忆) / skill(技能包)。
import { defineTool, ToolRegistry } from './tool-core.mjs';

export { ToolRegistry };

/** 构造并注册全部内置工具 */
export function createRegistry(registryCtx = {}) {
  const ctx = registryCtx;
  const reg = new ToolRegistry(ctx);

  // —— 基础状态 ——
  reg.register(defineTool({
    id: 'now',
    description: '返回服务器(agent运行机器)当前时间',
    parameters: { type: 'object', properties: {} },
    run: async () => ({ time: new Date().toLocaleString('zh-CN', { hour12: false }) }),
  }));
  reg.register(defineTool({
    id: 'uptime',
    description: '返回 agent 已连续运行的时长',
    parameters: { type: 'object', properties: {} },
    run: async () => {
      const sec = Math.floor((Date.now() - (ctx.startTime || Date.now())) / 1000);
      const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
      return { uptime: `${h}h ${m}m ${s}s` };
    },
  }));
  reg.register(defineTool({
    id: 'room_stats',
    description: '查询鱼塘聊天室当前在线用户数量与用户名列表',
    parameters: { type: 'object', properties: {} },
    run: async () => ({
      online_count: ctx.pondState ? ctx.pondState.onlineUsers.size : 0,
      online_users: ctx.pondState ? [...ctx.pondState.onlineUsers] : [],
    }),
  }));
  reg.register(defineTool({
    id: 'session_stats',
    description: '返回当前正在与 agent 对话的用户会话数',
    parameters: { type: 'object', properties: {} },
    run: async () => ({ active_sessions: ctx.sessions ? ctx.sessions.size : 0 }),
  }));

  // —— Python 执行 (参考 Claude Code 的 Bash 工具) ——
  reg.register(defineTool({
    id: 'python',
    description: '执行一段 Python 代码做计算/数据处理/脚本, print 输出即结果。可用于数学计算、数据整理、文本处理等。超时自动终止。安全限制: 禁止执行系统命令(subprocess/os.system 等)、禁止读取服务器信息(环境变量/主机名/平台/网络/CPU等)、禁止破坏性文件操作, 命中会被拦截。',
    parameters: {
      type: 'object',
      properties: { code: { type: 'string', description: '要执行的 Python 代码, 用 print 输出结果' } },
      required: ['code'],
    },
    budget: 4000,
    run: async ({ code }) => {
      const src = String(code || '');
      const why = pythonBlockReason(src);
      if (why) {
        return { exitCode: -1, error: `⛔ 代码包含被禁止的操作(${why}), 已拒绝执行。`, blocked: true };
      }
      const { runPython } = await import('./python-runner.mjs');
      const r = await runPython(src, { timeoutMs: ctx.python?.timeoutMs || 15000, cmd: ctx.python?.cmd || 'python' });
      return { exitCode: r.exitCode, timedOut: r.timedOut, stdout: r.stdout.trim().slice(0, 4000), stderr: r.stderr.trim().slice(0, 2000) };
    },
  }));

  // —— 联网 (走代理) ——
  reg.register(defineTool({
    id: 'web_search',
    description: '在互联网上搜索信息(Bing), 返回相关网页的标题/链接/摘要。用于查询新闻、价格、百科等实时信息。',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: '搜索关键词, 中文即可' } },
      required: ['query'],
    },
    budget: 6000,
    run: async ({ query }) => {
      if (!ctx.web?.enabled) return { error: '联网功能已关闭(DISABLE_WEB=1)' };
      const { webSearch } = await import('./web.mjs');
      const res = await webSearch(String(query || ''), { proxy: ctx.proxy, timeoutMs: ctx.web?.timeoutMs || 15000 });
      return { count: res.length, results: res };
    },
  }));
  reg.register(defineTool({
    id: 'fetch_url',
    description: '抓取指定 URL 的网页内容(纯文本), 用于读取某篇文章/页面详情。',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: '完整 URL' } },
      required: ['url'],
    },
    budget: 6000,
    run: async ({ url }) => {
      if (!ctx.web?.enabled) return { error: '联网功能已关闭(DISABLE_WEB=1)' };
      const { httpGet } = await import('./web.mjs');
      const r = await httpGet(String(url || ''), { proxy: ctx.proxy, timeoutMs: ctx.web?.timeoutMs || 15000 });
      const text = String(r.text || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      return { status: r.status, text: text.slice(0, 4000) };
    },
  }));
  reg.register(defineTool({
    id: 'gold_price',
    description: '查询今日国际金价(美元/盎司)与人民币金价(元/盎司、元/克), 实时数据。',
    parameters: { type: 'object', properties: {} },
    run: async () => {
      if (!ctx.web?.enabled) return { error: '联网功能已关闭(DISABLE_WEB=1)' };
      const { goldPrice } = await import('./web.mjs');
      return await goldPrice({ proxy: ctx.proxy, timeoutMs: ctx.web?.timeoutMs || 15000 });
    },
  }));

  // —— 鱼塘平台功能查询 (走 XechatApi) ——
  reg.register(defineTool({
    id: 'games',
    description: '查询鱼塘游戏列表(可带关键字过滤), 返回每个游戏的名字/版本/是否上线/分类/playUrl',
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '按游戏名(英文或中文)模糊过滤, 可选' },
        size: { type: 'integer', description: '返回条数, 默认 10' },
      },
    },
    run: async ({ keyword = '', size = 10 }) => {
      const list = await ctx.api.gameList({ size, keyword });
      return { total: list.length, games: list.map((g) => ({
        name: g.name, zhName: g.zhName, version: g.version, online: g.online,
        categories: g.categories, playUrl: g.playUrl,
      })) };
    },
  }));
  reg.register(defineTool({
    id: 'game_detail',
    description: '查询某个游戏的详细信息(传 id 或英文名), 返回中文名/版本/描述/分类/播放与下载地址',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: '游戏 id (优先)' },
        name: { type: 'string', description: '游戏英文名' },
      },
    },
    run: async ({ id, name }) => {
      if (id === undefined && !name) return { error: '需要 id 或 name 参数' };
      return await ctx.api.gameDetail(id ?? name);
    },
  }));
  reg.register(defineTool({
    id: 'leaderboard',
    description: '查询某个游戏的排行榜(需要游戏id), 返回排名/用户名/分数',
    parameters: {
      type: 'object',
      properties: {
        gameInfoId: { type: 'integer', description: '游戏 id, 必填' },
        limit: { type: 'integer', description: '返回条数, 默认 10' },
      },
    },
    run: async ({ gameInfoId, limit = 10 }) => {
      if (gameInfoId === undefined) return { error: '需要 gameInfoId 参数' };
      return { count: 0, ranking: await ctx.api.leaderboard({ gameInfoId, limit }) };
    },
  }));
  reg.register(defineTool({
    id: 'server_list',
    description: '查询鱼塘平台当前启用的服务器(鱼塘)列表: 名称/地址(ip)/端口/版本。用户问"有哪些鱼塘/几个鱼塘/怎么连鱼塘"时用。',
    parameters: { type: 'object', properties: {} },
    run: async () => {
      const list = await ctx.api.serverList();
      return {
        total: list.length,
        servers: list.map((s) => ({
          name: s.name, ip: s.ip, port: s.port, version: s.version,
          enabled: s.enabled, remark: s.remark,
        })),
      };
    },
  }));

  // —— 游戏房间 (CREATE_GAME_ROOM / GAME_ROOM 协议, 走 WS 客户端) ——
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
  const resolveGameEnum = (raw) => {
    const s = String(raw || '').trim();
    if (!s) return null;
    if (GAME_ALIAS[s.toLowerCase()]) return GAME_ALIAS[s.toLowerCase()];
    if (GAME_ALIAS[s]) return GAME_ALIAS[s];
    // 已是大写枚举名则直接透传(用枚举名风格而非别名)
    if (/^[A-Z_][A-Z0-9_]*$/.test(s)) return s;
    return null;
  };

  reg.register(defineTool({
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
  }));

  reg.register(defineTool({
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
  }));

  // —— 子代理委托 (references: opencode task 工具) ——
  reg.register(defineTool({
    id: 'delegate',
    description: '把一项任务委派给专业子智能体并取回结论: explore=联网/平台调研专家, math=计算专家(python)。适合自己不想做多步长链的情况。',
    parameters: {
      type: 'object',
      properties: {
        agent: { type: 'string', enum: ['explore', 'math'], description: '子智能体类型: explore(调研)或 math(计算)' },
        task: { type: 'string', description: '交给子智能体的具体任务描述(中文, 写清要什么结论)' },
      },
      required: ['agent', 'task'],
    },
    budget: 8000,
    run: async ({ agent, task }, extra) => {
      if (typeof ctx.delegate !== 'function') return { error: '子智能体通道未就绪' };
      const depth = extra.depth ?? 0;
      if (depth >= (ctx.subagentDepth ?? 1)) {
        return { error: `子智能体嵌套已达上限(${ctx.subagentDepth ?? 1} 层), 请直接在当前层完成` };
      }
      if (ctx.status) ctx.status(`把任务交给子智能体「${agent}」…`);
      const out = await ctx.delegate({ agent, task, from: extra.from, depth: depth + 1, status: extra.status });
      if (out.error) return { error: `子智能体「${agent}」失败: ${out.error}` };
      return `<task state="completed">\n${out.result || '(无输出)'}\n</task>`;
    },
  }));

  // —— 待办 (references: opencode session/todo) ——
  reg.register(defineTool({
    id: 'todo_list',
    description: '查看当前用户会话的待办清单(id/状态/内容)',
    parameters: { type: 'object', properties: {} },
    run: async (_a, extra) => {
      const sess = getSession(ctx, extra);
      return { items: todosJson(sess) };
    },
  }));
  reg.register(defineTool({
    id: 'todo_update',
    description: `创建/维护一份结构化任务清单, 用于多步调研/任务的规划与跟踪(参考 opencode todowrite)。

## 何时使用
- 任务包含 ≥3 个独立步骤(不仅仅是 3 次同类工具调用)
- 复杂调研/任务, 先写步骤再动手
- 用户给了多项任务或编号列表

## 何时不用
- 单一简单任务或闲聊, 跟踪无价值

## 状态
- pending / in_progress(同时只能 1 条) / completed / cancelled

## 规则
- 动手前先把当前步骤标为 in_progress, 完成立刻勾 completed(**不批量**)
- 完成需含验证(看到结果), 不靠"意图"
- 遇到阻塞 → 保持 in_progress 并加一条 follow-up todo 描述阻塞原因
- 持续多步调用 ≥2 个不同类型工具 才算"已调研"

action: add(新增)/done(完成或取消完成 by 序号)/update(修改状态/优先级/文本 by 序号)/delete(删除)/clear(清空)`,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'done', 'update', 'delete', 'clear'], description: '操作类型' },
        text: { type: 'string', description: 'action=add 时的待办内容' },
        index: { type: 'integer', description: 'action=done/update/delete 时的序号(从 1 开始)' },
        status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled'], description: 'action=update 时的目标状态' },
        priority: { type: 'string', enum: ['low', 'normal', 'high'], description: 'action=add/update 时的优先级' },
      },
      required: ['action'],
    },
    budget: 4000,
    run: async ({ action, text, index, status, priority }, extra) => {
      const sess = getSession(ctx, extra);
      const max = ctx.todo?.maxItems || 20;
      let r;
      if (action === 'add') r = todoMod.addTodo(sess, text, max, priority);
      else if (action === 'done') r = todoMod.doneTodo(sess, index);
      else if (action === 'update') r = todoMod.updateTodo(sess, index, { text, status, priority });
      else if (action === 'delete') r = todoMod.deleteTodo(sess, index);
      else if (action === 'clear') r = todoMod.clearTodos(sess);
      else return { error: `未知操作: ${action}` };
      return r.error ? { error: r.error } : { list: r.list };
    },
  }));

  // —— 持久记忆 (受 ENABLE_MEMORY 门控) ——
  reg.register(defineTool({
    id: 'remember',
    description: '记下一条用户的关键事实(如昵称/偏好/约定), 之后可 recall 查询。',
    parameters: {
      type: 'object',
      properties: { fact: { type: 'string', description: '要记住的事实, 陈述句' } },
      required: ['fact'],
    },
    run: async ({ fact }, extra) => {
      const mem = ctx.memory;
      if (!mem || !mem.enabled) return { error: '记忆功能未开启(管理员设 ENABLE_MEMORY=1)' };
      const from = extra.from;
      if (!from) return { error: '不知道是谁的事实' };
      const r = mem.remember(from, fact);
      return r ? { ok: true, stored: r.value } : { error: '事实为空' };
    },
  }));
  reg.register(defineTool({
    id: 'recall',
    description: '查询已记住的该用户事实(可按关键字过滤), 回应个性化问题时用。',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: '可选关键字, 模糊匹配' } },
    },
    run: async ({ query } = {}, extra) => {
      const mem = ctx.memory;
      if (!mem || !mem.enabled) return { error: '记忆功能未开启(管理员设 ENABLE_MEMORY=1)' };
      const from = extra.from;
      if (!from) return { facts: [] };
      return { facts: mem.search(from, query) };
    },
  }));

  // —— 游戏房间列表 (订阅式累积, 见 agent.mjs pondState.activeRooms) ——
  reg.register(defineTool({
    id: 'list_rooms',
    description: '列出当前活动的鱼塘游戏房间: 总数/按游戏分组计数/完整列表(房间ID+游戏+人数+房主+创建时间)。数据靠订阅全服广播(GAME_ROOM_CREATED/ROOM_CLOSE)增量维护, agent 在线时长越久越准; 启动前已存在的房间不会被发现。',
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
  }));

  // —— 技能包 (references: opencode skill) ——
  reg.register(defineTool({
    id: 'skill',
    description: `加载一个技能包(${Object.keys(skillsMod.SKILLS).join('/')}), 之后按该技能的工作流执行。`,
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', enum: Object.keys(skillsMod.SKILLS), description: '技能名' } },
      required: ['name'],
    },
    run: async ({ name }) => {
      if (!ctx.skills?.enabled) return { error: '技能包未开启(DISABLE_SKILLS=1 会关闭)' };
      const s = skillsMod.getSkill(name);
      if (!s) return { error: `未知技能「${name}」, 可用: ${skillsMod.listSkills().join('、')}` };
      return { loaded: s.name, instruction: s.instructions };
    },
  }));

  // —— 定时任务 (references: 常规调度器) ——
  reg.register(defineTool({
    id: 'schedule',
    description: '注册一个一次性定时任务: 到设定时间提醒用户或自动执行。支持 inMinutes(相对时间, 如"5分钟")或 atTime(绝对时间, 如"18:30", 今天已过则明天)。mode=remind 到点直接发提醒文本; mode=auto 到点按 task 内容自动生成回复(可查资料)。',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '要提醒/执行的内容(或给 auto 模式的指令), 必填' },
        inMinutes: { type: 'string', description: '相对时间, 如 "5分钟" "2小时" "30秒"; 与 atTime 二选一' },
        atTime: { type: 'string', description: '绝对时间 HH:MM(可带秒), 今天已过则明天; 与 inMinutes 二选一' },
        to: { type: 'string', description: '指定接收人(用户名); 不填则到时广播' },
        mode: { type: 'string', enum: ['remind', 'auto'], description: 'remind=到点发文本; auto=到点自动生成再发(默认 remind)' },
      },
      required: ['task'],
    },
    run: async ({ task, inMinutes, atTime, to, mode }, extra) => {
      const sched = ctx.scheduler;
      if (!sched || !sched.enabled) return { error: '定时任务未开启(DISABLE_SCHEDULE=1 会关闭)' };
      let atMs = null;
      if (inMinutes) {
        const ms = schedMod.parseDuration(inMinutes);
        if (ms == null || ms <= 0) return { error: `无法解析相对时间: ${inMinutes}(用"5分钟"/"2小时"/"30秒")` };
        atMs = Date.now() + ms;
      } else if (atTime) {
        atMs = schedMod.parseAtTime(atTime);
        if (atMs == null) return { error: `无法解析时间: ${atTime}(用 HH:MM, 如 18:30)` };
      } else {
        return { error: '需要 inMinutes(相对时间)或 atTime(绝对时间)' };
      }
      const from = extra.from || ctx.from;
      const res = sched.add({ atMs, task, to: to || from || null, mode: mode || 'remind' });
      return { id: res.id, atMs: res.atMs, estimated: new Date(res.atMs).toLocaleString('zh-CN', { hour12: false }), task };
    },
  }));
  reg.register(defineTool({
    id: 'list_schedules',
    description: '查看所有未到期的定时任务(id/触发时间/内容)',
    parameters: { type: 'object', properties: {} },
    run: async () => {
      const sched = ctx.scheduler;
      if (!sched || !sched.enabled) return { error: '定时任务未开启' };
      const list = sched.list();
      return { count: list.length, tasks: list.map((t) => ({
        id: t.id,
        at: new Date(t.atMs).toLocaleString('zh-CN', { hour12: false }),
        task: t.task, to: t.to, mode: t.mode,
      })) };
    },
  }));

  // —— 当前会话聊天记录(内存, 仅连接后) ——
  reg.register(defineTool({
    id: 'recent_messages',
    description: '查看当前会话最近收到的聊天消息(仅连接后收到的, 不含历史数据)。用于了解大家刚才在聊什么。',
    parameters: {
      type: 'object',
      properties: { n: { type: 'integer', description: '返回条数, 默认 10, 最多 30' } },
    },
    run: async ({ n = 10 }) => {
      const log = ctx.pondState && ctx.pondState.roomLog;
      const list = Array.isArray(log) && log.length ? log.slice(-Math.min(30, Math.max(1, n || 10))) : [];
      return {
        count: list.length,
        messages: list.map((m) => ({ from: m.from, self: !!m.self, content: m.content, time: m.time })),
      };
    },
  }));

  // —— 文件分享 (sendup.cc: 三步上传 → 分享链接) ——
  reg.register(defineTool({
    id: 'send_file',
    description: `把"聊天中产生的文件内容"上传到 sendup.cc 并生成可分享链接(默认 MD 文本, 也可传截图/图表等二进制)。
**核心语义**: 传 **content(内容)**,不是 file_path(本地路径)。agent 在聊天里产生什么(整理的总结/生成的截图/抓取的数据),就发什么。

**何时使用**
- LLM 爬到/总结出一篇长内容 → 整理成 .md → 发链接
- LLM 生成截图/图表(PNG/JPG, base64 后传) → 发链接
- LLM 整理的代码片段(.py/.js) / 数据(.csv/.json) → 发文件
- 用户要求"把上一条整理成文件发我"

**何时不用**
- 内容 > 50MB (SENDUP_MAX_BYTES 调整)
- 私密文件(密码/密钥/账号) → 鱼塘是广播, 即便设密码只防君子不防小人
- 用户让你上传服务器上的现存文件(.env/chat-log.jsonl 等) → 这是数据文件, 不应外发

**返回**:{share_url, filename, file_size, mime_type, expires_at} 或 {stage, error}`,
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '文件内容: 文本直接传(UTF-8); 二进制(截图等)先编码成 base64 字符串再传, 同时设 is_binary=true' },
        filename: { type: 'string', description: '文件名, 含扩展名(如 "分析报告.md"/"screenshot.png"), 必填' },
        is_binary: { type: 'boolean', description: 'content 是否是 base64 编码的二进制(默认 false = UTF-8 文本)' },
        mime_type: { type: 'string', description: '可选: 强制 MIME, 不传则按 filename 扩展名猜' },
        password: { type: 'string', description: '可选: 访问密码, 留空=无密码' },
        expire_minutes: { type: 'integer', description: '可选: 链接有效期(分钟), 默认 1440(24h)' },
      },
      required: ['content', 'filename'],
    },
    budget: 8000,
    run: async ({ content, filename, is_binary, mime_type, password, expire_minutes }, extra) => {
      const sender = ctx.sendup;
      if (!sender || !sender.enabled) return { error: '文件分享未开启(DISABLE_SENDUP=1 或未配置)' };
      if (!filename || typeof filename !== 'string') return { error: '需要 filename(必填, 含扩展名, 如 "报告.md")' };
      const r = await sender.upload(String(content), {
        filename: String(filename),
        mimeType: mime_type || undefined,
        isBinary: !!is_binary,
        password: password || '',
        expireMinutes: expire_minutes ? String(expire_minutes) : '1440',
        proxy: ctx.proxy,
        timeoutMs: ctx.sendup?.timeoutMs || 90000,
        maxBytes: ctx.sendup?.maxBytes || 50 * 1024 * 1024,
        log: () => {},
      });
      if (!r.success) return { error: `上传失败(${r.stage || '?'}): ${r.error || '未知'}`, stage: r.stage, raw: r.raw };
      return {
        success: true,
        share_url: r.share_url,
        filename: r.original_filename,
        file_size: r.file_size,
        mime_type: r.mime_type,
        expires_at: r.expires_at,
      };
    },
  }));

  // —— 聊天记录日志(持久化, 跨重启可查) ——
  reg.register(defineTool({
    id: 'chat_log',
    description: '查看聊天记录日志中最近的消息(持久化到磁盘, 跨重启可查, 含更早的历史)。recent_messages 只查当前连接, 这个查日志。',
    parameters: {
      type: 'object',
      properties: {
        n: { type: 'integer', description: '返回条数, 默认 10, 最多 200' },
        from: { type: 'string', description: '可选: 只看某个用户发的' },
      },
    },
    run: async ({ n = 10, from } = {}) => {
      const cl = ctx.chatLog;
      if (!cl || !cl.enabled) return { error: '聊天记录日志未开启(DISABLE_CHAT_LOG=1 会关闭)' };
      const list = await cl.readRecent(n, { from });
      return { count: list.length, total: cl.count(), messages: list };
    },
  }));

  // —— 跨鱼塘探测 (probe_pond): 一次性访客登录目标鱼塘拿在线列表, 只读不发言 ——
  reg.register(defineTool({
    id: 'probe_pond',
    description: `访问其他鱼塘(WebSocket 聊天服务)并获取其在线用户列表(可附最近聊天)。用一次性访客昵称登录目标鱼塘(登录成功服务端即推送完整在线列表), 拿完立即断开, 不发言、不留痕。
已知鱼塘: 充电鸭鱼塘=lesscoding.net:33859(直连可通); 官方鱼塘=xechat.xeblog.cn:33859(域名未备案, 一般被墙返回失败); 当前鱼塘=${ctx.host || '本机'}:${ctx.port || 33859}(本工具拒绝探测自己, 看在线用 room_stats)。
用户说"访问/查询/看一下其他鱼塘/别的鱼塘/别的塘"时使用; 直连失败可带 viaProxy=true 重试。`,
    parameters: {
      type: 'object',
      properties: {
        host: { type: 'string', description: '目标鱼塘主机(域名或IP), 如 lesscoding.net' },
        port: { type: 'integer', description: '目标鱼塘 WS 端口, 默认 33859(即原生端口的 +1)' },
        viaProxy: { type: 'boolean', description: '走本地代理 127.0.0.1:7897 连接(默认 false=直连; 直连失败时可重试开启)' },
        history: { type: 'integer', description: '顺带返回最近聊天消息条数, 默认 0(不需要)' },
      },
      required: ['host'],
    },
    budget: 6000,
    run: async ({ host, port = 33859, viaProxy = false, history = 0 }) => {
      const h = String(host || '').trim();
      if (!h) return { error: '需要目标鱼塘主机(host)' };
      // 拒绝探测自己: 会重复登录制造第二个会话并广播进塘通知; 当前鱼塘用 room_stats 即可
      if (ctx.host && String(ctx.host).trim() === h && (Number(port) || 33859) === Number(ctx.port)) {
        return { error: '那是当前所在鱼塘, 看在线直接用 room_stats 即可, 不必访问' };
      }
      const { probePond } = await import('./pond-probe.mjs');
      return await probePond({
        host: h,
        port: Number(port) || 33859,
        viaProxy: !!viaProxy,
        proxy: ctx.proxy || { host: '127.0.0.1', port: 7897 },
        history: Number(history) || 0,
      });
    },
  }));

  return reg;
}

// —— 内部小助手 ——
function getSession(ctx, extra) {
  const from = extra.from || ctx.from;
  if (ctx.sessions && from) return ctx.sessions._get(from);
  return { todos: [] };
}

function todosJson(sess) {
  return todoMod.initTodos(sess);
}

// —— Python 安全护栏: 静态审计 ——
// 命中任一危险模式直接拒绝执行(与运行期模块拦截 python-runner 双层防护)。
// 注意: 正常数学计算/数据处理/文本处理不会触碰这些模式, 无需担心误伤。
const PY_BLOCK_RE = [
  // 1) 执行系统命令
  { re: /subprocess|os\.system|os\.popen|os\.exec|Popen|spawn\s*\(|shell\s*=\s*True|commands\./i, why: '执行系统命令' },
  // 2) 动态执行(绕过静态审计的常见手段: eval/exec/__import__/compile)
  { re: /\bexec\s*\(|\beval\s*\(|__import__|compile\s*\(/i, why: '动态执行代码(可能绕过安全限制)' },
  // 3) 探测服务器信息(环境变量/平台/网络/硬件)
  { re: /os\.environ|os\.getenv|os\.uname|os\.getlogin|os\.name\b|platform\.|socket\.|psutil|gethostname|getfqdn|uuid\.getnode|cpu_count|virtual_memory|disk_usage|netifaces/, why: '探测服务器信息' },
  // 4) 破坏性系统/文件操作
  { re: /shutil\.(rmtree|move|copy)|os\.(remove|rmdir|unlink)|taskkill|shutdown|reboot|reg\s+(add|delete|edit)|net\s+user/i, why: '破坏性系统操作' },
  // 5) 读取敏感文件 (硬黑名单, 字体加载也不能放行)
  { re: /\/etc\/passwd|\/etc\/shadow|\.env["']/i, why: '读取敏感文件' },
  // 5b) 访问 Windows 系统目录(可被 PIL truetype 加载系统字体时绕过)
  { re: /C:\\Windows/i, why: '访问系统目录', bypassable: 'font' },
  // 6) 下载/写盘大文件(占带宽/磁盘)
  { re: /urlretrieve|\.download\s*\(/i, why: '下载文件到本地' },
];

function pythonBlockReason(src) {
  // 白名单: 仅放行 PIL ImageFont.truetype 加载 TTF/TTC/OTF 字体这一种场景(用于画中文图);
  // 其它 ctypes / subprocess / 探测系统信息 等规则不受影响, 沙箱底线保留。
  const isFontLoad = /\bImageFont\s*\.\s*truetype\s*\(/i.test(src)
    && /\.(ttf|ttc|otf)\b/i.test(src);
  const hit = PY_BLOCK_RE.find((b) => {
    if (isFontLoad && b.bypassable === 'font') return false;
    return b.re.test(src);
  });
  return hit ? hit.why : '';
}

import * as todoMod from './todo.mjs';
import * as skillsMod from './skills.mjs';
import * as schedMod from './scheduler.mjs';