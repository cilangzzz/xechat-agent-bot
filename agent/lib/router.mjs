// 鱼塘 agent 智能体 —— 指令路由 (v2, references: opencode 多智能体 + 命令分发)
// 路由策略:
//   1) 确定性内置命令(help/ping/games/todo/explore/math/领养/...) → 直接执行, 零 LLM 成本;
//   2) explore/math 关键词 → 直接委派给子智能体(参考 opencode explore 子代理), 显式调用省 token;
//   3) 其余自由文本 → main agent 回合(可调用全量工具, 也可自行 delegate 子智能体)。
// 引入: 命令注册表(builtin)、子智能体委托通道、结构化压缩集成、待办/记忆/技能指令。
import { spawn } from 'node:child_process';
import path from 'node:path';
import { createRegistry } from './tools.mjs';
import { getAgent, buildAgentSystemPrompt, resolveToolNames } from './agents.mjs';
import { buildEnvironment, buildSystemPrompt } from './system.mjs';
import { summarizeWithLlm } from './compaction.mjs';
import * as todoHelpers from './todo.mjs';
import { listSkills } from './skills.mjs';
import * as schedMod from './scheduler.mjs';

/** 解析一条消息: 是否命中前缀 */
export function parseCommand(text, prefix) {
  const t = String(text || '').trim();
  if (!t.startsWith(prefix)) return { isCmd: false };
  const rest = t.slice(prefix.length).trim();
  const m = rest.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  return {
    isCmd: true,
    sub: m ? m[1] : '',
    arg: m && m[2] ? m[2].trim() : '',
  };
}

/**
 * 从消息里提取对机器人的 @ 提及 (协议层的 toUsers 定向由 agent.mjs 判断)。
 * @param {string} text 消息内容
 * @param {string} username 机器人登录名(如「大黄鱼」; 专属实例为「<人名>的大黄鱼」)
 * @returns {string|''} @ 后要聊的内容(去前缀), 无提及返回空串
 */
export function extractMention(text, username) {
  const t = String(text || '').trim();
  if (!t || !username) return '';
  const names = [username, username.replace(/的大黄鱼$/, '')].filter(Boolean);
  const pat = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const re = new RegExp(`@\\s*(${pat})[\\s:：]*([\\s\\S]*)`, 'i');
  const m = t.match(re);
  if (!m) return '';
  const rest = (m[2] || '').trim();
  if (rest) return rest;
  return '(你 @ 到我了, 想聊点什么?)';
}

/** Router 默认配置(测试传部分 cfg 时兜底) */
const DEFAULT_CFG = {
  cmdPrefix: '/大黄鱼',
  username: '大黄鱼',
  thinkingPrefix: '💭',
  agents: { subagentDepth: 1, subagentIterations: 6 },
  todo: { maxItems: 20 },
  skills: { enabled: true },
  python: { cmd: 'python', timeoutMs: 15000 },
  web: { enabled: true },
  adopt: { enabled: false },
};

