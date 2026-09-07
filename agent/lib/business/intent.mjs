// 意图识别 (参考 opencode: 规则优先 + LLM 决策兜底)
// opencode 本身没有显式意图分类器, 其"意图处理"靠 detectSlashCommand(规则) + LLM 函数调用选择工具。
// 这里借鉴同一种思路: 对 /大黄鱼 前缀内但没命中 builtin 表的自由文本, 先用一次便宜 LLM 分类,
// 把消息分到 explore/math/room/query 等更便宜的路径, 兜底走 main agent。
// 作用域: 只对带前缀且未命中 builtin 的文本生效; 无前缀消息完全不受影响(仍走 agent.mjs 的沉默路径)。

const INTENT_LABELS = ['builtin', 'explore', 'math', 'room', 'query', 'chat', 'main'];
const VALID_INTENTS = new Set(INTENT_LABELS);

/** 分类器系统提示词: 中文 + 配例子, 严格要求"只输出标签" */
export const INTENT_SYSTEM_PROMPT = `你是大黄鱼 agent 的意图分类器。根据用户输入(已带 /大黄鱼 前缀, 不含前缀本身), 只输出一个标签。

可选标签:
- builtin: 直接命中内置命令(ping/online/help/todo/记忆/压缩/最近消息/聊天记录/clear/create-room/close-room/rooms/定时/领养/persona/skills/tools/agents 等命令名 + 参数)。例如 "ping"、"help"、"todo 显示"
- explore: 需要联网搜索/抓网页/查外部信息(天气/新闻/股票/金价走势/某公司/某政策/资料汇总 等)
- math: 需要数学计算/数据处理/画图/聚合(算术/统计/百分比/画柱状图/排序/汇总 等)
- room: 涉及游戏房间(开房间/创建房间/关闭房间/列出房间/查看活动房间 等)
- query: 查询鱼塘自身状态(在线人数/统计/游戏列表/某游戏详情/今日金价 等, 不需要联网)
- chat: 闲聊/打招呼/情感表达/玩笑/无明确工具需求
- main: 默认; 需要多步工具调用、写代码、写文章、解释概念、复杂开放问题 等

只输出一个标签, 不要解释、不要标点、不要前后缀。`;

/** 简单 LRU: 重复消息零成本复用分类结果 */
function makeLru(max) {
  const map = new Map();
  return {
    get(k) { if (!map.has(k)) return undefined; const v = map.get(k); map.delete(k); map.set(k, v); return v; },
    set(k, v) { if (map.has(k)) map.delete(k); if (map.size >= max) { const first = map.keys().next().value; map.delete(first); } map.set(k, v); },
    size() { return map.size; },
  };
}

// 进程级缓存 (整个 agent 单进程, 单 Router, 一个 LRU 足够)
const _intentCache = makeLru(64);

/** 把模型原始输出归一为合法 intent 字符串; 无法识别返回 '' */
function normalizeIntent(raw) {
  if (!raw) return '';
  let s = String(raw).trim().toLowerCase();
  // 去前后缀标点/星号/反引号
  s = s.replace(/^[\s*`"'`]+|[\s*`"'`,。.!;:：)]+$/g, '');
  // 抽取 "intent: x" / "label: x" / "意图: x" 等带修饰的输出
  const m = s.match(/(?:intent|label|意图|标签|分类|answer|输出|结果)[:：\s]+([a-z]+)/i);
  if (m) s = m[1];
  s = s.replace(/[^a-z]/g, '');
  return VALID_INTENTS.has(s) ? s : '';
}

/**
 * 对单条用户文本做意图分类
 * @param {string} text 已去掉前缀的指令文本 (sub+arg 拼回)
 * @param {object} llm createLlm 返回值, 需有 chat()
 * @param {object} [opts] { timeoutMs, cache, log }
 * @returns {Promise<string>} 合法 intent 标签; 失败/异常一律返回 'main'
 */
export async function classifyIntent(text, llm, opts = {}) {
  const t = String(text || '').trim();
  if (!t || t.length < 2) return 'main';

  const cache = opts.cache || _intentCache;
  const log = opts.log || (() => {});
  const hit = cache.get(t);
  if (hit) { log(`[intent] 缓存命中: "${t.slice(0, 40)}" → ${hit}`); return hit; }

  const timeoutMs = opts.timeoutMs || 10000;
  let raw = '';
  try {
    // 限时: 用 Promise.race 包一层, 超时强制 reject
    raw = await Promise.race([
      llm.chat(INTENT_SYSTEM_PROMPT, [{ role: 'user', content: t }]),
      new Promise((_, rej) => setTimeout(() => rej(new Error('intent-timeout')), timeoutMs)),
    ]);
  } catch (e) {
    log(`[intent] 分类异常 (${e.message}), 兜底 main`);
    cache.set(t, 'main');
    return 'main';
  }

  let intent = normalizeIntent(raw);
  if (!intent) {
    log(`[intent] 分类结果 "${raw.replace(/\n/g, '\\n').slice(0, 80)}" 不在白名单, 兜底 main`);
    intent = 'main';
  }
  cache.set(t, intent);
  log(`[intent] "${t.slice(0, 40)}" → ${intent}`);
  return intent;
}

export { INTENT_LABELS, _intentCache as intentCache };