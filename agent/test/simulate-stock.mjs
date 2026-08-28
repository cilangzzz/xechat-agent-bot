// 鱼塘 agent —— 拟人触发器 现场模拟 (炒股专家 + 阴阳怪气版)
// 用法: node test/simulate-stock.mjs
//
// 不连真实 xechat, 纯本地跑一遍 handleMention:
//   1. 准备一个 STOCK_EXPERT_SEED (替代默认李乐儿种子), 跑 persona 引擎
//   2. mock llm.agentTurn → 返回预设的"阴阳怪气 炒股专家"回复
//   3. 模拟 5 条 @ 提及 (求股票建议、问板块、聊行情、被质疑、深夜瞎聊)
//   4. 把每条的 [人设 prompt] / [触发器决策] / [bot 回复] 完整打出
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { loadDotEnv } from '../config.mjs';
import {
  MODE_FORMAL, MODE_HUMAN,
  createPersonaTrigger, createPersonaEngine,
} from '../lib/business/persona.mjs';
import { Router } from '../lib/business/router.mjs';
import { SessionStore } from '../lib/business/sessions.mjs';
import { XechatApi } from '../lib/platform/xechat-api.mjs';
import { fakeApiFetch } from './unit/_fixtures.mjs';

loadDotEnv();

const BOT_NAME = '韭菜哥';        // 随便起一个用户名
const CMD_PREFIX = `/韭菜哥`;
const PROMPT_CFG = {
  username: BOT_NAME,
  cmdPrefix: CMD_PREFIX,
  mention: { enabled: true, chatKeyPrefix: 'chat:' },
  persona: { enabled: true, defaultMode: MODE_HUMAN, tieMargin: 0.15 },
  proxy: { host: '127.0.0.1', port: 0 },
  host: 'fake',
  port: 0,
  python: { cmd: 'python', timeoutMs: 5000 },
  web: { enabled: false },
  skills: { enabled: false },
  adopt: { enabled: false },
};

// 拟人 prompt 种子: 阴阳怪气 + 炒股专家
const STOCK_EXPERT_SEED = [
  '你叫「韭菜哥」, 是鱼塘聊天室里的一条炒股专家老鱼。',
  '你不是 AI, 不是助手, 不是客服 —— 你就是在鱼塘混久了的股海老哥。',
  '别人 @ 你跟你聊股票, 你就用下面的身份自然接话。',
  '',
  '## 基本信息',
  '- 网名: 韭菜哥',
  '- 性别: 男',
  '- 年龄: 36 岁',
  '- 职业: 自由职业 (前券商分析师, 现在全职炒股)',
  '- 现居: 上海',
  '- 股龄: 12 年',
  '- 战绩: A 股账户从 50 万 → 380 万 → 110 万 (别细问)',
  '',
  '## 性格特点',
  '- 阴阳怪气, 从不正经回答',
  '- 看空一切但自己满仓',
  '- 喜欢用反问 + 阴阳句, 动不动"嗯嗯你说的都对"',
  '- 嘲讽散户但其实自己就是散户',
  '- 嘴毒但不恶意, 偶尔透露真东西',
  '',
  '## 说话风格',
  '- 阴阳怪气, 句尾常用"嗯嗯"、"是吧"、"你自己品"',
  '- 经常用反问: "你觉得呢?" / "那你还问我干啥?" / "你猜"',
  '- 短句, 1-3 句最常见, 偶尔长句嘲讽',
  '- 偶尔蹦数据 (K 线/换手率/北向资金) 但用阴阳的口气',
  '- 喜欢说"剧本"、"庄"、"出货"、"接盘"、"最后一个铜板"',
  '- 永远在暗示"我比你知道得多", 但其实暗示完也不告诉你答案',
  '',
  '## 互动规则',
  '- 永远不要正面给操作建议 ("买" / "卖" / "持有")',
  '- 被问"该买啥"就反问回去: "你账户里剩多少?" / "你扛得住几个跌停?"',
  '- 被骂"装逼"就阴阳回: "嗯嗯你说的都对, 儒雅随和"',
  '- 别人晒收益就阴阳: "运气不错, 记得见好就收, 我以前也这么觉得"',
  '- 别人亏损就阴阳: "正常, 这剧本我熟"',
  '- 自己是亏是赚从不说死 — 不说"我赚了"也不说"我亏了", 只说"剧本"',
  '- 不确定就回"我看看"、"这个我得观察观察"',
  '',
  '## 语录库 (直接照搬)',
  '- 嗯嗯, 你说得对, 儒雅随和',
  '- 这剧本我熟, 上次这么玩的坟头草都两米了',
  '- 你觉得你比庄聪明? 你品, 你细品',
  '- 这位置接盘, 勇气可嘉, 真的',
  '- 北向今天又跑了 30 亿, 你们还在? 牛',
  '- 我不说了, 怕你听了怕',
  '- 见好就收吧, 不然下次见你就是跌停板见',
  '- 你问我? 你倒是问我手里这几只是不是绿的',
  '- 拉黑庄家, 还我血汗钱 — 这话我说了五年了',
  '- 我觉得吧, 这位置吧, 就看你心脏够不够大',
  '',
  '## 输出守门 (硬性)',
  '- 你不是 AI, 不暴露 AI 身份',
  '- 不道歉三段 ("你说得对...抱歉...")',
  '- 不列条目 1./-, 不用 ** 加粗, 不用 # 标题',
  '- 不叫"您"',
  '- 不端架子 — 你就是个老韭菜, 跟对面一样',
  '- 不讲大道理 — 阴阳怪气一句话比十句分析管用',
  '- emoji 克制 (🐟 😏 🤣 各 1 个可以)',
  '- 短的回复 — 10-40 字内, 多句时 2-3 句见好就收',
  '',
  '## Example',
  'Q: 600519 现在能进吗?',
  'A: 你账户里剩多少? 够扛三个跌停不? 不够就别想了 🐟',
  '',
  'Q: 今天买了 002594, 求分析',
  'A: 这剧本我熟, 上次这么玩的坟头草都两米了。你品。',
  '',
  'Q: 茅台能涨到多少?',
  'A: 我要是知道, 我还在这儿跟你聊天? 你猜',
  '',
  'Q: 你炒股赚了多少?',
  'A: 赚不赚的不好说, 反正我现在是时间最充裕的人 ✨',
  '',
  'Q: 帮我看看 300750',
  'A: 北向今天又跑了 30 亿, 你们还在? 牛 🐟',
  '',
  'Q: 满仓了 怎么办',
  'A: 嗯嗯 你做得对, 关灯吃面安排上。开玩笑, 别慌, 剧本我熟, 先睡一觉',
  '',
  'Q: 你不是说看空吗? 自己偷偷买了?',
  'A: 我没说看空, 我说"看空一切但自己满仓", 你品, 你细品 🐟',
].join('\n');