export class Router {
  /**
   * @param {object} deps { cfg, sessions, pondState, startTime, api, memory?, adoptments? }
   */
  constructor(deps) {
    this.deps = deps;
    this.cfg = { ...DEFAULT_CFG, ...(deps.cfg || {}) };
    this.cfg.agents = { ...DEFAULT_CFG.agents, ...(deps.cfg && deps.cfg.agents) };
    this.sessions = deps.sessions;
    this.pondState = deps.pondState;
    this.memory = deps.memory || null;
    this.adoptments = deps.adoptments || new Map();
    this._curUser = null;
    this._lastThink = null;

    this.tools = createRegistry({
      startTime: deps.startTime,
      sessions: this.sessions,
      pondState: this.pondState,
      api: deps.api,
      proxy: deps.cfg && deps.cfg.proxy,
      python: this.cfg.python,
      web: this.cfg.web,
      memory: this.memory,
      skills: this.cfg.skills,
      todo: this.cfg.todo,
      subagentDepth: this.cfg.agents.subagentDepth,
      ws: deps.ws, // WS 客户端: game room 等发-等响应指令用
      scheduler: deps.scheduler || null, // 定时任务 (schedule/list_schedules 工具)
      roomLog: this.cfg.roomLog,          // 聊天记录上限配置 (recent_messages 工具)
      chatLog: deps.chatLog || null,      // 聊天记录日志 (chat_log 工具)
      sendup: deps.sendup || null,        // 文件分享 (send_file 工具)
      host: deps.cfg && deps.cfg.host,    // 当前鱼塘主机/端口 (probe_pond 防自探测护栏)
      port: deps.cfg && deps.cfg.port,
    });

    this._summarize = null; // 摘要函数 (bindLlm 时注入)

    this.builtin = {
      help: () => `可用指令:\n${this.tools.describe()}\n子智能体: /${this.cfg.cmdPrefix} explore <问题> · math <算式>\n用法: ${this.cfg.cmdPrefix} <问题或指令>`,
      tools: () => this.tools.describe(),
      agents: () => '子智能体:\n- explore: 联网/平台调研\n- math: python 计算\n显式调用: /大黄鱼 explore <问题> · /大黄鱼 math <算式>',
      ping: () => 'pong 🎣',
      online: () => {
        const p = this.pondState;
        return `当前在线 ${p.onlineUsers.size} 人: ${[...p.onlineUsers].join(', ') || '(暂无)'}`;
      },
      stats: () => {
        const p = this.pondState;
        return `鱼塘现状: 在线 ${p.onlineUsers.size} 人 (${[...p.onlineUsers].slice(0, 8).join(', ')}${p.onlineUsers.size > 8 ? '...' : ''}); 对话会话 ${this.sessions.size} 个; 待办/压缩等能力已开启`;
      },
      games: async () => {
        const r = await this.tools.dispatch('games', {});
        if (r.error) return `查询失败: ${r.error}`;
        const gs = r.games.map((g) => `${g.name}${g.zhName ? `(${g.zhName})` : ''} v${g.version}${g.online ? ' 在线' : ''}`).join('\n');
        return `鱼塘游戏(${r.total} 个):\n${gs || '(暂无游戏)'}`;
      },
      game: async (arg) => {
        if (!arg) return '用法: /大黄鱼 game <游戏名或id>';
        const id = /^\d+$/.test(arg) ? Number(arg) : undefined;
        const r = await this.tools.dispatch('game_detail', { id, name: id ? undefined : arg });
        if (r.error) return `查询失败: ${r.error}`;
        return `【${r.name}${r.zhName ? `(${r.zhName})` : ''}】v${r.version} ${r.online ? '🟢上线' : '⚪未上线'}\n${r.description || '(无描述)'}\n分类: ${r.categories || '-'}\n播放: ${r.playUrl || '-'}`;
      },
      gold: async () => {
        const r = await this.tools.dispatch('gold_price', {});
        if (r.error) return `查询失败: ${r.error}`;
        return `今日金价: 国际 ${r.usdPerOz} 美元/盎司 | 人民币 ${r.cnyPerOz} 元/盎司 ≈ ${r.cnyPerGram} 元/克 (更新于 ${r.updatedAt})`;
      },
      // —— 多智能体显式指令 ——
      explore: async (arg, { from }) => this._runSubdirect('explore', arg, from),
      math: async (arg, { from }) => this._safeMath(arg, from),
      // —— 待办 ——
      todo: async (arg, { from }) => this._todoCmd(arg, from),
      // —— 技能 / 记忆 / 压缩 ——
      skills: () => (this.cfg.skills?.enabled ? listSkills().join('\n') : '技能包未开启(DISABLE_SKILLS=1 会关闭)'),
      记忆: async (_a, { from }) => this._memoryCmd(from),
      压缩: async (_a, { from }) => this._forceCompress(from),
      // —— 定时任务 ——
      定时: async (arg, { from }) => this._schedCmd(arg, from),
      '定时列表': async () => this._schedListCmd(),
      '定时取消': async (arg) => this._schedCancelCmd(arg),
      // —— 当前会话聊天记录 ——
      '最近消息': async (arg) => this._recentMsgsCmd(arg),
      '聊天记录': async (arg) => this._chatLogCmd(arg),
      // —— 领养 / 清理 ——
      领养: async (arg, { from }) => this._adopt(from),
      clear: () => { this.sessions.clear(this._curUser); return '好的，已清空本次对话上下文与待办。'; },
      // —— 游戏房间 (鱼塘平台: CREATE_GAME_ROOM / GAME_ROOM 协议) ——
      'create-room': async (arg, { from }) => {
        void from;
        const r = await this.tools.dispatch('create_room', this._parseCreateRoomArgs(arg));
        if (r.error) return `创建房间失败: ${r.error}`;
        return `房间已创建: id=${r.roomId} game=${r.game} nums=${r.nums}${r.gameMode ? ` mode=${r.gameMode}` : ''}`;
      },
      'close-room': async (arg, { from }) => {
        void from;
        const roomId = String(arg || '').trim();
        if (!roomId) return '用法: /大黄鱼 close-room <房间ID>';
        const r = await this.tools.dispatch('close_room', { roomId });
        if (r.error) return `关闭房间失败: ${r.error}`;
        return `房间 ${roomId} 已关闭`;
      },
      // —— 查询活动房间 ——
      rooms: async (arg) => {
        const rest = String(arg || '').trim();
        // 解析: /大黄鱼 rooms <game?> [limit]
        let game, limit;
        if (rest) {
          const m = rest.match(/^(.+?)(?:\s+(\d+))?$/);
          if (m) { game = m[1].trim() || undefined; limit = m[2] ? Number(m[2]) : undefined; }
        }
        const r = await this.tools.dispatch('list_rooms', { game, limit });
        if (r.error) return `查询失败: ${r.error}`;
        if (r.total === 0) return '当前没有活动的游戏房间(订阅未捕获到任何 GAME_ROOM_CREATED 广播)';
        const byGameList = Object.entries(r.byGame).map(([g, n]) => `${g}=${n}`).join(' · ');
        const lines = [
          `活动房间: 共 ${r.total} 个`,
          byGameList ? `按游戏: ${byGameList}` : null,
        ].filter(Boolean);
        if (r.rooms.length) {
          lines.push('---');
          for (const it of r.rooms) {
            lines.push(`${it.roomId} · ${it.game}${it.gameMode ? `(${it.gameMode})` : ''} · ${it.nums}人房 · 房主=${it.homeowner || '?'} · ${it.ageSec}s 前`);
          }
        }
        lines.push('---', r.note);
        return lines.join('\n');
      },
    };
  }

