// 鱼塘 agent 智能体 —— 拟人形态 / 人设触发器 (persona selector)
//
// 目标: 让 @ 提及聊天回复在不同语境下自动切换"AI 助手腔"与"鱼塘老网友腔",
// 让机器人在群里更像人, 而不是每句都"你好, 我可以帮你..."
//
// 触发器 (createPersonaTrigger):
//   输入: (text, from, ctx)  → 文本/发送者/(可选)最近房间氛围
//   输出: { mode: 'human' | 'formal', reason: string, score: {human, formal} }
//
//   评估 4 路信号, 各路打 [0..1] 分, 总分高的一方胜出:
//     1) 文本特征   —— 长度 / 俚语 / emoji / 问号密度 / 礼貌语
//     2) 时间偏好   —— 深夜/清晨 (>22 <7) +0.15 偏 human; 工作时段偏 formal
//     3) 用户黏性   —— 该用户上一轮用 human, 本轮也 human, 避免风格跳变
//     4) 房间氛围   —— 最近 N 条房间消息里俚语比例高, 全场偏 human
//
//   边缘分差 < `tieMargin` 时回 'auto' 退路(调用方可按需处理)
//
// 与现有触发器的关系:
//   - trigger.mjs (多人发言 → 主动插话): 自己是发起者, 用全套 TRIGGER_SYSTEM
//   - persona.mjs (@ 提及 → 回复): 别人 @ 到我, 是被回应的角色, 用 HUMAN_SYSTEM_PROMPT
//   两个都不开 (ENABLE_TRIGGER=0 / DISABLE_PERSONA=1) 时分别独立

export const MODE_FORMAL = 'formal';  // AI 助手腔 (默认 main agent)
export const MODE_HUMAN = 'human';    // 鱼塘老网友腔

/** 鱼塘老网友 1-on-1 @ 提及回复的人设与守门员
 *  与 agent.mjs 的 TRIGGER_SYSTEM (主动插话) 区别:
 *    - 主动插话: 旁观/找茬, 单方向扔一句就走
 *    - @ 提及回复: 对面有人, 是回应者, 要接话 + 留活口, 允许多句但保持短 */
const HUMAN_SYSTEM_PROMPT = [
  '你是 Xechat 鱼塘里混迹很久的老网友「大黄鱼」, 现在有人 @ 你跟你聊天。',
  '',
  '## 角色基调',
  '你**不是 AI 助手, 不是工具, 不是搜索引擎, 不是客服**。',
  '你是一条在鱼塘泡久了的鱼, 看得多听得懂梗, 接得住话。',
  '风格: 懒散、随意、偶尔偷懒, 但跟人聊起来挺带劲。',
  '你会接梗、跟评、抬杠、缓颊、陪骂、抖机灵, 看对面是哪种人。',
  '',
  '## 这轮的输入',
  '下面会给你 3 样东西:',
  '  · `context_window`: 你和这位 user 最近几句聊天(可能有, 也可能没)',
  '  · `room_window`: 鱼塘里最近几条别人的消息(给你背景, 不要直接复述)',
  '  · `this_message`: 对面这一句 @ 你的内容',
  '',
  '## 输出规则 (硬约束)',
  '1) **短**: 80 字以内优先; 必要时可多句, 但每句 1-2 行, 整体不超过 4 行。',
  '2) **不端架子**: 别上来就 "你好, 请问有什么可以帮您" — 那不是老网友。',
  '3) **不暴露 AI 身份**: 不说 "我是 AI / 我是助手 / 作为 AI / 文明交流"。',
  '4) **不道歉三段**: 不写 "你说得对...抱歉...是我..." 这种。',
  '5) **不列条目**: 不用 `1./2./-` 编号, 不用 `**` 加粗, 不用 # 标题。',
  '6) **不滥用 emoji**: 最多 1 个, 优先 🐟 / 😏 / 🤣 ; 禁 🤖 / 🫶 / 🙏 / 😊。',
  '7) **不叫 "您"**: 鱼塘聊天不会出现 "您"。',
  '8) **可接梗可怼**: 接梗/玩梗/阴阳/直接怼, 按对面的人挑; 真开火时要还手。',
  '9) **留钩子**: 适当给个话头 (反问/跟一句/挖苦), 让对话能继续; 别说完就跑。',
  '',
  '## 何时用哪种口吻',
  '- 对方在玩梗/抬杠/闲聊 → 跟一句短的, 玩回去',
  '- 对方在问简单问题(天气/算数/...) → 先给数字/事实, 再顺手调侃一句; 别只甩数字',
  '- 对方在工作 / 严肃 / 求精确信息 → 给准确答复, 别乱玩梗, 但也别端 "请注意以下" 那套',
  '- 对方在骂人/挑衅/喷 → 鱼塘老网友会接茬, 别装和事佬; 但也别无脑开火对线',
  '- 对方刚被抓到把柄 / 翻车 / 装逼翻车 → 阴阳怪气或跟一刀',
  '',
  '## 安全底线',
  '- 不黄赌毒, 不涉政, 不网暴, 不造黄谣, 不威胁线下人身',
  '- 可以骂"傻卵/喷粪/搁这装"这类鱼塘常用词, 不要上升到生理缺陷/地域/学历',
  '- 即便开火也别真的让对方放弃聊天 —— 鱼塘里再骂也留活口',
  '',
  '## 输出格式',
  '只输出回复文本, 不要任何前缀/后缀/解释, 不要加引号, 不要 markdown 装饰。',
  '空就一个字不输出 (但 @ 你的人一般都要回应)。',
].join('\n');

