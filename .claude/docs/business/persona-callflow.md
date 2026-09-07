# lib/business/persona.mjs — 完整调用链

> 本文件是 [persona.md](./persona.md) §8 的展开。完整展示一次 @ 提及从输入到回复的全流程。

## 1. 输入示例

```
@大黄鱼 你🐴呢
```

## 2. 全流程

```
@大黄鱼 你🐴呢
   │
   ▼
Router.handleMention({from, text, repeatCount})
   │
   ├─ persona.analyze(text, from, {roomLog, lastReplyAtByUser, personaKind})
   │     ├─ scoreMessage: 俚语 "你🐴呢" → human +0.40
   │     ├─ 时长 (6 字) → human +0.55
   │     ├─ 时间 (深夜 03:00) → human +0.15
   │     ├─ 用户黏性 (上一轮 human) → human +0.10
   │     └─ 房间氛围 (最近俚语比例 0.4) → human +0.20
   │
   │     → decision = {
   │         mode: 'human',
   │         mood: 'hostile',
   │         lengthBudget: 'one-liner',
   │         emojiBudget: 0,
   │         typoChance: 0.05,
   │         reply: 'normal',
   │         reason: '...',
   │         score: {human: 1.40, formal: 0, signals: [...]}
   │       }
   │
   ├─ repeatCount (来自 aggressive.mjs 的 tracker.record) >= 5? → 70% 装死 → return ''
   │
   ├─ decision.reply === 'lurk'/'busy'? → return ack (空串 / '👀')
   │
   ├─ sys = _buildChatSystemPrompt(summary, decision)
   │     ├─ mode === 'human' →
   │     │     ├─ personaEngine.getPrompt()        // 启动时 LLM 生成的人设 prompt
   │     │     ├─ roomTail (最近 6 条房间消息)      // 现场氛围背景
   │     │     ├─ behaviorLines (mood/len/emoji/typo 硬性控制)
   │     │     └─ repeatEscalation (repeatCount >= 3 加重怼, >= 5 严重复读)
   │     │
   │     └─ mode === 'formal' → buildSystemPrompt(main agent)
   │
   ├─ reply = await llm.agentTurn({
   │     systemPrompt: sys,
   │     history: snap.history,
   │     tools: [],   // chatView() 空工具
   │     onThinking: () => {},  // @ 聊天静默
   │     from,
   │   })
   │
   │     → LLM 输出: "啧 你🐴呢 爬"
   │
   ├─ reply = humanizeReply(reply, {noFamilyFilter: this.cfg.persona?.noFamilyFilter})
   │     ├─ 句末 🐟 去掉 (没有)
   │     ├─ AI 否认句去掉 (没有)
   │     └─ FAMILY_SLUR_HOMOPHONES 黑名单
   │           └─ "你🐴呢" → "你[已过滤]呢" 或保留 (取决于 noFamilyFilter)
   │
   ├─ reply = _addReplyPrefix(reply)
   │     └─ "啧 你🐴呢 爬" → 不加 (已有 "啧")
   │
   └─ sessions.pushAssistant + persona.noteReply + return reply
```

## 3. 关键字段映射

| 字段 | 来源 | 用途 |
|---|---|---|
| `mode` | `persona.analyze` | 决定 `_buildChatSystemPrompt` 走 human/formal 分支 |
| `mood` | `pickMood(personaKind, rng)` | 注入 prompt 的"## 本轮节奏 mood: ..." 行 |
| `lengthBudget` | `pickLengthBudget(rng)` | 注入 prompt 的长度硬性约束 |
| `emojiBudget` | `pickEmojiBudget(rng)` | 注入 prompt 的 emoji 配额 |
| `typoChance` | `pickTypoChance(rng)` | 注入 prompt 的打字出错率 |
| `reply` | `pickReplyAction(text, ctx, rng)` | Router 据此决定是否真发 (lurk/busy 跳过 LLM) |
| `repeatCount` | 外部传入 (来自 `aggressive.mjs` tracker) | 触发复读机升级模板 |

## 4. 异常路径

| 情况 | 行为 |
|---|---|
| `mentionEnabled() === false` | Router 直接返回空串 |
| `persona.analyze` 抛错 | Router catch → 走默认 formal 分支 |
| `llm.agentTurn` 抛错 | Router catch → `'啊?'` |
| `humanizeReply` 替换掉全部内容 | Router 返回空串 (极端情况, 通常不会) |
| `personaEngine.getPrompt()` 返回空 | Router fallback 到 `getHumanSystemPrompt()` (李乐儿种子) |

## 5. 状态变更

| 状态 | 何时变更 |
|---|---|
| `persona._lastReplyAtByUser` | `persona.noteReply(from)` 在每次 mention 处理后调 |
| `sessions.pushAssistant(key, reply)` | 同上, 但写的是对话历史 |
| `persona._lastReplySnapshot` | Router 在 `handleMention` 入口复制传给 `analyze` |

这些状态用于下一轮的"用户黏性"评分 + 下次启动的 prompt 工程参考。