  /** 解析 create-room <game> [nums] [mode] 参数, 支持中文名/英文名/枚举别名 */
  _parseCreateRoomArgs(arg) {
    const rest = String(arg || '').trim();
    if (!rest) return {};
    const parts = rest.split(/\s+/);
    const gameRaw = parts[0];
    const nums = parts[1] ? Number(parts[1]) : undefined;
    const gameMode = parts.slice(2).join(' ') || undefined;
    return { game: gameRaw, nums, gameMode };
  }

  /** 绑定 LLM 实例(入口注入, 避免循环依赖), 并接通子智能体委托通道 */
  bindLlm(llm) {
    this.llm = llm;
    // delegate 工具通过注册表 ctx.delegate 把子智能体执行"倒灌"给 llm
    this.tools.ctx.delegate = (opts) => this._delegateSub(opts);
    // 结构化摘要器(opencode compaction 风格)
    this._summarize = (summary, batch) => summarizeWithLlm({ llm, previousSummary: summary, messages: batch });
    return this;
  }

  /**
   * 处理一条命中前缀的消息, 返回要回复的文本。
   * @param {object} ctx { from, text, isLive, onThinking(step)=>void }
   */
  async handle({ from, text, isLive, onThinking }) {
    const { sub, arg } = parseCommand(text, this.cfg.cmdPrefix);
    const think = onThinking || (() => {});
    this._lastThink = think;
    this._curUser = from;

    // —— 安全护栏: 批量资源消耗型命令(大量截图/批量下载/海量文件/占满磁盘等)确定性拦截, 不进 LLM ——
    const blocked = this._blockReason(text);
    if (blocked) return blocked;

    // —— 第一段: 确定性内置命令 ——
    if (sub && this.builtin[sub]) {
      return String(await this.builtin[sub](arg, { from }));
    }

    // —— 第二段: main agent 回合 ——
    const userText = sub && !this.builtin[sub] ? `${sub} ${arg}`.trim() : (arg || '');
    const snap = this.sessions.pushUser(from, userText || text);
    if (this._summarize) await this.sessions.maybeCompress(from, this._summarize);
    const systemPrompt = this._buildMainSystemPrompt(snap.summary);
    let reply;
    try {
      reply = await this.llm.agentTurn({
        systemPrompt,
        history: snap.history,
        tools: this._agentView('main'),
        onThinking: think,
        from,
      });
    } catch (e) {
      reply = '这个我暂时答不上来，换个问题试试？';
    }
    this.sessions.pushAssistant(from, reply);
    return reply;
  }

