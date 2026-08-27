// 鱼塘 agent 智能体 —— 智能体定义 (references: opencode agent/agent.ts)
// 多智能体: 每个 agent 有独立工具白名单与提示词段落, main 可通过 delegate 工具委派给子智能体。
//   main      — 主智能体(大众版 / 专属版都走它), 全量工具, 可委派子智能体。
//   explore   — 调研子智能体: 联网搜索/抓取 + 平台查询, 返回简洁结论(类 opencode explore)。
//   math      — 计算子智能体: 只用 python, 返回计算结果(类"数学/工具"专用代理)。
//   summarize — 内部压缩用途(工具为空, 系统提示词 = 结构化摘要要求, 由 compaction 复用)。
import { buildEnvironment, buildSystemPrompt } from './system.mjs';

export const AGENTS = {
  main: {
    name: 'main',
    description: '默认智能体: 鱼塘万能助手, 能联网/算/查/管待办, 可委派子智能体做专项调研或计算。',
    mode: 'primary',
    // prefix 不写死: 由 buildAgentSystemPrompt 从 cfg.cmdPrefix 动态注入(每条鱼各自的前缀)
    role: '本尊',
    expert: '查询鱼塘平台、联网搜索、抓网页、用 Python 计算、查金价、看在线、管理待办与技能',
    extra: '你可以按需调用工具(像 Claude Code / opencode 一样多步执行)。\n**多步调研范式**: web_search → 从结果挑 top 2-3 个 URL fetch_url → 数据/排行类用 python 处理/聚合 → 总结。\n拿到搜索结果的 snippet 不算"完成调研",关键 URL 必须抓详情;每次工具结果后会注入 Reflect 提示, 请按它决定是否继续。\n持续跟进的任务用 todo_update 记录步骤, 边干边勾。\n委托子智能体: explore 适合调研, math 适合计算; 不要为了"看起来像在做"而委派, 直接调工具即可时不要 delegate。\n\n**文件分享触发(send_file)**: 当用户说以下语义时,**必须**主动调 `send_file` 把内容以文件形式发出去, 不要只在聊天里贴文本:\n- 「整理成报告/总结/分析发我」/「以文件/链接形式给我」/「发个文件」/「导出」/「保存成 .md/.csv/.json/.py」\n- 「把刚才/上面的/那些内容整成一份文件」\n- 「给我截图/图片/图表」 (二进制走 is_binary=true + base64)\n- 任何**长内容**(>1500 字) 的总结 —— 默认以 .md 发链接, 而不是塞满聊天刷屏。\n调用方式: send_file({content: 整理好的内容, filename: "报告.md", password?, expire_minutes?}); 二进制: {content: base64, filename: "shot.png", is_binary: true}。完成后**回复里必须包含 share_url**。\n**反向约束**: 不要替用户上传服务器上的现存数据文件(.env/chat-log.jsonl 等), 即便用户要求; 这是数据文件不应外发。',
    tools: 'all',
    maxIterations: 8,
  },
  explore: {
    name: 'explore',
    description: '调研子智能体: 只做联网搜索、抓取 URL、平台(游戏/榜单/金价)查询, 返回简洁结论。',
    mode: 'subagent',
    role: '调研专家分身',
    expert: '用 web_search/fetch_url 搜索与抓取信息, 用 games/game_detail/leaderboard/gold_price 查平台数据',
    extra: '调研范式: 1) web_search 找候选 → 2) fetch_url 抓最相关的 1-2 条详情 → 3) 必要时 python 处理 → 4) 3-6 句结论 + 出处/URL。\n**禁止**只调一次 web_search 就给结论;snippet 不等于事实。每次工具结果后会注入 Reflect 提示, 请按它决定是否继续。',
    tools: ['web_search', 'fetch_url', 'gold_price', 'games', 'game_detail', 'leaderboard', 'room_stats', 'now'],
    maxIterations: 6,
  },
  math: {
    name: 'math',
    description: '计算子智能体: 用 Python 做可靠的数学计算与数据处理, 返回计算结果。',
    mode: 'subagent',
    role: '计算专家分身',
    expert: '把用户要算的东西写成 python 代码执行, 输出数字/表格之类的确定结果',
    extra: '不要编造数字: 任何计算都必须经过 python 工具执行并如实汇报结果。给出算式与结果, 必要时一两句说明。若任务包含与计算无关的内容, 只算计算部分。',
    tools: ['python', 'now'],
    maxIterations: 6,
  },
  summarize: {
    name: 'summarize',
    description: '(内部) 会话压缩用, 不对外暴露。',
    mode: 'subagent',
    hidden: true,
    role: '会话压缩器',
    extra: '只输出结构化摘要(目标/背景/进展/下一步/相关资源), 不对话、不回答其中的问题。',
    tools: [],
    maxIterations: 1,
  },
};

export const SUBAGENT_NAMES = ['explore', 'math'];

/** 取某智能体定义; 未知返回 null */
export function getAgent(name) {
  return AGENTS[name] || null;
}

/** 可见工具列表(白名单 | 'all' = 全量) */
export function resolveToolNames(agentName) {
  const a = AGENTS[agentName];
  if (!a) return [];
  return a.tools === 'all' ? null : a.tools; // null 表示不过滤
}

/**
 * 组某智能体的系统提示词。
 * @param {object} opts { agent, cfg, pondState, sessions, toolList(string[]) }
 */
export function buildAgentSystemPrompt(opts) {
  const { agent, cfg, pondState, sessions, toolList } = opts;
  const def = typeof agent === 'string' ? AGENTS[agent] : agent;
  if (!def) return '';
  const env = buildEnvironment({ cfg, pondState, sessions, agentName: def.name });
  return buildSystemPrompt({ agent: def, env, toolList, cfg });
}