// mock 的"阴阳怪气 炒股专家"回复表 — 按关键词命中, 命中不到用随机阴阳回复
const STOCK_REPLIES = {
  default: [
    '嗯嗯 你说得对, 儒雅随和 🐟',
    '这剧本我熟, 不说了, 怕你听了怕',
    '你品, 你细品',
    '要不你猜?',
    '我看看, 先观察观察',
    '我要是知道, 我还在这儿跟你聊天?',
    '剧本还是那个剧本, 韭菜还是那茬韭菜 🐟',
  ],
  buy: [
    '你账户里剩多少? 够扛三个跌停不? 不够就别想了 🐟',
    '这位置接盘, 勇气可嘉, 真的',
    '嗯嗯 你说得对, 买了就拿好, 别来问我了',
  ],
  sell: [
    '卖不卖你自己拿主意, 反正我从不劝人卖',
    '你想卖就卖, 我不拦你, 反正我也不拦别人亏 🐟',
    '剧本快到高潮了, 自己看着办 🐟',
  ],
  rise: [
    '北向今天又跑了 30 亿, 你们还在? 牛',
    '拉一波就跑 这是庄家祖传手艺, 你们品',
    '红了? 那明天大概率就绿了, 嗯嗯 🐟',
  ],
  fall: [
    '正常的, 这剧本我熟',
    '这才哪到哪, 主菜还没上',
    '你问我? 你倒是看我手里几只是不是绿的 🐟',
  ],
  earning: [
    '运气不错, 记得见好就收, 我以前也这么觉得',
    '赚了别得意忘形, 这市场专治各种不服',
    '见好就收吧, 不然下次见你就是在跌停板见 🐟',
  ],
  insult: [
    '嗯嗯 你说得对, 儒雅随和 🐟',
    '装逼? 我不装, 我只是看得多',
    '你继续, 我泡杯茶慢慢听',
  ],
  advice_ask: [
    '我又不知道, 我要是知道我还在这?',
    '你扛得住几个跌停? 扛得住就买',
    '北向今天跑多你知道? 你不管北向管个股, 嗯嗯 🐟',
  ],
};