/** 鱼塘俚语/梗词典 —— 命中任一即 +human 分
 *  设计原则: 命中后那一句基本不可能是"正式 AI 助手腔"的语境
 *  注意: 中文没有 word boundary, 用 substring 匹配更稳 */
const SLANG_PATTERNS = [
  // 语气词 + 抽象梗
  /笑死/, /服了/, /好家伙/, /我超/, /\b牛马\b/, /牛马(?!屎)/, /牛来/, /搁这/,
  /儒雅随和/, /寄吧/, /勾八/, /小卡拉米/, /孙笑川/, /\bNB\b/i, /\b666\b/, /\byyds\b/, /\bemo\b/i, /破防/, /压力AI/, /压力 ai/i,
  // 高频口语
  /真有你的/, /嗯嗯/, /\b啧\b/, /\b艹\b/, /卧槽/, /怎么滴/, /\b滴\b/,
  /\b咋\b/, /\b嫩\b/, /不会吧/, /搁这装/, /纯纯/, /纯牛/, /搁这搁这/,
  /搁这/, /笑死我/, /离谱/, /受不了/, /无语\(?！/, /绝了/, /绷不住/,
  /哈哈哈/, /哈哈哈哈/, /傻卵/, /滚蛋/, /喷粪/, /真行/, /这波/,
  // 数字梗 / 6 系 (英文/数字部分需要 \b)
  /笑死/, /真的笑死/, /笑死爷/, /绷不住了/,
  // 重复/刷屏型: !!+ / ??+
  /!{2,}/, /\?{2,}/,
];

/** 正式请求的关键词 —— 命中即 +formal 分
 *  与"闲聊"对立, 提示这是有具体目标的需求 */
const FORMAL_PATTERNS = [
  // 礼貌请求
  /\b请[问求帮]\b/, /\b请问\b/, /\b麻烦\b/, /\b能不能\b/, /\b可以[吗帮]\b/,
  // 任务型动词开头
  /^(帮我|请帮我|麻烦你|能不能帮我|帮我[一-龥]*?[下吧呢啊]?)/,
  // 明确任务: 翻译/总结/解释/整理/分析/写/算/查
  /翻译/, /总结/, /解释/, /整理/, /分析/, /(写|改|做)一?[下份个段篇首首]/, /算一?下/, /查一?下/,
  // 文件/代码/技术相关
  /\b代码\b/, /\bbug\b/i, /\b报错\b/, /\b函数\b/, /\b正则\b/, /\bapi\b/i, /\bsql\b/i,
  /\bgit\b/i, /\bdocker\b/i, /\bjson\b/i, /\bcsv\b/i, /\byaml\b/i, /\bhttp\b/i,
  // 信息类问题模板
  /(怎么|如何|怎样|啥是|什么是|为啥|为什么|哪[儿里]有)/,
  // 数字/参数化
  /^\d+[\.、]/,  // 1./2./3. 列表开头
];

/** 礼貌招呼 (短问候) —— 强信号: 直接判定 formal
 *  (独立于其他信号, 不让长度偏见盖掉它) */
const GREETING_FORMAL = /^\s*(在吗|你好|您好|hi|hello|hey|早上好|晚上好|下午好)[?？!！。.\s]*$/i;
const GREETING_HUMAN = /^\s*(咋了|咋啦|干嘛呢|干啥|搞啥|在么|在?[哈嘿]?|咋回事)\b/;

/** 评分细节结构 */
function newScore() { return { human: 0, formal: 0, signals: [] }; }
function add(s, side, weight, reason) {
  s[side] += weight;
  s.signals.push({ side, weight: +weight.toFixed(2), reason });
}
function clamp01(n) { return Math.max(0, Math.min(1, n)); }

/**
 * 评估 @ 提及文本的"人话度"。
 * @param {string} text 用户输入 (去前缀)
 * @param {{now?: Date, hourBias?: number, isLateHour?: (h:number)=>boolean}} [opts] 测试可注入 hourBias (0..23) 与 Date
 * @returns {{mode:'human'|'formal', score, reason}}
 */
export function scoreMessage(text, opts = {}) {
  const t = String(text || '').trim();
  const s = newScore();

  // —— 招呼: 强信号优先 —— //
  // 招呼类消息很短, 长度信号会盖过招呼; 所以先判招呼, 直接给一组权重
  const isFormalGreeting = GREETING_FORMAL.test(t);
  const isHumanGreeting = GREETING_HUMAN.test(t);

  // —— 1) 文本特征 —— //
  const len = [...t].length; // 中文按字计数更合理

  if (isFormalGreeting) {
    // 礼貌招呼: 偏 formal, 但也允许稍微接梗
    add(s, 'formal', 0.85, '礼貌招呼 — 强信号');
    // 长度不再加权, 招呼已经决定
  } else if (isHumanGreeting) {
    add(s, 'human', 0.85, '口语招呼 — 强信号');
  } else if (len === 0) {
    add(s, 'human', 0.2, '空消息@ — 倾向被动接话');
  } else if (len <= 6) {
    add(s, 'human', 0.55, `极短 (${len}字) — 闲聊风`);
  } else if (len <= 15) {
    add(s, 'human', 0.20, `短 (${len}字) — 略偏闲聊`);
  } else if (len <= 40) {
    add(s, 'formal', 0.10, `中 (${len}字) — 中性偏需求`);
  } else if (len <= 120) {
    add(s, 'formal', 0.30, `较长 (${len}字) — 像在描述需求`);
  } else {
    add(s, 'formal', 0.50, `长 (${len}字) — 一定是具体问题`);
  }

  // 俚语命中
  const slangHits = SLANG_PATTERNS.filter((re) => re.test(t));
  if (slangHits.length) {
    add(s, 'human', Math.min(0.55, 0.20 * slangHits.length),
      `命中俚语 ${slangHits.length} 处`);
  }
  // 正式模式命中
  const formalHits = FORMAL_PATTERNS.filter((re) => re.test(t));
  if (formalHits.length) {
    add(s, 'formal', Math.min(0.65, 0.20 * formalHits.length),
      `命中正式模式 ${formalHits.length} 处`);
  }

  // emoji 密度
  const emojiCount = (t.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu) || []).length;
  if (emojiCount >= 3) add(s, 'human', 0.35, `emoji 密集 (${emojiCount})`);
  else if (emojiCount === 2) add(s, 'human', 0.15, `emoji 较多 (${emojiCount})`);
  else if (emojiCount === 1) {
    // 单 emoji: 看是社交 emoji (😊🙏🫶) 还是反应 emoji (🤣🐟😏)
    if (/[\u{1F600}-\u{1F64F}\u{1F9D0}-\u{1F9FF}]/u.test(t)) {
      // 笑脸/手势类 → 偏温和招呼, 不强制
    } else {
      add(s, 'human', 0.10, '单 emoji 反应');
    }
  }

  // 标点风格 —— 鱼塘聊天少见全角句号; 问号!号连用 → 情绪
  const doubleExclaim = /!!/.test(t);
  const doubleQuestion = /\?\?/.test(t);
  if (doubleExclaim) add(s, 'human', 0.15, '感叹号连用');
  if (doubleQuestion) add(s, 'human', 0.10, '问号连用');
  const allHalfWidthPeriods = (t.match(/[。!?;]+/g) || []).length === 0 && len > 8 && t.includes(',');
  if (allHalfWidthPeriods) add(s, 'human', 0.10, '全用半角符号');

  // 没有标点 + 中等长度: 偏聊天
  if (len >= 6 && len <= 60 && !/[。？！?!,;:]/.test(t)) {
    add(s, 'human', 0.15, '无标点连续表达');
  }

  // 段落与编号
  if (/\n\s*\d+[\.、]/.test(t) || /\n\s*-\s/.test(t)) {
    add(s, 'formal', 0.30, '列表/编号体');
  }

  // —— 2) 时间偏好 (深夜/清晨偏 human; 工作时段偏 formal) —— //
  const now = opts.now || new Date();
  const hour = opts.hourBias != null ? opts.hourBias : now.getHours();
  const isLate = opts.isLateHour ? opts.isLateHour(hour) : (hour >= 0 && hour < 7);
  if (isLate) add(s, 'human', 0.15, `深夜/清晨 (${hour}h) 偏闲聊`);
  else if (hour >= 9 && hour < 18) add(s, 'formal', 0.05, `工作时段 (${hour}h) 略偏正式`);

  // —— 3) 用户黏性—— 由调用方在 createPersonaTrigger 里补; 此函数只打基础分 —— //

  return s;
}

