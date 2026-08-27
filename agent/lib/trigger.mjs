// 鱼塘 agent 智能体 —— 多人发言主动消息触发器
// 每累计 threshold(默认 10)条**非自己**的消息就触发一次主动广播: 把窗口内收集的消息交给外层
// (agent.mjs 调 LLM 理解并生成一条观点鲜明/有争议性的消息), 然后重置窗口 + 进入冷却。
// 说明: "除了自己"由调用方保证 —— agent.mjs 采集时已跳过自己(from !== cfg.username),
// 本模块只累计收到的人的消息条数(不区分是否是同一人)。
// 默认关闭(ENABLE_TRIGGER), 防刷屏。
export function createTrigger({ enabled = false, threshold = 10, cooldownMs = 300000, botNames = [], log = () => {} } = {}) {
  const state = {
    enabled: !!enabled,
    threshold: Math.max(1, threshold),  // 条数阈值(至少 1)
    cooldownMs,
    botNameSuffix: botNames.filter(Boolean).map((n) => n[n.length - 1]).filter(Boolean), // 名字末字(用于过滤同族bot发言)
    botNames: new Set(botNames.filter(Boolean)),
    windowCount: 0,        // 窗口内累计消息条数(非自己)
    windowMsgs: [],        // 窗口内收集的消息
    lastFireAt: 0,         // 上次触发时间
  };

  /**
   * 喂入一条聊天消息(应为非 bot 自己)。每累计 threshold 条触发一次主动消息, 返回待分析批次
   * (并重置窗口+记冷却), 否则返回 null。
   * @param {{from:string, content:string, time:number}} msg
   * @returns {Array|null}
   */
  function onMessage({ from, content, time } = {}) {
    if (!state.enabled) return null;
    if (!from || from === '?') return null;
    const text = String(content || '');
    // 含 "/" 的指令型消息(召唤 bot / 命令 / URL)不算入"聊天发言"窗口, 不累计不触发
    if (text.includes('/')) return null;
    // 同族 bot 发言不算入: 名字完全相同(自己) OR 名字末尾带"鱼"(其他鱼)—— 它们的发言是 bot 互相说话
    const lastChar = from.charAt(from.length - 1);
    if (state.botNames.has(from) || (state.botNameSuffix.length && lastChar === '鱼')) return null;
    const now = time || Date.now();
    // 冷却期内不收集(也不累计新窗口)
    if (now - state.lastFireAt < state.cooldownMs) return null;

    state.windowCount++;
    state.windowMsgs.push({ from, content: text, time: now });

    if (state.windowCount < state.threshold) return null;

    // 达到阈值 → 触发
    const batch = state.windowMsgs.slice();
    state.windowMsgs = [];
    state.windowCount = 0;
    state.lastFireAt = now;
    log(`[触发] 已累计 ${state.threshold} 条消息, 触发主动消息(${batch.length} 条待分析)`);
    return batch;
  }

  function getState() {
    return {
      enabled: state.enabled,
      threshold: state.threshold,
      windowCount: state.windowCount,
      windowMsgCount: state.windowMsgs.length,
      lastFireAt: state.lastFireAt,
    };
  }

  function reset() {
    state.windowMsgs = [];
    state.windowCount = 0;
  }

  return { onMessage, getState, reset };
}