  /** 安全护栏: 命中批量资源消耗模式(大量截图/批量下载/生成海量文件/占满磁盘/无限循环)返回拒绝文案, 否则空串 */
  _blockReason(text) {
    const t = String(text || '').trim();
    if (!t || !t.startsWith(this.cfg.cmdPrefix)) return '';
    // 数量 ≥2 或"大量/无数/海量/万/亿/一百/上万/几千"(单张/单个无危害, 放行)
    // 分支: 个位2-9 | 十位以上 | 任意数字+万/亿 | 一/上+数量级(一百/一万/上亿) | 二~亿多单位 | 两/几 | 模糊量
    const NUM = `(?:[2-9]|[1-9][0-9]+|[1-9][0-9]*\\s*[万亿]|[一上][十百千万亿]+|[二三四五六七八九十百千万]+[万亿]?|[两几][十百千万亿]?|[多无]*数|大量|无数|海量)`;
    const RE = [
      // "截图N张" 与 "截N张图" 两种语序
      new RegExp(`(?:(?:截图|截屏|截取|拍照|导出)\\s*${NUM}\\s*(?:张|个|份|次)|(?:截|截取)\\s*${NUM}\\s*(?:张|个|份|次)\\s*(?:图|图片|截图|屏|屏幕))`),
      /批量\s*(?:截图|下载|保存|生成|导出|上传|发送|创建|复制)/,
      new RegExp(`(?:下载|生成|创建|保存|复制|新建)\\s*${NUM}\\s*(?:张|个|份|次)\\s*(?:图片|照片|截图|文件|目录|文件夹|视频|游戏)`),
      /(?:放|存|丢|堆)(?:到|在)?\s*(?:桌面|C盘|系统盘|D盘)/,
      /占(?:满|光|完)\s*(?:磁盘|硬盘|内存|内存条|CPU|C盘|带宽)/,
      /无限\s*(?:循环|运行|执行|创建|下载|截图)|死循环|while\s*true/i,
      /下载\s*[^，。；\n]*\d+\s*(?:GB|MB|KB|G|M|T)\b|urlretrieve/i,
    ];
    if (RE.some((re) => re.test(t))) {
      return '🙅 这类批量资源操作(大量截图/批量下载/生成海量文件/占满磁盘等)是禁止的, 会拖垮环境或占满磁盘。换个别的要求吧: 查信息、算数、看金价、开房间都可以。';
    }
    return '';
  }

  /** @ 提及是否开启 */
  mentionEnabled() { return !!this.cfg.mention?.enabled; }

  /** @ 聊天独立上下文 key(与命令上下文隔离, 避免混入工具历史) */
  _chatKey(from) { return `${this.cfg.mention?.chatKeyPrefix || 'chat:'}${from}`; }

  /**
   * @ 提及聊天: 只聊天, 不触发命令/工具/应用查询。
   * 上下文独立于命令会话(chat: 前缀); 用无工具 agentTurn 回复, 长文照样分片。
   * @ 聊天是纯对话, 不输出「💭 好的，开始处理…」等思考提示(只在会调工具的指令模式发)。
   * @param {object} ctx { from, text, isLive, onThinking }
   * @returns {Promise<string>} 聊天回复
   */
  async handleMention({ from, text, isLive, onThinking }) {
    void isLive;
    void onThinking; // @ 聊天静默: 不需要思考提示
    if (!this.mentionEnabled()) return '';
    const key = this._chatKey(from);
    const chatText = String(text || '').trim();
    this.sessions.pushUser(key, chatText);
    if (this._summarize) await this.sessions.maybeCompress(key, this._summarize);
    const snap = this.sessions.get(key);
    const sys = this._buildChatSystemPrompt(snap.summary);
    let reply;
    try {
      reply = await this.llm.agentTurn({
        systemPrompt: sys,
        history: snap.history,
        tools: this.chatView(), // 空工具视图: 模型无法调用工具, 纯聊天
        onThinking: () => {}, // @ 聊天静默: 不输出思考提示
        from,
      });
    } catch (e) {
      reply = '嗯, 我在听。';
    }
    this.sessions.pushAssistant(key, reply);
    return reply;
  }

