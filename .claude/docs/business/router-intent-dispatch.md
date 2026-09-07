# lib/business/router.mjs — 意图分类派发

> 本文件是 [router.md](./router.md) 第 2.4 节的展开。详细说明 `_classifyAndDispatch` / `_dispatchByIntent` / `_parseRoomIntent` / `_parseQueryIntent` 这一层的逻辑。

## 1. 入口: `_classifyAndDispatch(sub, arg, from)`

```js
async _classifyAndDispatch(sub, arg, from) {
  if (!sub) return null;
  const ic = this.cfg.intent || {};
  if (ic.enabled === false) return null;
  if (!this.llm) return null;
  const userText = arg ? `${sub} ${arg}`.trim() : sub;
  let intent = 'main';
  try {
    intent = await classifyIntent(userText, this.llm, { timeoutMs: ic.timeoutMs || 10000, log });
  } catch (e) { return null; }
  return this._dispatchByIntent(intent, userText, from);
}
```

| 条件 | 行为 |
|---|---|
| `sub` 为空 | `null` (回落到 main) |
| `cfg.intent.enabled === false` | `null` (关闭分类, 直接回 main) |
| `llm` 未绑定 | `null` |
| `classifyIntent` 抛错 | `null` (兜底) |

## 2. 派发表 `_dispatchByIntent(intent, userText, from)`

```js
switch (intent) {
  case 'explore':  return String(await this.subagent._runSubdirect('explore', userText, from));
  case 'math':     // 数字白名单 → _safeMath; 否则 math 子智能体
  case 'room':     // _parseRoomIntent → builtin.create-room/close-room/rooms
  case 'query':    // _parseQueryIntent → builtin.gold/online/stats/games/game
  default:         // builtin / chat / main / 未知 → null (回落到 main)
}
```

## 3. `_parseRoomIntent(text)` — 自然语言 → 房间命令

| 模式 | cmd | arg |
|---|---|---|
| `开一个/搞个/建个 + 游戏名 + 可选 (数字 + 可选模式)` | `create-room` | 游戏名 (含可选 nums/mode) |
| `关闭/关掉/取消/关 + 房间/ID + 数字` | `close-room` | 房间 ID |
| 纯长数字 (≥4 位) | `close-room` | 当房间 ID |
| `列/查/看看 + 房间/活动` | `rooms` | (空) |
| `(有) + 哪些/啥/几 + 房` | `rooms` | (空) |

例:
- "开一个五子棋房间 2" → `create-room 五子棋 2`
- "搞个不贪吃蛇" → `create-room 不贪吃蛇`
- "关闭房间 153449001" → `close-room 153449001`
- "153449001" (纯数字) → `close-room 153449001` (默认关闭)
- "看看活动房间" → `rooms`

## 4. `_parseQueryIntent(text)` — 自然语言 → 查询命令

| 模式 | cmd | arg |
|---|---|---|
| `今日金价 / 黄金价格 / 金价多少` | `gold` | (空) |
| `在线 / 现在谁 / 几个人` | `online` | (空) |
| `统计 / 现状 / 状态` | `stats` | (空) |
| `游戏列表 / 所有游戏` | `games` | (空) |
| `XX 怎么玩 / XX 是什么 / 游戏 XX` | `game` | XX |

例:
- "今日金价" → `gold`
- "现在有谁在线" → `online`
- "游戏五子棋怎么玩" → `game 五子棋`

## 5. 配置项 `cfg.intent`

```js
{
  intent: {
    enabled: true,         // 默认 true, false 时直接回落 main
    timeoutMs: 10000,      // classifyIntent 超时
  }
}
```

## 6. 与 intent.mjs 的关系

- 分类器本体见 [intent.md](./intent.md) (LRU + 7 类标签 + normalizeIntent)
- 这里只负责**拿到分类结果后**派发到 builtin / 子智能体
- 任何错误路径 (分类失败 / 派发抛错) 都返回 null → 回落 main agent, **绝不**让 LLM 之外路径报错

## 7. 关闭意图分类 (`cfg.intent.enabled = false`)

- 适用场景: 调试 / LLM 配额紧张 / 想直接看 main agent 表现
- 不影响 `_blockReason` 安全护栏, 仍生效
- 不影响 `builtin` 表, 仍生效
- 只是不再自动把"开个房间"路由到 `create-room`, 全部走 main agent 调 `create_room` 工具