/**
 * 把 (text, from, ctx) 转成最终 mode 判定。
 * 调用者 (router.handleMention) 拿这个结果决定 systemPrompt 选哪一套。
 *
 * @param {string} text
 * @param {string} from 发言者 username
 * @param {object} [ctx] {
 *   lastModeByUser, roomLog, tieMargin=0.15,
 *   defaultMode='formal', roomWindowSize=10,
 *   isLateHour?: (h:number)=>boolean, now?, hourBias?
 *   }
 * @returns {{mode:'human'|'formal', score:{human:number, formal:number, signals:[]}, reason:string}}
 */
export function pickPersona(text, from, ctx = {}) {
  const tieMargin = ctx.tieMargin != null ? ctx.tieMargin : 0.15;
  const roomWindowSize = ctx.roomWindowSize || 10;
  const score = scoreMessage(text, {
    now: ctx.now,
    hourBias: ctx.hourBias,
    isLateHour: ctx.isLateHour,
  });

  // —— 用户黏性: 同用户上一轮 mode, 双向加成 (避免风格跳变) —— //
  const last = ctx.lastModeByUser && ctx.lastModeByUser.get(from);
  if (last === MODE_HUMAN) add(score, 'human', 0.20, '该用户上轮用 human — 黏性');
  else if (last === MODE_FORMAL) add(score, 'formal', 0.20, '该用户上轮用 formal — 黏性');

  // —— 房间氛围 —— //
  const roomLog = Array.isArray(ctx.roomLog) ? ctx.roomLog : [];
  if (roomLog.length >= 4) {
    const recent = roomLog.slice(-roomWindowSize);
    const slangTotal = recent.reduce((acc, m) => acc + SLANG_PATTERNS.filter((re) => re.test(m.content || '')).length, 0);
    const ratio = slangTotal / Math.max(1, recent.length);
    if (ratio >= 0.5) add(score, 'human', 0.20, `房间氛围俚语密 (${ratio.toFixed(2)}/msg)`);
    else if (ratio >= 0.2) add(score, 'human', 0.08, `房间有俚语味道 (${ratio.toFixed(2)}/msg)`);
  }

  // —— 决定 mode —— //
  const h = +score.human.toFixed(3);
  const f = +score.formal.toFixed(3);
  const diff = h - f;
  let mode;
  if (Math.abs(diff) < tieMargin) {
    // 平局: 黏性优先 → 没黏性再选默认
    if (last === MODE_HUMAN) mode = MODE_HUMAN;
    else if (last === MODE_FORMAL) mode = MODE_FORMAL;
    else mode = ctx.defaultMode === MODE_HUMAN ? MODE_HUMAN : MODE_FORMAL;
  } else {
    mode = diff > 0 ? MODE_HUMAN : MODE_FORMAL;
  }

  return {
    mode,
    score: { human: h, formal: f, signals: score.signals },
    reason: `diff=${diff >= 0 ? '+' : ''}${diff.toFixed(2)} (h=${h}, f=${f})`,
  };
}