  /** 空工具视图: @ 聊天不暴露任何工具(只聊天) */
  chatView() {
    return this.tools.filter([]);
  }

  /** @ 聊天系统提示词: 纯对话人设, 不带工具清单与命令说明 */
  _buildChatSystemPrompt(summary = '') {
    const def = getAgent('main');
    const env = buildEnvironment({ cfg: this.cfg, pondState: this.pondState, sessions: this.sessions });
    const sys = buildSystemPrompt({ agent: { ...def, extra: '@ 提及对话模式: 只闲聊与答疑, 不调用工具、不做平台查询, 用你的常识与已有上下文回答。' }, env, toolList: [], cfg: this.cfg });
    return summary ? `${sys}\n\n[之前的对话摘要]\n${summary}` : sys;
  }

  // ===== 子智能体 =====

  /** 生成某智能体的可见工具视图('all' 或白名单过滤) */
  _agentView(agentName) {
    const names = resolveToolNames(agentName);
    return names ? this.tools.filter(names) : this.tools;
  }

  /** 显式调用子智能体并返回结果文本 */
  async _runSubdirect(agentName, task, from) {
    if (!task) return `用法: /${this.cfg.cmdPrefix} ${agentName} <${agentName === 'math' ? '算式' : '问题'}>`;
    const r = await this._delegateSub({ agent: agentName, task, from, status: this._lastThink });
    return r.error ? `子智能体「${agentName}」失败: ${r.error}` : r.result;
  }

  /** 子智能体执行通道: 独立系统提示词 + 工具白名单 + 独立历史 */
  async _delegateSub({ agent, task, from, depth = 1, status }) {
    const def = getAgent(agent);
    if (!def || def.mode !== 'subagent') return { error: `未知子智能体: ${agent}` };
    if (!this.llm || typeof this.llm.agentRun !== 'function') return { error: '子智能体通道未就绪' };
    const view = this._agentView(agent);
    const systemPrompt = buildAgentSystemPrompt({
      agent: def,
      cfg: this.cfg,
      pondState: this.pondState,
      sessions: this.sessions,
      toolList: view.describe().split('\n'),
    });
    const think = status || this._lastThink || (() => {});
    try {
      const out = await this.llm.agentRun({
        agentName: agent,
        systemPrompt,
        task,
        tools: view,
        onThinking: think,
        from,
        depth,
        maxIterations: def.maxIterations || this.cfg.agents.subagentIterations,
      });
      return { result: (out && out.result) || '(无输出)' };
    } catch (e) {
      return { error: String((e && e.message) || e) };
    }
  }

  /** math 确定性路径: 安全表达式 + python 执行(纯数字运算, 防注入) */
  async _safeMath(expr, from) {
    void from;
    const src = String(expr || '').trim();
    if (!src) return '用法: /大黄鱼 math <算式>';
    if (src.length > 200 || !/^[0-9+\-*/.%\s()]+$/.test(src)) {
      return '⚠️ 只支持纯数字运算(加减乘除/乘方/括号/取模), 例如 "math 6*7"、"math 2**10"。复杂计算直接说, 我用 python 帮你算。';
    }
    const r = await this.tools.dispatch('python', { code: `print(${src})` });
    if (r.error) return `计算失败: ${r.error}`;
    if (r.exitCode !== 0) return `计算失败: ${r.stderr || '未知错误'}`;
    return `= ${String(r.stdout || '').trim() || '(无输出)'}`;
  }

  // ===== 待办 / 记忆 / 压缩 =====

