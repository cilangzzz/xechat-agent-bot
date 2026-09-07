# lib/business/aggressive.mjs — 主动攻击模式 + 复读机计数

[`agent/lib/business/aggressive.mjs`](../../../agent/lib/business/aggressive.mjs) 实现两个相关机制:

1. **Rage Mode** (`createAggressiveMode`) — bot 被 @ 后进入主动攻击模式 (默认 5 min), 在窗口内按概率主动怼回去
2. **Harassment Tracker** (`createHarassmentTracker`) — 同一用户 60s 内复读同样内容 → 计数累加, 用于 LLM 升级攻击性

## 1. 设计目标

- 让 bot 在房间里**主动参与对话**, 而非只在被 @ 时说话
- 但不至于**回每条话**, 暴露"盯梢"行为
- 防刷屏 (单轮上限 + 冷却 + 同人回避)
- LLM 输出经 `humanizeReply` 含 `FAMILY_SLUR_HOMOPHONES` 黑名单, 骂家庭直接拦

## 2. Rage Mode API

```js
const aggressive = createAggressiveMode({
  enabled,       // 默认 true
  durationMs,    // 默认 5*60*1000 = 5 min
  cooldownMs,    // 默认 30*1000 = 30s
  maxAttacks,    // 默认 8 (单轮上限)
  attackRate,    // 默认 0.30 (30% 概率)
  log, rng, clock, // 注入测试用
});
```

| 方法 | 用途 |
|---|---|
| `trigger(reason?, now?)` | 进入 rage mode (被 @ 后 / 主动广播后调) |
| `tick({from, content, repeatCount, now?})` | 每条非 @ 聊天调一次, 返回 `null` 或攻击决策 |
| `recordAttack(target, ts?)` | 实际发起攻击后调 (更新冷却/同人/上限) |
| `snapshot()` | 调试 / 状态查询 |
| `reset()` | 强制重置 |

## 3. Rage Mode 状态机

```
              trigger(reason)
                   │
                   ▼
        ┌─────────────────────┐
        │ active=true          │
        │ expiresAt = now+5min │
        │ attacksThisRound = 0 │
        └─────────┬───────────┘
                  │
        每条非 @ 聊天 → tick({from, content})
                  │
                  ├─ 已过期?     → active=false → null
                  ├─ 达上限 8?   → active=false → null
                  ├─ 冷却 30s 内? → null
                  ├─ 同人连续?    → null
                  └─ rng > rate?  → null
                              │
                              ▼ (命中)
                  返回 {target, content, attacksThisRound, ...}
                              │
                  agent.mjs 实际发起攻击
                              │
                              ▼
                  recordAttack(target)
                              │
                  attacksThisRound++, lastAttackAt/ts 更新
```

## 4. 触发与续期

```js
function trigger(reason = 'mention', now = clock()) {
  if (!enabled) return;
  if (active && now < expiresAt) {
    expiresAt = now + durationMs;     // 续期
    triggeredReason = reason;
    return;
  }
  active = true;
  startedAt = now;
  expiresAt = now + durationMs;
  attacksThisRound = 0;
  lastAttackAt = 0;
  lastAttackTarget = null;
  triggeredReason = reason;
}
```

- **首次触发**: 进入 rage mode, `attacksThisRound=0`, `lastAttackAt=0`
- **续期** (在窗口内再次被 @): 仅延长 `expiresAt`, 不重置 `attacksThisRound`, 不重置 `lastAttackAt`
- **重触发** (窗口已过): 视为新一轮, 全状态重置

## 5. `tick()` 决策逻辑

```js
function tick({ from, content, repeatCount = 0, now = clock() }) {
  if (!enabled) return null;
  if (!active) return null;
  if (now >= expiresAt) { active = false; return null; }
  if (attacksThisRound >= maxAttacks) { active = false; return null; }
  if (now - lastAttackAt < cooldownMs) return null;
  if (lastAttackTarget && from === lastAttackTarget) return null;  // 不连续怼同人
  // ... 自适应概率 + rng
}
```

### 5.1 自适应概率 (复读机策略)

```js
let adjustedRate = attackRate;  // 默认 0.30
if (repeatCount >= 5) adjustedRate = 0.20;       // 80% 装死
else if (repeatCount >= 3) adjustedRate = 0.40;  // 60% 装死
```