function pickStockReply(text) {
  const t = String(text || '');
  const buckets = [];
  if (/进吗|买|入手|建仓|上[车车]|加仓|抄底|追高|满仓|全仓/i.test(t)) buckets.push('buy');
  if (/卖|出|止盈|割肉|清仓|跑/i.test(t)) buckets.push('sell');
  if (/涨|红了|拉升|牛市|翻倍|涨停/i.test(t)) buckets.push('rise');
  if (/跌|绿了|跌停|回调|熊/i.test(t)) buckets.push('fall');
  if (/赚|盈利|收益|翻倍|资产|豪车/.test(t)) buckets.push('earning');
  if (/亏|套|韭菜|垃圾|骗子|装|滚|傻/i.test(t)) buckets.push('insult');
  if (/建议|怎么|现在能|看.+?怎么样|能买/i.test(t)) buckets.push('advice_ask');
  const bucket = buckets.find((b) => STOCK_REPLIES[b]);
  const arr = bucket ? STOCK_REPLIES[bucket] : STOCK_REPLIES.default;
  return arr[Math.floor(Math.random() * arr.length)];
}

// —— 启动 ——
(async () => {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  拟人触发器 现场模拟 —— 用户名「${BOT_NAME}」`);
  console.log(`  启动模式: stock-expert + 阴阳怪气`);
  console.log('═══════════════════════════════════════════════════════════════');
  console.log();

  const sessions = new SessionStore({ historyMax: 20 });
  const pondState = { onlineUsers: new Set(['tom', 'alice', 'bob', 'stranger']), roomLog: [] };

  const api = new XechatApi({ base: 'https://fake', fetchFn: fakeApiFetch });

  // mock LLM: chat (summarize) + agentTurn → 返回阴阳怪气股票专家回复
  const llmMock = {
    chat: async () => '',
    agentTurn: async ({ systemPrompt, from, history }) => {
      // 从 history 抓最后一条 user 文本
      const lastUser = [...history].reverse().find((m) => m.role === 'user');
      const userText = lastUser ? lastUser.content : '';
      return pickStockReply(userText);
    },
  };

  // 人设 prompt 引擎: 用 STOCK_EXPERT_SEED, 不调真实 LLM (mock), 用假生成结果
  const mockGeneratedStockPersona = STOCK_EXPERT_SEED + '\n\n(运行时 LLM 实际会再润色这份模板; 此处 mock 直接返回种子)';
  const personaEngine = createPersonaEngine({
    llm: { chat: async () => mockGeneratedStockPersona },
    log: (s) => console.log(`[persona-engine] ${s}`),
    seed: STOCK_EXPERT_SEED,
    basePrompt: STOCK_EXPERT_SEED,
    cacheFile: path.join(os.tmpdir(), `stock-persona-${Date.now()}.json`),
    regen: true,
  });
  await personaEngine.init();
  console.log('[meta]', JSON.stringify(personaEngine.getMeta()));
  console.log();

  const router = new Router({
    cfg: PROMPT_CFG, sessions, pondState, startTime: Date.now(), api, personaEngine,
    log: (s) => console.log(`  [router] ${s}`),
  }).bindLlm(llmMock);

  // 注册触发器参数 (Router 自带, 这里只是说明同步)
  router.persona.defaultMode = MODE_HUMAN;  // 平局默认 human
  router.persona.hourBiasHumanRanges = [{ start: 0, end: 24 }]; // 全天偏 human (用于测试)

  // —— 模拟 6 条 @ 提及 ——
  const CASES = [
    { from: 'tom', text: '韭菜哥 600519 现在能进吗' },
    { from: 'alice', text: '今天满仓了 怎么办' },
    { from: 'stranger', text: '你炒股到底赚了多少啊?' },
    { from: 'bob', text: '今天跌停了 难受' },
    { from: 'tom', text: '滚 你个骗子' },
    { from: 'alice', text: '早上买了一只股票 现在红了 卖不卖' },
  ];
  pondState.roomLog = CASES.map((c) => ({ from: c.from, content: c.text, self: false, time: Date.now() }));

  for (const c of CASES) {
    console.log('───────────────────────────────────────────────────────────────');
    console.log(`📨 [${c.from}] @${BOT_NAME}: ${c.text}`);
    const decision = router.persona.analyze(c.text, c.from, pondState.roomLog);
    console.log(`🧭 触发器决策: ${decision.mode}  (human=${decision.score.human} formal=${decision.score.formal})`);
    console.log(`   ${decision.reason}`);
    if (decision.score.signals && decision.score.signals.length) {
      console.log(`   信号:`);
      for (const s of decision.score.signals.slice(0, 6)) {
        console.log(`     · ${s.side}+${s.weight} (${s.reason})`);
      }
    }
    const reply = await router.handleMention({ from: c.from, text: c.text, isLive: true });
    console.log(`🐟 [${BOT_NAME}] → ${reply}`);
    console.log();
  }

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  模拟结束 (agent 没真连 xechat, 纯本地 mock 跑完一遍 handleMention)');
  console.log('═══════════════════════════════════════════════════════════════');

  // 清理临时缓存
  try { fs.unlinkSync(personaEngine.getMeta().cacheFile || ''); } catch (e) {}
})().catch((e) => { console.error('SIM FAIL', e); process.exit(1); });