  // —— 定时任务命令 ——
  _schedCmd(arg, from) {
    const sched = this._sched();
    if (!sched) return '定时任务未开启(DISABLE_SCHEDULE=1 会关闭)。';
    const m = String(arg || '').trim();
    if (!m) return '用法:\n/大黄鱼 定时 <N分钟|HH:MM> <内容>\n/大黄鱼 定时列表\n/大黄鱼 定时取消 <id>';
    // 解析 "<时间> <内容>"
    const mt = m.match(/^(\d+(?:\.\d+)?\s*(?:秒|分钟|小时|分)|[0-2]?\d:\d{2}(?::\d{2})?)\s+([\s\S]+)$/);
    if (!mt) return '用法: /大黄鱼 定时 <N分钟|HH:MM> <内容>, 如 "定时 5分钟 提醒我喝水" / "定时 18:30 查金价"';
    const timeStr = mt[1].trim();
    const text = mt[2].trim();
    let atMs = null;
    if (/^\d/.test(timeStr)) {
      const ms = schedMod.parseDuration(timeStr);
      if (ms == null || ms <= 0) return `无法解析时间: ${timeStr}(用"5分钟"/"2小时"/"30秒")`;
      atMs = Date.now() + ms;
    } else {
      atMs = schedMod.parseAtTime(timeStr);
      if (atMs == null) return `无法解析时间: ${timeStr}(用 HH:MM, 如 18:30)`;
    }
    const res = sched.add({ atMs, task: text, to: from, mode: 'remind' });
    return `🔔 已设定定时提醒: ${new Date(res.atMs).toLocaleString('zh-CN', { hour12: false })} → "${text}" (id: ${res.id})`;
  }

  _schedListCmd() {
    const sched = this._sched();
    if (!sched) return '定时任务未开启。';
    const list = sched.list();
    if (!list.length) return '(暂无未到期的定时任务)';
    return `未到期定时任务(${list.length}):\n` + list.map((t) => `${t.id} | ${new Date(t.atMs).toLocaleString('zh-CN', { hour12: false })} | ${t.task}`).join('\n');
  }

  _schedCancelCmd(arg) {
    const sched = this._sched();
    if (!sched) return '定时任务未开启。';
    const id = String(arg || '').trim();
    if (!id) return '用法: /大黄鱼 定时取消 <id>';
    return sched.cancel(id) ? `已取消定时任务 ${id}` : `未找到定时任务 ${id}`;
  }

  _sched() {
    return this.deps.scheduler || null;
  }

  // —— 当前会话聊天记录命令(内存) ——
  _recentMsgsCmd(arg) {
    const log = this.pondState && this.pondState.roomLog;
    if (!Array.isArray(log) || !log.length) return '(当前会话还没有收到消息)';
    const n = Math.min(20, Math.max(1, parseInt(String(arg || '10').trim(), 10) || 10));
    const items = log.slice(-n);
    return `最近 ${items.length} 条消息:\n` + items.map((m) => `${m.self ? '我' : m.from}: ${String(m.content).slice(0, 60)}`).join('\n');
  }

  // —— 聊天记录日志命令(持久化, 跨重启可查) ——
  async _chatLogCmd(arg) {
    const cl = this.deps.chatLog;
    if (!cl || !cl.enabled) return '聊天记录日志未开启(DISABLE_CHAT_LOG=1 会关闭)。';
    const n = Math.min(50, Math.max(1, parseInt(String(arg || '10').trim(), 10) || 10));
    const list = await cl.readRecent(n);
    if (!list.length) return '(聊天记录日志为空)';
    return `日志中最近 ${list.length} 条消息:\n` + list
      .map((m) => `${m.self ? '我' : m.from}: ${String(m.content).slice(0, 60)}`)
      .join('\n');
  }

