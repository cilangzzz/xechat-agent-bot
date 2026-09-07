// 鱼塘 agent 智能体 —— Rage Mode (被艾特后进入主动攻击模式)
//
// 用途: bot 被 @ 一次后, 进入 rage mode 状态(默认 5 分钟)。
//       在这个窗口里, 每收到一条别人的非 @ 提及聊天, 按 30% 概率 + 30s 冷却
//       触发一次主动怼回去的"机会", 但不是每条都怼。
//
// 设计目标: 让 bot 在房间里"主动参与对话", 而不是只在被 @ 时说话;
//          但又不至于回每条话, 暴露"我盯梢"行为。
//
// 关键约束:
//   - 同一个人不连续怼两次 (避免 spam 一个人)
//   - 单轮攻击上限 (默认 8 次) → 防刷屏
//   - rage mode 自然过期 → 自动回到被动模式
//   - LLM 输出走 humanizeReply (含 FAMILY_SLUR_HOMOPHONES 黑名单, 骂家庭直接拦)
//
// API:
//   const aggressive = createAggressiveMode({...})
//   aggressive.trigger()            // 被 @ 之后调, 进入 rage mode
//   aggressive.tick({from, content}) // 每条非 @ 聊天调, 返回是否要攻击
//   aggressive.recordAttack(target)  // 实际发起攻击后调, 记账 (冷却/上限/同人)
//   aggressive.snapshot()            // 调试 / 状态查询
export function createAggressiveMode(opts = {}) {
  const enabled = opts.enabled !== false;
  const durationMs = opts.durationMs ?? 5 * 60 * 1000;       // 5 min 默认
  const cooldownMs = opts.cooldownMs ?? 30 * 1000;            // 30s 默认
  const maxAttacks = opts.maxAttacks ?? 8;                      // 单轮上限
  const attackRate = opts.attackRate ?? 0.30;                   // 每条消息 30% 概率攻击
  const log = opts.log || (() => {});
  const rng = opts.rng || Math.random;
  // 共享时钟 (测试可注入以控制"现在")
  const clock = opts.clock || (() => Date.now());

  let active = false;
  let startedAt = 0;
  let expiresAt = 0;
  let lastAttackAt = 0;
  let lastAttackTarget = null;
  let attacksThisRound = 0;
  let triggeredReason = null;

  /** 进入 rage mode (被 @ 之后 / 主动广播之后调)
   * @param {string} [reason] 触发原因 (调试用)
   * @param {number} [now] 测试可注入 */
   function trigger(reason = 'mention', now = clock()) {
    if (!enabled) return;
    if (active && now < expiresAt) {
      expiresAt = now + durationMs;
      triggeredReason = reason;
      log(`[aggressive] rage mode 续期到 ${new Date(expiresAt).toLocaleTimeString()}`);
      return;
    }
    active = true;
    startedAt = now;
    expiresAt = now + durationMs;
    attacksThisRound = 0;
    lastAttackAt = 0;
    lastAttackTarget = null;
    triggeredReason = reason;
    log(`[aggressive] 进入 rage mode (reason=${reason}), ${Math.round(durationMs/1000)}s 有效, ${maxAttacks} 次上限`);
  }

  /**
   * 每条非 @ 聊天调用一次, 返回是否要攻击 + 攻击对象
   * @returns {null | {target:string, content:string, expiresAt:number, attacksThisRound:number}}
   */
  function tick({ from, content, repeatCount = 0, now = clock() }) {
    if (!enabled) return null;
    if (!active) return null;
    if (now >= expiresAt) {
      active = false;
      log(`[aggressive] rage mode 已过期 (持续了 ${Math.round((now - startedAt)/1000)}s, 本轮 ${attacksThisRound} 次攻击)`);
      return null;
    }
    if (attacksThisRound >= maxAttacks) {
      active = false;
      log(`[aggressive] 已达本轮上限 ${maxAttacks}, 自动退出 rage mode`);
      return null;
    }
    if (now - lastAttackAt < cooldownMs) return null;
    if (lastAttackTarget && from === lastAttackTarget) return null; // 不连续怼同一人

    // 复读机策略:
    //   - repeatCount 1-2: 基础 attackRate (一般 30%)
    //   - repeatCount 3-4: 装死率上升 (跳过概率 60%), 但剩下的攻击要 HARD
    //   - repeatCount 5+:   装死率更高 (跳过 80%), 极少数才出手, 一出手就是重怼
    let adjustedRate = attackRate;
    if (repeatCount >= 5) adjustedRate = 0.20;       // 80% 装死
    else if (repeatCount >= 3) adjustedRate = 0.40;  // 60% 装死

    const roll = rng();
    if (roll > adjustedRate) return null;

    return {
      target: from,
      content: String(content || '').slice(0, 200),
      attacksThisRound,
      triggeredReason,
      repeatCount,
    };
  }

  /** 实际发起攻击后调用 (记账用: 更新冷却, 上限, 上一个目标) */
  function recordAttack(target, ts = Date.now()) {
    lastAttackAt = ts;
    lastAttackTarget = target;
    attacksThisRound++;
    log(`[aggressive] 攻击 ${target} (本轮 ${attacksThisRound}/${maxAttacks})`);
  }

  /** 调试 / 工具命令用 */
  function snapshot() {
    return {
      enabled, active, startedAt, expiresAt,
      attacksThisRound, maxAttacks,
      cooldownMs, durationMs, attackRate,
      lastAttackAt, lastAttackTarget, triggeredReason,
    };
  }

  /** 测试 / 工具命令用: 强制重置 */
  function reset() {
    active = false;
    startedAt = 0;
    expiresAt = 0;
    lastAttackAt = 0;
    lastAttackTarget = null;
    attacksThisRound = 0;
    triggeredReason = null;
  }

  return { trigger, tick, recordAttack, snapshot, reset };
}

