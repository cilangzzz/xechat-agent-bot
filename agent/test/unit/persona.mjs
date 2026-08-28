// agent 测试 —— 拟人触发器 (persona.mjs) 单元测试
// 覆盖: 文本特征 / 时间偏好 / 用户黏性 / 房间氛围 / 平局退路 / FIFO 黏性淘汰 / persona 内置命令
import {
  MODE_FORMAL, MODE_HUMAN,
  createPersonaTrigger, createPersonaEngine, pickPersona, scoreMessage, getHumanSystemPrompt,
  enrichDecision, humanizeReply,
} from '../../lib/business/persona.mjs';
import { Router } from '../../lib/business/router.mjs';
import { SessionStore } from '../../lib/business/sessions.mjs';
import { XechatApi } from '../../lib/platform/xechat-api.mjs';
import { createRegistry } from '../../lib/business/tools/index.mjs';
import { fakeApiFetch } from './_fixtures.mjs';
import { check } from './_state.mjs';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export async function run() {
  console.log('[9] persona 拟人触发器');

  // —— 9.1 scoreMessage 文本特征 —— //
  {
    // 极短 → 偏 human
    const s1 = scoreMessage('哈哈', { hourBias: 14 });
    check('极短"哈哈"应偏 human', s1.human > s1.formal, `h=${s1.human} f=${s1.formal}`);
    check('极短"哈哈"应有"极短"信号', s1.signals.some((x) => /极短/.test(x.reason)));

    // 长正式请求 (>120 字)
    const longText = '请帮我详细整理一下这份关于鱼塘生态系统的报告: 第一章介绍鱼塘基本概念, 第二章介绍常见的鱼类种类与栖息地分布, 第三章介绍水质管理与生态循环系统, 第四章介绍鱼塘养殖技术与产量统计, 第五章介绍经济价值与产业链分析, 第六章介绍未来发展趋势与挑战, 第七章是参考文献与附录';
    const s2 = scoreMessage(longText, { hourBias: 14 });
    check('长正式请求应偏 formal', s2.formal > s2.human, `h=${s2.human} f=${s2.formal}`);
    check('应有"长"或"较长"信号', s2.signals.some((x) => /较?长 \(\d+字\)/.test(x.reason)),
      `signals: ${s2.signals.map((x) => x.reason).join('; ')}`);

    // 俚语 → 偏 human
    const s3 = scoreMessage('好家伙, 搁这装呢? 笑死我了 🤣', { hourBias: 14 });
    check('俚语浓应偏 human', s3.human > s3.formal, `h=${s3.human} f=${s3.formal}`);
    check('应命中俚语信号', s3.signals.some((x) => /俚语 \d+ 处/.test(x.reason)));

    // 礼貌招呼 → 偏 formal
    const s4 = scoreMessage('你好', { hourBias: 14 });
    check('"你好"招呼应偏 formal', s4.formal > s4.human, `h=${s4.human} f=${s4.formal}`);
    check('应有"礼貌招呼"信号', s4.signals.some((x) => /礼貌招呼/.test(x.reason)));

    // 口语招呼 → 偏 human
    const s5 = scoreMessage('咋了', { hourBias: 14 });
    check('"咋了"口语招呼应偏 human', s5.human > s5.formal, `h=${s5.human} f=${s5.formal}`);

    // emoji 密 → 偏 human
    const s6 = scoreMessage('🤣🤣🤣', { hourBias: 14 });
    check('emoji 密应偏 human', s6.human > s6.formal);

    // 列表/编号 → 偏 formal
    const s7 = scoreMessage('帮我看下:\n1. 这个 case 是为啥失败\n2. 下次怎么复现', { hourBias: 14 });
    check('列表应偏 formal', s7.formal > s7.human);
    check('应有"列表/编号体"信号', s7.signals.some((x) => /列表/.test(x.reason)));
  }

  // —— 9.2 时间偏好 (深夜偏 human) —— //
  {
    const dawn = scoreMessage('你在吗', { hourBias: 3 });
    const day = scoreMessage('你在吗', { hourBias: 14 });
    check('凌晨"你在吗"应偏 human', dawn.human > dawn.formal, `h=${dawn.human} f=${dawn.formal}`);
    check(
      '凌晨"你在吗"比白天更偏 human (黏性/黏性未污染)',
      dawn.human > day.human,
      `dawn=${dawn.human} day=${day.human}`,
    );
  }

  // —— 9.3 用户黏性: 同一用户连续 @, 风格不应跳变 —— //
  {
    const t = createPersonaTrigger({ enabled: true, defaultMode: MODE_FORMAL, tieMargin: 0.15 });
    // 第一轮: 模糊文本 (中长), 平局偏 formal
    const r1 = pickPersona('周一要交的东西还没准备好, 你知道几点有 deadline 吗?', 'alice', {
      lastModeByUser: new Map([['alice', MODE_FORMAL]]),
      hourBias: 14,
    });
    check('formal 黏性下模糊提问应选 formal', r1.mode === MODE_FORMAL, `实际: ${r1.mode}`);

    // 第二轮: 用户继续聊, 但这一轮本身偏 human 信号极强, 应切到 human
    const r2 = pickPersona('周一的东西搞完了, 笑死差点忘了', 'alice', {
      lastModeByUser: new Map([['alice', MODE_FORMAL]]),
      hourBias: 14,
    });
    check('formal 黏性但文本强烈 human 应切 human', r2.mode === MODE_HUMAN, `实际: ${r2.mode}`);

    // 第三轮: 模糊文本, human 黏性 — 应仍走 human
    const r3 = pickPersona('那件事最终怎么处理的', 'alice', {
      lastModeByUser: new Map([['alice', MODE_HUMAN]]),
      hourBias: 14,
    });
    check('human 黏性下模糊后续应仍走 human', r3.mode === MODE_HUMAN, `实际: ${r3.mode}`);

    // 平局退路: 没黏性 + 平局 → 默认
    const r4 = pickPersona('嗯', 'newbie', {
      // lastModeByUser 未提供 → 没黏性
      hourBias: 14,
      tieMargin: 5, // 极大 margin, 强制平局
      defaultMode: MODE_FORMAL,
    });
    check('没黏性 + 平局应退回默认 formal', r4.mode === MODE_FORMAL, `实际: ${r4.mode}`);
  }

  // —— 9.4 房间氛围: 俚语密 → 偏 human —— //
  {
    const roomLog = [
      { from: 'u1', content: '笑死, 这也太秀了吧' },
      { from: 'u2', content: '真行, 搁这反复横跳呢' },
      { from: 'u3', content: '好家伙, 儒雅随和' },
      { from: 'u4', content: '服了' },
      { from: 'u5', content: '666 yyds' },
    ];
    const r = pickPersona('你觉得呢', 'bob', {
      lastModeByUser: new Map(),
      roomLog,
      hourBias: 14,
    });
    check('房间俚语密 → 模糊问题"你觉得呢"应偏 human', r.mode === MODE_HUMAN, `实际: ${r.mode}`);
  }

  // —— 9.5 FIFO 黏性淘汰 —— //
  {
    const t = createPersonaTrigger({ enabled: true, maxStickiness: 3 });
    t.analyze('hello', 'a'); // 记录 a=formal (平局 → formal default)
    t.analyze('hello', 'b'); // 记录 b
    t.analyze('hello', 'c'); // 记录 c
    check('3 个用户都已记录', t.snapshot().stickiness.length === 3);
    t.analyze('hello', 'd'); // a 应被淘汰
    const sticky = t.snapshot().stickiness.map(([u]) => u);
    check('第 4 个用户写入时 FIFO 淘汰最早的 a', !sticky.includes('a') && sticky.includes('d'),
      `实际: ${sticky.join(',')}`);
  }

  // —— 9.6 getHumanSystemPrompt (内置李乐儿种子) 存在且非空 —— //
  {
    check('BASE_PERSONA_PROMPT 含李乐儿', /李乐儿/.test(getHumanSystemPrompt()) && /云南/.test(getHumanSystemPrompt()),
      'no 李乐儿/云南 in prompt');
    check('BASE_PERSONA_PROMPT 含示例', /Example/.test(getHumanSystemPrompt()), 'no Example in prompt');
    // v2: 不再默认 "emoji 优先 🐟" (这是 LLM 复读机的根因)
    check('种子不强制 🐟 emoji (避免模型 tell)', !/emoji\s*优先.*🐟/.test(getHumanSystemPrompt()) && !/优先用.*🐟/.test(getHumanSystemPrompt()),
      '仍含固定 emoji 提示');
    check('种子强调分段发', /分段|分多条|连发|不黏长句/.test(getHumanSystemPrompt()), '未提分段');
  }

  // —— 9.6c 真人化随机层 + 防 tell 后处理 —— //
  console.log('[9.6c] 真人化随机层 + humanizeReply');
  {
    // (a) enrichDecision 必须返回 mood/lengthBudget/emojiBudget/typoChance/reply 五个字段
    const seedRng = () => 0.0; // 全用同一种
    const base = pickPersona('好家伙搁这装笑死', 'u1', { lastModeByUser: new Map(), roomLog: [] });
    const enriched = enrichDecision(base, 'u1', { text: '好家伙搁这装笑死', from: 'u1', rng: seedRng });
    check('enrichDecision 返回 mood', typeof enriched.mood === 'string');
    check('enrichDecision 返回 lengthBudget', ['one-liner','short','normal','verbose','essay'].includes(enriched.lengthBudget),
      `bad: ${enriched.lengthBudget}`);
    check('enrichDecision 返回 emojiBudget 0/1/2', [0,1,2].includes(enriched.emojiBudget));
    check('enrichDecision 返回 typoChance', enriched.typoChance >= 0.04 && enriched.typoChance <= 0.16);
    check('enrichDecision 返回 reply', ['respond','lurk','busy'].includes(enriched.reply));

    // (b) 5% 随机 lurk 不该太密也不是 0: 跑 1000 次, 期望 ~50 ± 30
    let lurkCount = 0;
    for (let i = 0; i < 1000; i++) {
      const d = enrichDecision(base, 'u1', { text: '', from: 'u1', rng: Math.random });
      if (d.reply === 'lurk') lurkCount++;
    }
    check('随机 lurk 比例约 5% (容差 1-15%)', lurkCount >= 10 && lurkCount <= 150, `count=${lurkCount}/1000`);

    // (c) humanizeReply: 拆 "嗯嗯, 你说得对, 儒雅随和" 三段 (测试用长上限避免被截断)
    const r1 = humanizeReply('嗯嗯, 你说得对, 儒雅随和', { maxTotalChars: 200, maxSegments: 5 });
    check('humanizeReply 拆经典 AI 模板', r1.includes('\n') && /嗯嗯/.test(r1) && /儒雅随和/.test(r1),
      `actual: ${r1}`);

    // (d) humanizeReply: 拦 "我就是个路过的散户" "我是真人" 那种自我辩护
    check('humanizeReply 改写"我就是个路过的散户"', !/我就是个路过的散户/.test(humanizeReply('我就是个路过的散户, 别乱扣帽子')));
    check('humanizeReply 改写"我是真人"', !/我是真人/.test(humanizeReply('我是真人别怀疑')));
    check('humanizeReply 改写"我不是 AI"', !/我不是 AI/.test(humanizeReply('我不是 AI 你别扣帽子')));

    // (e) humanizeReply: 限制一条消息里的 emoji 数不超过 2 个
    const tooMany = humanizeReply('笑死 🐟 🐟 🐟 🐟 🐟');
    const emojis = (tooMany.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu) || []).length;
    check('humanizeReply emoji 数 ≤2', emojis <= 2, `emoji count=${emojis}`);

    // (f) humanizeReply: 句末的 🐟 拆到独立行
    const last = humanizeReply('好家伙你这操作 🐟');
    check('humanizeReply 句末 🐟 拆独立行', /\n/.test(last) || !last.endsWith('🐟'), `actual: ${last}`);

    // (g) v2 硬截断: 总长 > 50 字 + 段数 > 2 直接砍
    const tooLong = humanizeReply('第一行\n第二行\n第三行\n第四行\n第五行');
    const lineCount = tooLong.split('\n').length;
    check('humanizeReply 段数 ≤2 (硬截断)', lineCount <= 2, `lines=${lineCount}: ${tooLong}`);

    // (h) 骂家庭谐音硬拦 (这是绝对红线, 不管 LLM 输出成什么样都得拦)
    check('humanizeReply 拦"冯"谐音"妈"', !/冯/.test(humanizeReply('操你冯的')));
    check('humanizeReply 拦"立人"谐音"人"', !/立人/.test(humanizeReply('你家立人无了吧')));
    check('humanizeReply 拦"牛魔"谐音"你妈"', !/牛魔/.test(humanizeReply('牛魔死了吧你')));
    check('humanizeReply 拦"福"谐音"妈"', !/福/.test(humanizeReply('尼玛的福')));
    check('humanizeReply 拦"你妈死了"', !/你妈死/.test(humanizeReply('你妈死了 真的')));
    check('humanizeReply 拦"你家人都没了"', !/你家.*(没|亡|无)/.test(humanizeReply('你家人都没了')));
  }

  // —— 9.6b createPersonaEngine: 启动调 LLM 生成 / 缓存 / 失败兜底 —— //
  console.log('[9.6b] persona engine (启动调 LLM 生成人设)');
  // mock 的 prompt 长度 >= 100 字以通过默认 minLength
  const MOCK_GENERATED = '【AI生成的人设】我是李乐儿, 25岁, 视频策划/摄影师, 云南昭通人, 现居北京。说话活泼可爱, 常用哈哈哈, 偶尔用"喃"、"啊"、"哈"等云南语气词; 不会用"呢/耶/~"做结尾, 不端架子, 不暴露 AI 身份。对方熟人可以调侃, 不熟正常自然。';
  const MOCK_REGEN = '【二次生成人设】我是李乐儿, 25 岁。' + 'a'.repeat(100);
  const MOCK_CACHE = '【缓存人设】我是李乐儿, 25岁, 云南昭通人, 现居北京, 北大本科; 说话活泼, 用"哈哈哈"和云南语气词; 不端架子, 不暴露 AI 身份; 对熟人调侃, 不熟正常。' + 'b'.repeat(60);

  {
    // (a) 成功生成
    const logs = [];
    const eng = createPersonaEngine({
      llm: { chat: async () => MOCK_GENERATED },
      log: (s) => logs.push(s),
    });
    check('engine 生成前用种子', /李乐儿/.test(eng.getPrompt()));
    await eng.init();
    const m = eng.getMeta();
    check('engine 生成成功 status=ready', m.status === 'ready', `actual: ${m.status}`);
    check('engine 生成成功 source=generated', m.source === 'generated', `actual: ${m.source}`);
    check('engine 生成后注入 AI 结果', /AI生成的人设/.test(eng.getPrompt()));

    // (b) LLM 失败 → 退回种子
    const eng2 = createPersonaEngine({
      llm: { chat: async () => { throw new Error('api down'); } },
      log: () => {},
    });
    await eng2.init();
    const m2 = eng2.getMeta();
    check('engine 失败兜底 source=base', m2.source === 'base' && m2.status === 'failed', `actual: ${m2.source}/${m2.status}`);
    check('engine 失败兜底内容=李乐儿', /李乐儿/.test(eng2.getPrompt()));

    // (c) 生成结果过短 → 视为失败
    const eng3 = createPersonaEngine({
      llm: { chat: async () => '短', },
      log: () => {},
      minLength: 50,
    });
    await eng3.init();
    check('engine 过短结果兜底 base', eng3.getMeta().source === 'base', `actual: ${eng3.getMeta().source}`);

    // (d) 缓存: 有缓存 & 不 regen → 直接用缓存, 不调 LLM
    const tmpDir = os.tmpdir();
    const cacheFile = path.join(tmpDir, 'persona-test-' + Math.random().toString(36).slice(2) + '.json');
    fs.writeFileSync(cacheFile, JSON.stringify({ persona: MOCK_CACHE, source: 'generated', savedAt: 123 }), 'utf8');
    let llmCalled = false;
    const eng4 = createPersonaEngine({ llm: { chat: async () => { llmCalled = true; return MOCK_GENERATED; } }, log: () => {}, cacheFile, regen: false });
    await eng4.init();
    check('engine 有缓存直接加载', eng4.getMeta().source === 'cache' && /缓存人设/.test(eng4.getPrompt()), `actual: ${eng4.getMeta().source}`);
    check('engine 有缓存不调 LLM', llmCalled === false, `llmCalled=${llmCalled}`);
    // regen=true → 忽略缓存, 重生成
    let llmCalled2 = false;
    const eng5 = createPersonaEngine({ llm: { chat: async () => { llmCalled2 = true; return MOCK_REGEN; } }, log: () => {}, cacheFile, regen: true });
    await eng5.init();
    check('engine regen=true 忽略缓存重生成', eng5.getMeta().source === 'generated' && llmCalled2 === true && /二次生成/.test(eng5.getPrompt()),
      `actual: ${eng5.getMeta().source} llmCalled=${llmCalled2}`);
    // regenerate() 手动重生成
    const eng6 = createPersonaEngine({ llm: { chat: async () => MOCK_REGEN }, log: () => {} });
    await eng6.init();
    await eng6.regenerate();
    check('engine regenerate() 二次生成', /二次生成/.test(eng6.getPrompt()));
    fs.unlinkSync(cacheFile);
  }

  // —— 9.7 Router 内置命令: /大黄鱼 persona 测试 —— //
  console.log('[9.7] persona builtin 命令');
  {
    const reg = createRegistry({
      startTime: Date.now(),
      pondState: { onlineUsers: new Set() },
      sessions: new SessionStore({}),
      api: new XechatApi({ base: 'https://fake', fetchFn: fakeApiFetch }),
      python: { cmd: 'python', timeoutMs: 10000 },
      web: { enabled: true },
      skills: { enabled: true },
      todo: { maxItems: 20 },
    });
    const router = new Router({
      cfg: { cmdPrefix: '/大黄鱼', persona: { enabled: true, defaultMode: MODE_FORMAL, tieMargin: 0.15 } },
      sessions: new SessionStore({ historyMax: 5 }),
      pondState: { onlineUsers: new Set(), roomLog: [] },
      startTime: Date.now(),
      api: new XechatApi({ base: 'https://fake', fetchFn: fakeApiFetch }),
      log: () => {},
    });
    void reg;
    router.tools = router.tools; // 触发兜底组装 (实际由 deps.cfg.tools 走, 这里保持简单)

    // 假装 @ 提及被处理, 让 persona 写入黏性, 然后用命令查
    router.persona.analyze('哈哈', 'alice', []);
    router.persona.analyze('你好', 'bob', []);
    const out = router._personaCmd('', 'admin');
    check('persona 命令空参数返回快照', /拟人触发器/.test(out) && /\balice\b/.test(out) && /\bbob\b/.test(out),
      `实际: ${out}`);

    // 测试模式
    const t = router._personaCmd('测试 搁这装呢笑死', 'admin');
    check('persona 测试命令给出 mode', /判定:/.test(t) && (/human/.test(t) || /formal/.test(t)),
      `实际: ${t}`);

    // 重置 (整盘)
    const r = router._personaCmd('重置', 'admin');
    check('重置整盘后黏性清空', /重置/.test(r), `实际: ${r}`);
    check('重置后空', router.persona.snapshot().stickiness.length === 0);

    // 重置单用户
    router.persona.analyze('hi', 'alice', []);
    const r2 = router._personaCmd('重置 alice', 'admin');
    check('重置单用户', /alice/.test(r2), `实际: ${r2}`);
    check('重置后 alice 不存在', router.persona.getStickiness('alice') == null);
  }

  // —— 9.8 handleMention 端到端: 高 human 信号 → 应记录 human mode + 注入动态人设 —— //
  console.log('[9.8] handleMention 选中 human, 走 HUMAN_SYSTEM_PROMPT (李乐儿)');
  {
    const cfg = {
      cmdPrefix: '/大黄鱼',
      username: '大黄鱼',
      mention: { enabled: true, chatKeyPrefix: 'chat:' }, // 必须开 mention
      persona: { enabled: true, defaultMode: MODE_FORMAL, tieMargin: 0.15 },
    };

    // 注入一个 mock 人设引擎 (engine 优先于 getHumanSystemPrompt)
    const fakeEngine = {
      getPrompt: () => '【引擎注入的人设】: 李乐儿 / 云南昭通 / 哈哈哈',
      getMeta: () => ({ enabled: true, status: 'ready', source: 'fake', generatedAt: '2026-08-28', err: null, len: 50 }),
      regenerate: async () => {},
    };
    const sessions = new SessionStore({ historyMax: 5 });
    const pondState = { onlineUsers: new Set(), roomLog: [] };
    const api = new XechatApi({ base: 'https://fake', fetchFn: fakeApiFetch });
    const seen = [];
    // 完整 mock: chat (用于 summarize) + agentTurn (用于主回合)
    const llmMock = {
      chat: async () => '',
      agentTurn: async ({ systemPrompt }) => {
        seen.push('PROMPT_LEN=' + systemPrompt.length);
        seen.push('PROMPT_HAS_引擎人设=' + /引擎注入的人设/.test(systemPrompt));
        seen.push('PROMPT_HAS_李乐儿=' + /李乐儿/.test(systemPrompt));
        seen.push('PROMPT_HAS_AI_助手=' + /AI 助手/.test(systemPrompt));
        return '【测试回复】';
      },
    };
    const router = new Router({
      cfg, sessions, pondState, startTime: Date.now(), api, personaEngine: fakeEngine,
      log: (s) => seen.push(s),
    }).bindLlm(llmMock);
    // 注入确定性 rng: 让 lurk 测试永远走 respond (避免 5% 随机翻车)
    // (rng>0.99 时 pickReplyAction 才不会走 lurk 分支)
    router.persona._fixedRngForTest = () => 0.99;
    const origAnalyze = router.persona.analyze.bind(router.persona);
    router.persona.analyze = function (...args) {
      return origAnalyze(...args, { rng: this._fixedRngForTest });
    };
    // 人设: 强烈 human 信号 (俚语 + 多 emoji + 短) → 应选 human, 注入引擎人设
    const reply = await router.handleMention({ from: 'tom', text: '好家伙, 搁这装呢, 笑死 🤣🤣', isLive: true });
    check('handleMention 强烈 human 信号应注入引擎人设', seen.some((s) => s === 'PROMPT_HAS_引擎人设=true'),
      `seen: ${seen.filter((s) => s.startsWith('PROMPT_')).join(' | ')}`);
    check('handleMention 人设含李乐儿', seen.some((s) => s === 'PROMPT_HAS_李乐儿=true'),
      `seen: ${seen.filter((s) => s.startsWith('PROMPT_')).join(' | ')}`);
    check('handleMention 应有 [persona] 日志', seen.some((s) => s.startsWith('[persona]')),
      `seen前几: ${seen.slice(0, 4).join(' / ')}`);
    check('handleMention 返回 LLM 回复', /测试回复/.test(reply), `实际: ${reply.slice(0, 80)}`);

    // 强制 formal 上下文: 礼貌正式请求 + 长文本 → 应回 formal prompt (无引擎人设/李乐儿)
    const seen2 = [];
    const router2 = new Router({
      cfg, sessions: new SessionStore({ historyMax: 5 }), pondState: { onlineUsers: new Set(), roomLog: [] }, startTime: Date.now(), api, personaEngine: fakeEngine,
      log: (s) => seen2.push(s),
    }).bindLlm({
      chat: async () => '',
      agentTurn: async ({ systemPrompt }) => {
        seen2.push('PROMPT_HAS_引擎人设=' + /引擎注入的人设/.test(systemPrompt));
        seen2.push('PROMPT_HAS_AI_助手=' + /AI 助手/.test(systemPrompt));
        return '【测试回复】';
      },
    });
    // 长文本 + 礼貌请求 → formal
    await router2.handleMention({ from: 'tom', text: '请问能不能帮我详细总结一下这个长文档的核心要点以及背景信息', isLive: true });
    check('正式请求上下文应回 formal (无引擎人设)', seen2.includes('PROMPT_HAS_引擎人设=false'), `seen2: ${seen2.join('|')}`);
    check('正式请求上下文应回 formal (含 AI 助手)', seen2.includes('PROMPT_HAS_AI_助手=true'));
  }
}
