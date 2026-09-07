# lib/business/persona.mjs — 拟人形态 / 人设触发器

[`agent/lib/business/persona.mjs`](../../../agent/lib/business/persona.mjs) (45013 B, 922 行) 是项目最大单一模块, 由 commit `d474b50` + `3e6cb26` 引入。目标: 让 @ 提及聊天回复在不同语境下自动切换"AI 助手腔"与"鱼塘老网友腔"。

> **设计参考**: opencode 多智能体的"决策委托"模式 (决策本身是 LLM 的工具调用结果, 而非 LLM 自由发挥)。

## 1. 架构总览

```
┌──────────────────────────────────────────────────────────────────┐
│              createPersonaTrigger (运行时实例)                     │
│                                                                  │
│   analyze(text, from, ctx) → decision                             │
│   │                                                               │
│   ├─ scoreMessage(text)         文本特征 [0..1] 倾向打分         │
│   ├─ + 时间偏好                深夜/清晨 +0.15 偏 human          │
│   ├─ + 用户黏性 (lastReplyAtByUser)  上一轮 human → 本轮 human    │
│   ├─ + 房间氛围 (roomLog)       最近 N 条俚语比例                │
│   │                                                               │
│   └─ pickPersona() 综合 → {mode: 'human'|'formal', score, reason} │
│                                                                  │
│   enrichDecision(decision) → 加 mood/lengthBudget/emojiBudget/    │
│                              typoChance/reply 8 个字段            │
│                                                                  │
│   noteReply(from)  记录本轮用 human, 下轮用户黏性用               │
└──────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│              createPersonaEngine (启动时实例, 异步)                │
│                                                                  │
│   getPrompt() → 启动时 LLM 动态生成的人设 prompt (3000 字左右)     │
│                  默认落盘 log/persona.json                        │
│                  失败回退内置 BASE_PERSONA_PROMPT (李乐儿种子)     │
└──────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│              后处理 (handleMention 调用)                          │
│                                                                  │
│   humanizeReply(reply) → 去 AI tell (🐟 句末 / "我是真人"否认)   │
│                          + FAMILY_SLUR_HOMOPHONES 黑名单         │
│   _addReplyPrefix(reply)  → 短裸回加 "啧/哎/嗯嗯" 前置          │
└──────────────────────────────────────────────────────────────────┘
```

## 2. 两套独立机制

| 机制 | 输入 | 输出 | 调用点 |
|---|---|---|---|
| `createPersonaTrigger` | `(text, from, ctx)` | `{mode, mood, lengthBudget, emojiBudget, typoChance, reply, reason}` | `Router.handleMention()` 每次 @ 提及 |
| `createPersonaEngine` | (启动时异步) | `getPrompt()` 返回最终人设 prompt | `Router._buildChatSystemPrompt` human 分支 |

两个机制互不依赖, `ENABLE_TRIGGER=0` / `DISABLE_PERSONA=1` 各自独立开关。

## 3. 触发器: `createPersonaTrigger(opts)`

```js
const trigger = createPersonaTrigger({
  enabled: true,                    // 默认 true
  defaultMode: MODE_FORMAL,         // 兜底默认
  tieMargin: 0.15,                  // 边缘分差阈值
  maxStickiness: 200,               // 用户黏性表最大条目数
  hourBiasHumanRanges: [{start:0, end:7}], // 偏 human 的小时段
});
```

### 3.1 `analyze(text, from, ctx)` → decision

| 字段 | 类型 | 含义 |
|---|---|---|
| `mode` | `'human'`/`'formal'` | 本轮采用哪种腔 |
| `reason` | string | 决策理由 (调试用) |
| `score` | `{human, formal, signals}` | 评分明细 (4 路信号) |
| `mood` | string | 心情 ('neutral'/'warm'/'hostile'/'flirty') |
| `lengthBudget` | string | 'one-liner'/'short'/'normal'/'verbose' |
| `emojiBudget` | number | 本轮允许 emoji 数 (0/1/2) |
| `typoChance` | number (0..1) | 打字出错率 |
| `reply` | string | 'normal'/'lurk'/'busy' |