/** 测试用: 同步版本 (方便注入固定时间戳) */
export function createAggressiveModeSync(opts = {}) {
  const inner = createAggressiveMode({ ...opts, rng: () => 0 }); // 默认稳定 rng (force attack)
  return inner;
}

// ════════════════════════════════════════════════════════════════════
// 骚扰计数器: 同一用户重复同样内容 (复读/叫爹/嘬嘬嘬) → count 累加
// 用于: 在 @ 提及和 rage-mode attack 两条路径里都把 count 传给 LLM,
// 让 LLM 知道"这是第 N 次骚扰", 据此升级攻击性 (count>=3 直接怼, 不要装禅).
// ════════════════════════════════════════════════════════════════════
export function createHarassmentTracker(opts = {}) {
  const windowMs = opts.windowMs ?? 60 * 1000; // 60s 窗口
  const normLen = opts.normLen ?? 30;          // 内容前 30 字符为归一化 key
  const log = opts.log || (() => {});
  const map = new Map(); // user -> { count, lastKey, windowStart, ts }
  const nowFn = opts.now || (() => Date.now());

  /** 记录一次 (user, content), 返回当前连续计数 (>= 1)
   *  同样内容在 windowMs 内重复 → 累加; 否则重置为 1 */
  function record(user, content) {
    if (!user) return 1;
    const key = String(content || '').slice(0, normLen).trim();
    const now = nowFn();
    const entry = map.get(user);
    if (!entry || now - entry.windowStart > windowMs || entry.lastKey !== key) {
      const prev = entry?.count || 0;
      map.set(user, { count: 1, lastKey: key, windowStart: now, ts: now });
      return 1; // 不重复 → 重置, 不算骚扰
    }
    entry.count++;
    entry.windowStart = now;
    entry.ts = now;
    log(`[harassment] ${user} 第 ${entry.count} 次复读 ("${key.slice(0, 15)}")`);
    return entry.count;
  }

  function get(user) {
    const e = map.get(user);
    return e ? { count: e.count, lastKey: e.lastKey, windowStart: e.windowStart } : null;
  }

  function reset(user) {
    if (user) map.delete(user); else map.clear();
  }

  function snapshot() {
    return [...map.entries()].map(([u, e]) => ({ user: u, count: e.count, lastKey: e.lastKey, windowStart: e.windowStart }));
  }

  return { record, get, reset, snapshot };
}