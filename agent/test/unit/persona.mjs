// agent 测试 —— 拟人触发器 (persona.mjs) 单元测试
// 覆盖: 文本特征 / 时间偏好 / 用户黏性 / 房间氛围 / 平局退路 / FIFO 黏性淘汰 / persona 内置命令
import {
  MODE_FORMAL, MODE_HUMAN,
  createPersonaTrigger, pickPersona, scoreMessage, getHumanSystemPrompt,
} from '../../lib/business/persona.mjs';
import { Router } from '../../lib/business/router.mjs';
import { SessionStore } from '../../lib/business/sessions.mjs';
import { XechatApi } from '../../lib/platform/xechat-api.mjs';
import { createRegistry } from '../../lib/business/tools/index.mjs';
import { fakeApiFetch } from './_fixtures.mjs';
import { check } from './_state.mjs';

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

  // —— 9.6 getHumanSystemPrompt 存在且非空 —— //
  {
    check('HUMAN_SYSTEM_PROMPT 非空', /老网友/.test(getHumanSystemPrompt()), 'no 老网友 in prompt');
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

  // —— 9.8 handleMention 端到端: 高 human 信号 → 应记录 human mode —— //
  console.log('[9.8] handleMention 选中 human, 走 HUMAN_SYSTEM_PROMPT');
  {
    const cfg = {
      cmdPrefix: '/大黄鱼',
      username: '大黄鱼',
      mention: { enabled: true, chatKeyPrefix: 'chat:' }, // 必须开 mention
      persona: { enabled: true, defaultMode: MODE_FORMAL, tieMargin: 0.15 },
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
        seen.push('PROMPT_HAS_老网友=' + /老网友/.test(systemPrompt));
        seen.push('PROMPT_HAS_AI_助手=' + /AI 助手/.test(systemPrompt));
        return '【测试回复】';
      },
    };
    const router = new Router({
      cfg, sessions, pondState, startTime: Date.now(), api,
      log: (s) => seen.push(s),
    }).bindLlm(llmMock);
    // 人设: 强烈 human 信号 (俚语 + 多 emoji + 短) → 应选 human
    const reply = await router.handleMention({ from: 'tom', text: '好家伙, 搁这装呢, 笑死 🤣🤣', isLive: true });
    check('handleMention 强烈 human 信号应回 human prompt', seen.some((s) => s === 'PROMPT_HAS_老网友=true'),
      `seen: ${seen.filter((s) => s.startsWith('PROMPT_')).join(' | ')}`);
    check('handleMention 应有 [persona] 日志', seen.some((s) => s.startsWith('[persona]')),
      `seen前几: ${seen.slice(0, 4).join(' / ')}`);
    check('handleMention 返回 LLM 回复', /测试回复/.test(reply), `实际: ${reply.slice(0, 80)}`);

    // 强制 formal 上下文: 礼貌正式请求 + 长文本 → 应回 formal prompt
    const seen2 = [];
    const router2 = new Router({
      cfg, sessions: new SessionStore({ historyMax: 5 }), pondState: { onlineUsers: new Set(), roomLog: [] }, startTime: Date.now(), api,
      log: (s) => seen2.push(s),
    }).bindLlm({
      chat: async () => '',
      agentTurn: async ({ systemPrompt }) => {
        seen2.push('PROMPT_HAS_老网友=' + /老网友/.test(systemPrompt));
        seen2.push('PROMPT_HAS_AI_助手=' + /AI 助手/.test(systemPrompt));
        return '【测试回复】';
      },
    });
    // 长文本 + 礼貌请求 → formal
    await router2.handleMention({ from: 'tom', text: '请问能不能帮我详细总结一下这个长文档的核心要点以及背景信息', isLive: true });
    check('正式请求上下文应回 formal (无"老网友")', seen2.includes('PROMPT_HAS_老网友=false'), `seen2: ${seen2.join('|')}`);
    check('正式请求上下文应回 formal (含"AI 助手")', seen2.includes('PROMPT_HAS_AI_助手=true'));
  }
}