`reply === 'lurk'` → Router 直接返回空串 (装死); `'busy'` → 返回 '👀'。

### 3.2 评分四路信号

```js
function pickPersona(text, from, ctx = {}) {
  // 1) scoreMessage(text) — 文本特征 (见 [persona-scoring.md](./persona-scoring.md))
  // 2) 时间偏好: hourBiasHumanRanges 命中 → +0.15 human
  // 3) 用户黏性: ctx.lastReplyAtByUser.get(from) 最近用过 human → +0.10 human
  // 4) 房间氛围: ctx.roomLog 最近 N 条里俚语比例 → 各 +0.10~0.20
  // 总分高的一方胜出; |差| < tieMargin → 退到 defaultMode
}
```

| 路 | 范围 | 贡献 |
|---|---|---|
| 1) 文本特征 | 招呼强信号 + 长度 + 俚语 + formal 关键词 + emoji/礼貌语 | human/formal 各 +0.10~0.85 |
| 2) 时间偏好 | `hourBiasHumanRanges` 命中 (默认 0-7) | human +0.15 |
| 3) 用户黏性 | `lastReplyAtByUser.get(from)` 最近用过 human | human +0.10 |
| 4) 房间氛围 | `roomLog` 最近 N 条俚语比例 | human +0.10~0.20 |

### 3.3 文本特征 `scoreMessage(text)`

```js
const s = newScore();
// 招呼强信号先判 (避免长度盖掉)
if (GREETING_FORMAL.test(t)) add(s, 'formal', 0.85, '礼貌招呼');
else if (GREETING_HUMAN.test(t)) add(s, 'human', 0.85, '口语招呼');
// 长度加权 (中文按字计数: [...t].length)
// 俚语命中: +0.40 human
// formal 关键词命中: +0.40 formal
// emoji 多 (>2): +0.20 human
// 多问号 (>2): +0.20 human
// 礼貌语 (谢谢/感谢): +0.30 formal
```

**完整 SLANG / FORMAL / GREETING 正则 + 长度档位 + 实战例子** 见 [persona-scoring.md](./persona-scoring.md)。

### 3.4 评分汇总表

| 信号 | human 加分 | formal 加分 |
|---|---|---|
| 口语招呼 (咋了/咋啦/干嘛呢) | +0.85 | — |
| 礼貌招呼 (你好/在吗/Hi) | — | +0.85 |
| 极短 (≤6 字) | +0.55 | — |
| 中长 (40-120 字) | — | +0.10~0.30 |
| 超长 (>120 字) | — | +0.50 |
| 俚语命中 (笑死/儒雅随和/你🐴呢) | +0.40 | — |
| 正式关键词 (请/翻译/分析/bug/git) | — | +0.40 |
| emoji >2 个 | +0.20 | — |
| 多问号 ??+ | +0.20 | — |
| 礼貌词 (谢谢/感谢) | — | +0.30 |
| 深夜/清晨 (configurable) | +0.15 | — |
| 用户黏性 (上一轮 human) | +0.10 | — |
| 房间俚语比例高 | +0.10~0.20 | — |

## 4. 行为描述符: `enrichDecision(decision, from, ctx)`

`analyze` 后的 `decision` 还需补上 8 个行为字段:

```js
function pickMood(personaKind, rng) { ... }      // 心情
function pickLengthBudget(rng) { ... }            // 长度档
function pickEmojiBudget(rng) { ... }             // emoji 配额
function pickTypoChance(rng) { ... }              // 出错率
function pickReplyAction(text, ctx, rng) { ... }  // 回复动作 (normal/lurk/busy)
function pickRandomEmoji(rng) { ... }             // 随机 emoji
```

| 字段 | 取值 | 用途 (注入 prompt) |
|---|---|---|
| `mood` | 'neutral'/'warm'/'hostile'/'flirty' | 决定语气基调 |
| `lengthBudget` | 'one-liner' (≤8) / 'short' (≤25) / 'normal' (≤60) / 'verbose' (≤100) | 硬性控制 LLM 输出长度 |
| `emojiBudget` | 0/1/2 | 本轮 emoji 配额 |
| `typoChance` | 0..1 | 偶尔漏字/多字, 不用修 |
| `reply` | 'normal'/'lurk'/'busy' | Router 据此决定是否真发 |

