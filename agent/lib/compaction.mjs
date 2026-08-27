// 鱼塘 agent 智能体 —— 结构化上下文压缩 (参考 opencode 的 compaction 架构)
// 两个关键思路从 opencode 借鉴:
//   1) 按 token 预算保留最近对话(tail)、只把多余的旧消息(head)压进摘要 —— 而不是无差别砍到 N 条。
//   2) 摘要用固定结构化模板输出(目标/背景/进展/下一步/相关资源), 并支持与上一次摘要增量合并 ——
//      这样另一轮对话也能据摘要继续工作。
// 本模块纯函数、无外部依赖, 便于单测; SessionStore.maybeCompress 内部调用这里。

/** CJK 大致 1 token/字符, 非 CJK 约 3.5 字符/1 token 的轻量启发式估算(仅用于预算决策, 无需精确) */
export function estimateTokens(text) {
  let cjk = 0;
  let other = 0;
  for (const ch of String(text == null ? '' : text)) {
    if (/[　-鿿＀-￯぀-ヿ가-힯]/.test(ch)) cjk++;
    else if (ch !== '\n' && ch !== '\r') other++;
  }
  return Math.ceil(cjk + other / 3.5);
}

/**
 * 按 token 预算把消息切分为 head(要压缩)/recent(保留)。
 * 从尾部向前累计, 找到"放进预算内的最大尾部"; head = 预算前部分。
 * @param {{role:string, content:any}[]} messages
 * @param {number} budget 最近消息保留的 token 预算
 * @returns {{ head: object[], recent: object[] }}
 */
export function select(messages, budget) {
  if (!Array.isArray(messages) || messages.length === 0) return { head: [], recent: messages || [] };
  let total = 0;
  let split = 0; // recent 起点
  for (let i = messages.length - 1; i >= 0; i--) {
    const est = estimateTokens(messages[i].content);
    if (total + est > budget) break;
    total += est;
    split = i;
  }
  return { head: messages.slice(0, split), recent: messages.slice(split) };
}

/** 结构化摘要模板 —— 类似 opencode 的 SUMMARY_TEMPLATE, 但适配聊天助手的上下文(保留 URL/游戏/用户偏好等) */
export const SUMMARY_TEMPLATE = `把话压缩成下面结构与顺序一致的纯文本, 只输出结构本身(空节写 "(无)"):
## 目标 (Objective)
- (用户想达成什么)
## 重要背景 (Important Details)
- (约束/偏好/决定与原因/关键事实/需要继续工作所需的确切上下文)
## 工作进展 (Work State)
### 已完成
### 进行中
### 阻塞
## 下一步 (Next Move)
## 相关资源 (Relevant)
- (URL / 游戏名 / 用户提到的名称或偏好, 尽量保留原名)

规则:
- 每个小节都要保留, 即使为空。
- 用简短要点, 不要整段散文。
- 尽可能保留确切的名字、URL、指令、结论、数字。
- 不要提及"这是摘要"或压缩过程本身。`;

/** 增量合并说明 —— 有上一次摘要时告诉模型如何合并到新摘要 */
const SUMMARY_UPDATE_INSTRUCTIONS = `<prior-summary> 是 <conversation> 之前所有对话的摘要。请构造一个新摘要把两者合并。
<prior-summary> 合并后即被丢弃: 你没有写进新摘要的内容都会丢失。

合并时:
- 要从 <prior-summary> 带过去的: 目标、约束、用户指令、决定、进行中的工作 —— 即使 <conversation> 里没再提到, 也要保留。
- <conversation> 比 <prior-summary> 更新; 二者冲突时以对话为准: 修正事实、删掉旧说法。
- 把对话里的新进展/决定/约束/上下文并入摘要。
- 已完成的"进行中"移到"已完成"。
- 被解决的阻塞在摘要中更新为已解决, 保留仍需的信息。
- 更新"目标"和"下一步"反映当前工作状态。`;

/** 序列化一段消息给摘要器阅读 (用户/助手文本) */
export function serializeForSummary(messages) {
  return messages
    .map((m) => `${m.role === 'user' ? '用户' : '助手'}: ${String(m.content == null ? '' : m.content)}`)
    .join('\n');
}

/**
 * 构造压缩提示词: 给 LLM 一段 head 对话 + (可有)上一次摘要, 要求输出新结构化摘要。
 * @param {object} input { previousSummary?:string, head:string(已序列化的对话) }
 * @returns {string} 系统提示词 / 用户提示词
 */
export function buildSummaryPrompt({ previousSummary, head }) {
  const conversation = `以下是到目前为止的对话:\n\n<conversation>\n${head}\n</conversation>`;
  if (!previousSummary) {
    return [
      conversation,
      '根据上面 <conversation> 里的对话历史生成一份新锚定摘要, 让另一个智能体可以据此继续工作。',
      SUMMARY_TEMPLATE,
    ].join('\n\n');
  }
  return [
    conversation,
    `以下是 <conversation> 之前对话的摘要:\n\n<prior-summary>\n${previousSummary}\n</prior-summary>`,
    SUMMARY_UPDATE_INSTRUCTIONS,
    SUMMARY_TEMPLATE,
  ].join('\n\n');
}

/**
 * 便捷: 调用 LLM 生成/合并摘要。
 * @param {object} opts { llm(有 chat), previousSummary, messages }
 * @returns {Promise<string>} 新摘要
 */
export async function summarizeWithLlm({ llm, previousSummary, messages }) {
  const prompt = buildSummaryPrompt({
    previousSummary,
    head: serializeForSummary(messages),
  });
  try {
    const out = await llm.chat('你是会话压缩器, 只输出结构化的摘要。', [{ role: 'user', content: prompt }]);
    return (out || '').trim();
  } catch (e) {
    return previousSummary || '';
  }
}

/** 对工具结果做统一截断(上限字符数) */
export function truncateOutput(value, max = 2000) {
  const s = String(value == null ? '' : value);
  return s.length <= max ? s : `${s.slice(0, max)}\n...[输出过长已截断]`;
}