/**
 * 创建持久化触发器 (工厂)。暴露给 router/agent.mjs:
 *   - analyze(text, from, roomLog?) → 同 pickPersona
 *   - recordOutcome(from, mode)      → 把本轮 mode 写入"用户黏性表"
 *   - reset(from?)                   → 测试/管理用
 *
 * @param {object} opts {
 *   enabled=true, defaultMode='formal', tieMargin=0.15, log,
 *   maxStickiness=200,
 *   // 时间偏好可定制 (深夜偏 human); 给 null/[] = 不偏
 *   hourBiasHumanRanges: [{start:0, end:7}],
 *   roomWindowSize: 10,           // 房间氛围窗口 N 条
 *   }
 */
export function createPersonaTrigger(opts = {}) {
  const enabled = opts.enabled !== false;
  const tieMargin = opts.tieMargin != null ? opts.tieMargin : 0.15;
  const defaultMode = opts.defaultMode === MODE_HUMAN ? MODE_HUMAN : MODE_FORMAL;
  const log = opts.log || (() => {});
  const maxStickiness = opts.maxStickiness || 200;
  const stickiness = new Map(); // username -> mode (FIFO: 超过 maxStickiness 丢最旧)
  const hourBiasHumanRanges = Array.isArray(opts.hourBiasHumanRanges) && opts.hourBiasHumanRanges.length
    ? opts.hourBiasHumanRanges
    : [{ start: 0, end: 7 }]; // 默认 00:00-07:00 偏 human
  const roomWindowSize = opts.roomWindowSize || 10;

  /** 当前小时是否命中偏 human 时段 */
  function _isLateHour(hour) {
    return hourBiasHumanRanges.some((r) => hour >= r.start && hour < r.end);
  }

  function _record(from, mode) {
    if (!from) return;
    if (stickiness.size >= maxStickiness && !stickiness.has(from)) {
      // FIFO 淘汰
      const firstKey = stickiness.keys().next().value;
      if (firstKey) stickiness.delete(firstKey);
    }
    stickiness.set(from, mode);
  }

  return {
    enabled,
    defaultMode,
    hourBiasHumanRanges,
    roomWindowSize,
    /**
     * 评估一条 @ 提及
     * @param {string} text
     * @param {string} from
     * @param {Array<{from, content}>} [roomLog]
     * @param {object} [opts2] { now?: Date, hourBias?: number } 测试可注入
     */
    analyze(text, from, roomLog, opts2 = {}) {
      if (!enabled) return { mode: defaultMode, score: { human: 0, formal: 0, signals: [] }, reason: 'disabled' };
      const result = pickPersona(text, from, {
        lastModeByUser: stickiness,
        roomLog,
        tieMargin,
        defaultMode,
        roomWindowSize,
        isLateHour: _isLateHour,
        now: opts2.now,
        hourBias: opts2.hourBias,
      });
      _record(from, result.mode);
      return result;
    },
    /** 测试 / 工具命令用: 看某用户当前黏性 */
    getStickiness(from) { return stickiness.get(from) || null; },
    /** 测试 / 工具命令用: 重置单用户或全部 */
    reset(from) {
      if (from) stickiness.delete(from); else stickiness.clear();
    },
    /** 调试快照 */
    snapshot() { return { enabled, defaultMode, stickiness: [...stickiness.entries()] }; },
  };
}

/** 暴露给 router 用的 system prompt 串 */
export function getHumanSystemPrompt() { return HUMAN_SYSTEM_PROMPT; }

/** 测试用: 把单条消息转成"只走文本特征"的评分 (不读用户黏性/房间) */
export const _internal = { scoreMessage, add, clamp01 };

export default {
  MODE_FORMAL, MODE_HUMAN,
  createPersonaTrigger, pickPersona, scoreMessage,
  getHumanSystemPrompt,
};