## 5. 人设 prompt 引擎: `createPersonaEngine(opts)`

详细 API / 工作流程 / 配置 / `BASE_PERSONA_PROMPT` v2 变化 / 短回复指北 / 严禁段 见 [persona-engine.md](./persona-engine.md)。

简要版:

```js
const engine = createPersonaEngine({ cfg, llm, log });
await engine.init();           // 异步生成 prompt (10-30s)
const prompt = engine.getPrompt();
```

## 6. 后处理: `humanizeReply(text, ctx)` + `_addReplyPrefix(text, rng)`

### 6.1 `humanizeReply`

去掉 LLM 残留的 AI tell:

| 处理 | 例子 |
|---|---|
| 句末 `🐟` | "你好🐟" → "你好" |
| AI 否认句 | "我是真人" / "我不是 AI" / "我是大语言模型" → 删除 |
| 暴露 AI 身份 | "我是助手" / "请文明交流" → 删除 |
| `FAMILY_SLUR_HOMOPHONES` 黑名单 | "你🐴呢" / "你妈" / "nima" → 替换或过滤 |

```js
humanizeReply(reply, { noFamilyFilter: false })
// noFamilyFilter=true → 跳过 FAMILY_SLUR_HOMOPHONES (几波大这种直接攻击型用)
```

### 6.2 `_addReplyPrefix`

短裸回 (≤6 字且无前置) 自动加 "啧/哎/嗯嗯/呵" 等:

| 长度 | 不加前置 |
|---|---|
| 0-6 字 + 无前置 | 加 (随机: 啧/哎/嗯嗯/呵/好家伙) |
| 7+ 字 | 不加 |
| 已有前置 (啧/哎/嗯/哈/呵/我超/好家伙/我去/切/哈喽) | 不加 |

```js
_addReplyPrefix(reply, rng)
// PERSONA_NO_PREFIX=1 → 整个函数变 no-op
```

## 7. 与 trigger.mjs 的区别

| 项 | persona.mjs | trigger.mjs |
|---|---|---|
| 角色 | **被回应的角色** (别人 @ 我) | **发起者** (多人发言, 我主动插话) |
| 触发 | @ 我 / mention 我 | 多人对话中触发器命中 |
| prompt | 动态人设 prompt (LLM 启动生成) | TRIGGER_SYSTEM (固定) |
| 默认 | `MODE_FORMAL` | `MODE_FORMAL` 同样适用 |

两个互不依赖, 各自独立开关。详见 [trigger 文档](#) (在 peripheral.md 里)。

## 8. 完整调用链 (handleMention)

详见 [persona-callflow.md](./persona-callflow.md) — 包含 ASCII 流程图、字段映射、异常路径、状态变更表。

## 9. 坑点

**详细列表见 [persona-pitfalls.md](./persona-pitfalls.md)**, 主要 11 项:

1. 启动慢 (10-30s LLM 生成 prompt)
3. 落盘 prompt 必须包含关键事实
3. 短回复指北不要扩展
4. `humanizeReply` 替换可能误伤 (FAMILY_SLUR_HOMOPHONES substring 匹配)
5. `_addReplyPrefix` 已有前置不重加
6. `tieMargin = 0.15` 边缘不强制
7. 与 trigger.mjs 不要双重启用
8. 启动期 race condition (fallback 到李乐儿种子)
9. 复读机升级模板依赖 `repeatCount`
10. 日志噪音
11. 调试建议

- 每次 mention 调用 `analyze` 是 O(1) (纯正则 + 分数累加), **不调 LLM**
- `getPrompt()` 启动后是 O(1) (缓存)
- `humanizeReply` 是 O(N) 正则替换, 短回复可忽略
- 日志: `[persona] ${from} → ${mode} mood=${mood} len=${lengthBudget} emoji=${emojiBudget} repeat=${repeatCount} | <reply 前60字>`