| repeatCount | 调整后概率 | 含义 |
|---|---|---|
| 1-2 | 0.30 (基础) | 普通人, 偶尔怼 |
| 3-4 | 0.40 (40% 攻击) | 60% 装死, 但剩下的攻击要 HARD |
| 5+ | 0.20 (20% 攻击) | 80% 装死, 极少数才出手, 一出手就是重怼 |

> 注: `repeatCount` 由 `createHarassmentTracker` 提供, 见 §8。

## 6. `recordAttack()` 记账

```js
function recordAttack(target, ts = Date.now()) {
  lastAttackAt = ts;
  lastAttackTarget = target;
  attacksThisRound++;
}
```

只有**实际发起攻击**后才调, 不要在 `tick()` 命中时就调。

## 7. 默认配置

| 参数 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `durationMs` | `5 * 60 * 1000` | rage mode 持续 5 min |
| `cooldownMs` | `30 * 1000` | 两次攻击最少间隔 30s |
| `maxAttacks` | `8` | 单轮攻击上限 (超 8 自动退出) |
| `attackRate` | `0.30` | 每条消息 30% 概率攻击 |

## 8. Harassment Tracker API

```js
const tracker = createHarassmentTracker({
  windowMs,    // 默认 60*1000 = 60s 窗口
  normLen,     // 默认 30, 内容前 30 字符为归一化 key
  log, now,    // 注入测试用
});
```

| 方法 | 用途 |
|---|---|
| `record(user, content)` | 记录一次 (user, content), 返回当前连续计数 (>= 1) |
| `get(user)` | 查询某用户当前计数 |
| `reset(user?)` | 单用户 / 全清 |
| `snapshot()` | 全部用户的计数快照 |

### 8.1 计数规则

```js
const key = String(content || '').slice(0, normLen).trim();  // 前 30 字符
if (!entry || now - entry.windowStart > windowMs || entry.lastKey !== key) {
  // 新内容 或 超 60s → 重置为 1
  return 1;
}
entry.count++;  // 同样内容在 60s 内 → 累加
```

| 情况 | 计数 |
|---|---|
| 第一次发言 | 1 |
| 同内容 60s 内再次 | 2 |
| 同内容 60s 内第三次 | 3 |
| 不同内容 或 超 60s | **重置 1** |

### 8.2 在哪里用

- `@` 提及路径: agent.mjs 检测到 @大黄鱼 后, 把 count 传给 LLM, 让它知道"这是第 N 次 @"
- rage-mode attack 路径: tick() 把 count 作为 `repeatCount` 传给 §5.1 自适应概率
- count>=3 → LLM 直接怼, 不要装禅

## 9. 测试用导出

```js
export function createAggressiveModeSync(opts = {}) {
  return createAggressiveMode({ ...opts, rng: () => 0 });  // 默认稳定 rng → 强制攻击
}
```

`createAggressiveModeSync` 用固定 `rng: () => 0` (roll=0 < attackRate) 让 tick() **总是命中**, 方便单测验证攻击路径。

## 10. 坑点

### 10.1 不要把 `trigger()` 当 `tick()`

`trigger()` 是**进入 rage mode**, `tick()` 是**询问是否要攻击**。混淆会导致 bot 进入 rage mode 后第一条消息就触发攻击 (没经过 tick 决策)。

### 10.2 `recordAttack` 必须真发起了才调

tick() 返回命中 ≠ 已攻击。LLM 生成失败 / 网络错误都应让 `lastAttackAt` 不更新, 下一条还能再判。

### 10.3 同人回避只看 `lastAttackTarget`

不查"近 N 次都怼谁", 也不查"被怼者历史"。所以可以**轮询式**怼三个人: A → B → C → A → B → C (只要不连续同人)。

### 10.4 `repeatCount` 不传 = 0

tick() 默认 `repeatCount = 0`, 走基础 `attackRate`。必须从 `tracker.record(from, content)` 取, 不要自己估。

### 10.5 `enabled: false` 时 trigger() 是 no-op

```js
function trigger(reason = 'mention', now = clock()) {
  if (!enabled) return;  // ← 不进入 rage mode
}
```

但 rage mode 之前的 active 状态不变 (即"之前开了再关"会导致已经激活的实例继续工作)。如果需要彻底停, 调 `reset()`。

### 10.6 FAMILY_SLUR_HOMOPHONES 黑名单

`humanizeReply` 会拦骂家庭 / 同音字替换。LLM 输出"你妈" / "你🐴" / "nima" 等都会被替换或过滤, 不要绕过这个检查。