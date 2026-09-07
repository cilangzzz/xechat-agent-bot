# lib/business/router.mjs — @ 提及与拟人触发器

> 本文件是 [router.md](./router.md) 第 3 节的展开。详细说明 `extractMention` / `handleMention` / `_buildChatSystemPrompt` 的拟人化路径。

## 1. `extractMention(content, username)`

```js
export function extractMention(text, username) {
  const t = String(text || '').trim();
  if (!t || !username) return '';
  const names = [username, username.replace(/的大黄鱼$/, '')].filter(Boolean);
  const pat = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const re = new RegExp(`@\\s*(${pat})[\\s:：]*([\\s\\S]*)`, 'i');
  const m = t.match(re);
  if (!m) return '';
  const rest = (m[2] || '').trim();
  if (rest) return rest;
  return '(你 @ 到我了, 想聊点什么?)';
}
```

- 同时匹配完整登录名与去除 `<X>的大黄鱼` 后的领养人短名, **两者都视为 @ 提及**
- 无 @ 提及 → 返回空串 (调用方不处理)
- 有 @ 但无正文 → 返回占位 `'(你 @ 到我了, 想聊点什么?)'`

## 2. `handleMention({ from, text, isLive, onThinking, repeatCount })`

### 2.1 完整流程

```js
async handleMention({ from, text, isLive, onThinking, repeatCount = 0 }) {
  if (!this.mentionEnabled()) return '';
  const key = this._chatKey(from);                  // 'chat:' + from
  const chatText = String(text || '').trim();
  this.sessions.pushUser(key, chatText);
  if (this._summarize) await this.sessions.maybeCompress(key, this._summarize);
  const snap = this.sessions.get(key);

  // 1) 拟人决策
  const decision = this.persona.analyze(chatText, from, this.pondState.roomLog, {
    lastReplyAtByUser: lastReplyMap,
    personaKind: this.cfg.persona?.kind || null,
  });

  // 2) 强制 human 模式
  if (this.cfg.persona?.forceHuman && decision.mode !== MODE_HUMAN) decision.mode = MODE_HUMAN;

  // 3) 复读机 5+: 70% 概率装死
  if (repeatCount >= 5 && Math.random() < 0.7) {
    if (this.deps && this.deps.log) this.deps.log(`[persona] ${from} → lurk (repeat=${repeatCount})`);
    this.persona.noteReply(from);
    return '';
  }

  // 4) 装死/敷衍 (lurk / busy)
  if (decision.reply === 'lurk' || decision.reply === 'busy') {
    const ack = decision.reply === 'busy' ? '👀' : '';
    if (ack) this.sessions.pushAssistant(key, ack);
    this.persona.noteReply(from);
    return ack;
  }

  // 5) 正常路径
  const sys = this._buildChatSystemPrompt(snap.summary, { ...decision, repeatCount });
  let reply;
  try {
    reply = await this.llm.agentTurn({
      systemPrompt: sys, history: snap.history,
      tools: this.chatView(), onThinking: () => {}, from,
    });
  } catch (e) { reply = '啊?'; }
  reply = humanizeReply(reply, { noFamilyFilter: this.cfg.persona?.noFamilyFilter === true });
  if (!this.cfg.persona?.noPrefix) reply = _addReplyPrefix(reply);

  this.sessions.pushAssistant(key, reply);
  this.persona.noteReply(from);
  return reply;
}
```

### 2.2 关键要点

| 项 | 说明 |
|---|---|
| **决策权在 persona trigger** | `persona.analyze()` 给 8 个字段 (mode/mood/length/emoji/reply/typo/mood/...) |
| **不调任何工具** | `chatView()` 返回空工具视图 `tools.filter([])` |
| **上下文键以 `chat:` 前缀** | 与命令会话完全隔离 |
| **`onThinking = () => {}`** | @ 聊天静默, 不发 "💭 好的" 等思考提示 |
| **`mentionEnabled`** | 默认 `cfg.mention?.enabled`, 关闭时直接返回空串 |
| **`repeatCount >= 5`** | 70% 概率装死不回 (与 aggressive.mjs 协同) |
| **`lurk` / `busy`** | 不调 LLM, `lurk`=空串, `busy`=👀 |

## 3. `_buildChatSystemPrompt` 两个分支

### 3.1 `decision.mode === 'human'` 拟人分支

1. 取 `personaEngine.getPrompt()` (启动时 AI 生成, 失败回退李乐儿模板)
2. 注入房间最近 6 条消息作为"现场氛围"背景 (让模型知道不是要复述)
3. 拼 `decision` 字段: mood / lengthBudget / emojiBudget / typoChance → 硬性控制 LLM 输出形态
4. 复读机 ≥3 加重怼模板, ≥5 严重复读模板
5. `humanizeReply` 后处理: 去 AI tell (🐟 句末、"我是真人"否认)
6. `_addReplyPrefix`: 短裸回自动加 "啧/哎/嗯嗯" 前置

### 3.2 `decision.mode === 'formal'` 助手分支

```js
const sys = buildSystemPrompt({
  agent: { ...def, extra: '@ 提及对话模式: 只闲聊与答疑, 不调用工具、不做平台查询, 用你的常识与已有上下文回答。' },
  env, toolList: [], cfg: this.cfg,
});
return summary ? `${sys}\n\n[之前的对话摘要]\n${summary}` : sys;
```

沿用原本 main agent 的闲聊模式, 工具视图空 (`toolList: []`)。

## 4. 复读机升级模板 (human 模式注入)

```js
const repeatEscalation = repeatCount >= 5
  ? `\n## 复读 ${repeatCount} 次 (严重复读) — 真老哥已经烦透顶
- **上来就怼**, 别装禅, 别装没看见
- 用最猛的词 (爬/滚/闭嘴/丢人现眼/活腻了/你🐴呢/狗叫/丢人丢到姥姥家/谁给你的勇气)
- 不要再 "嗯嗯 你说得对" 这种温和版`
  : repeatCount >= 3
  ? `\n## 复读 ${repeatCount} 次 — 别装禅, 直接怼
- 短怼: 你🐴呢 / 爬 / 闭嘴 / 丢人现眼 / 活腻了 之类
- 不要再 "嗯嗯 你说得对" 这种温和版`
  : '';
```

## 5. 防模板化 (human 模式注入到 `behaviorLines`)

```js
const behaviorLines = [
  '\n## 本轮节奏 (硬性, 直接决定输出形态)',
  `- mood: ${mood}`,
  `- 长度: ${lengthBudget} (one-liner ≤8 字 / short ≤25 / normal ≤60 / verbose ≤100)`,
  `- emoji 配额: 本轮 ${emojiBudget} 个; emoji 30% 概率才用, ...`,
  `- 打字出错率: ${typoChance}%`,
  `- **分段发**: 多句想法用 \\n 拆一条`,
  `- **必带前置**: 装逼→啧/呵/切; 挑衅→哎/我超/好家伙; ...`,
  `- 别否认身份: 不要 "我是真人" / "我不是 AI"`,
  `- 被打脸直接认: "哦我说错了"`,
  repeatEscalation,
];
```

详见 [persona.md](./persona.md) 的 trigger 决策表。