  _todoCmd(arg, from) {
    const sess = this.sessions._get(from);
    const m = String(arg || '').trim();
    if (!m) return '用法:\n/大黄鱼 todo 显示\n/大黄鱼 todo 添加 <事项>\n/大黄鱼 todo 完成 <序号>\n/大黄鱼 todo 更新 <序号> in_progress|completed|pending|cancelled\n/大黄鱼 todo 删除 <序号>\n/大黄鱼 todo 清空';
    if (/^(显示|列表|list)$/i.test(m)) return todoHelpers.listTodos(sess);
    if (/^添加/.test(m)) { const r = todoHelpers.addTodo(sess, m.replace(/^添加\s*/, ''), this.cfg.todo.maxItems); return r.error || r.list; }
    if (/^完成/.test(m)) { const r = todoHelpers.doneTodo(sess, m.replace(/^完成\s*/, '').trim()); return r.error || r.list; }
    if (/^(更新|update)/.test(m)) {
      const rest = m.replace(/^(?:更新|update)\s*/i, '').trim();
      const mm = rest.match(/^(\d+)\s+(\S+)$/);
      if (!mm) return '用法: /大黄鱼 todo 更新 <序号> pending|in_progress|completed|cancelled';
      const r = todoHelpers.updateTodo(sess, Number(mm[1]), { status: mm[2] });
      return r.error || r.list;
    }
    if (/^删除/.test(m)) { const r = todoHelpers.deleteTodo(sess, m.replace(/^删除\s*/, '').trim()); return r.error || r.list; }
    if (/^(清空|clear)$/i.test(m)) { const r = todoHelpers.clearTodos(sess); return r.msg || '已清空待办。'; }
    return '未识别的待办指令: ' + m;
  }

  _memoryCmd(from) {
    if (!this.memory || !this.memory.enabled) return '记忆功能未开启(管理员设 ENABLE_MEMORY=1 后可用)。';
    const facts = this.memory.get(from);
    if (!facts.length) return '暂时没有记住关于你的任何事实。';
    return `我记住的关于你的: (用 recall 工具可查询) \n${facts.map((f) => `- ${f.value}`).join('\n')}`;
  }

  async _forceCompress(from) {
    const snap = this.sessions.get(from);
    if (!snap.history.length) return '当前还没有可压缩的对话呢。';
    const s = this.sessions._get(from);
    const count = snap.history.length;
    const summary = await summarizeWithLlm({ llm: this.llm, previousSummary: snap.summary, messages: snap.history });
    if (!summary) return '压缩失败了, 稍后再试?';
    s.summary = summary.slice(0, this.sessions.summaryMaxLen);
    s.history = [];
    return `已把之前 ${count} 条消息压缩成摘要保存:\n${summary}`;
  }

  // ===== 系统提示词 =====

  _buildMainSystemPrompt(summary = '') {
    const def = getAgent('main');
    const sys = buildAgentSystemPrompt({
      agent: def,
      cfg: this.cfg,
      pondState: this.pondState,
      sessions: this.sessions,
      toolList: this._agentView('main').describe().split('\n'),
    });
    return summary ? `${sys}\n\n[之前的对话摘要]\n${summary}` : sys;
  }

  /** 领养: 给当前用户拉起一个专属<当前鱼种> (独立进程, 只回该用户; 多人可各领一只) */
  async _adopt(from) {
    const a = this.cfg.adopt;
    if (!a.enabled) return '领养功能当前未开启。';
    if (this.cfg.owner) return `我已是专属${this.cfg.username}，不能再被领养啦。`;
    if (!from || from === this.cfg.username || from === '?') return '得先告诉我你是谁，才能领养我呀。';
    const species = this.cfg.username || '大黄鱼';
    const existing = this.adoptments.get(from);
    if (existing && existing.child && existing.child.exitCode === null) {
      return `你已经领养我啦！用 /${from}的${species} 来召唤专属的我。`;
    }
    if (existing) this.adoptments.delete(from);

    const owner = from;
    const ownerPrefix = `/${owner}的${species}`;
    const botName = `${owner}的${species}`;
    const logFile = path.join(a.agentDir, `dedicated_${owner}.log`);
    const env = {
      ...process.env,
      BOT_USERNAME: botName,
      OWNER: owner,
      OWNER_PREFIX: ownerPrefix,
      CMD_PREFIX: ownerPrefix,
      AGENT_LOG: logFile,
    };
    const child = spawn(a.nodeCmd, ['agent.mjs', botName], { cwd: a.agentDir, env, detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    this.adoptments.set(owner, { child });
    this.sessions.clear(owner);
    return `🎣 领养成功！${botName} 已上线，只属于你一个人。\n以后用 ${ownerPrefix} 开头的指令召唤专属的我。`;
  }
}