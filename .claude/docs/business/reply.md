# makeReplySender 回复发送器

统一回复出口 —— 鱼塘服务端**单条聊天 200 字符硬上限**，所有对外文本（回答 / 💭 思考 / 工具提示 / 主动广播 / 定时提醒）必须经此工厂分片发送。

- 源文件: [lib/reply.mjs](../../../agent/lib/reply.mjs)（104 行）

## 1. 工厂

```js
makeReplySender({ send, maxLen = 200, chunkDelayMs = 600 })
  → async sendReply(content, to)
```

| 参数 | 含义 |
|---|---|
| `send` | 底层发送函数（`client.sendAction('CHAT', {...})`） |
| `maxLen` | 单条上限（默认 200，`MSG_MAX_LEN`） |
| `chunkDelayMs` | 分片间隔（默认 600ms，`MSG_CHUNK_DELAY_MS`） |

`to` 语义：`null`/`''` → 广播（`toUsers: []`）；其它 → 定向（`toUsers: [to]`）。

## 2. 分片策略（`splitForMarkdown`）

三档降级，保证 `pieces.join('')` 精确还原原文本：

1. **行边界优先**：按 `'\n'` 分行贪心装片，保住 markdown 结构（`## 标题` / `- 列表项` / 段落不被切断）；收尾片若后面还有行则补尾 `\n`；
2. **单行超长**：在可读标点/空格边界切 —— `SOFT_BOUNDARY` 含 ` 、。，；：！？ / \ | — – - _ ) 】 } 》 ` 等，切点选在边界字符之后（避免 `"abc |"` 结尾）；无边界则硬切；
3. **emoji 不切碎**：按码点计数（`Array.from`），代理对永不被拆开。

续片预算比首片少 `'↪ '` 的码点长度（首片 200 / 续片 198）。

## 3. 续段前缀 `↪`

首片无前缀，续片 `wire = '↪ ' + chunk`。用户看到 `↪` 即知是上一条的续接；去掉续片前缀后 `join('')` 精确等于原文。

## 4. 分片间隔

片间 `await sleep(chunkDelayMs)`，最后一片后不等待；`chunkDelayMs <= 0` 跳过（测试/极速）。默认 600ms 防服务端去抖丢包。

## 5. 定向 vs 广播

| 调用 | `toUsers` | 行为 |
|---|---|---|
| `sendReply(t, user)` | `[user]` | 定向 |
| `sendReply(t, null)` / `''` / `undefined` | `[]` | 广播 |

注意：鱼塘 `toUsers` 协议层对所有客户端广播，仅用户端过滤"指向他人"的消息，并非真私密 —— 持久记忆默认关。

## 6. 空内容保护

`content == null` / `''` → 直接 return，不发任何消息。

## 7. 调用方

| 来源 | 调用 |
|---|---|
| 主回复 | `await sendReply(reply, from)` |
| 思考提示 | `sendReply('${thinkingPrefix} ${step}', from)`（异步不 await） |
| 主动广播 | `await sendReply(msg, null)` |
| 定时回调 | `await sendReply('🔔 [定时] ...', t.to)` |

## 8. 关键约束

- 任何 `client.sendAction('CHAT', ...)` 直接调用都应改用 `sendReply`；
- 不要硬改 `maxLen`（服务端约束）；`chunkDelayMs` 别设 0（去抖丢包）；
- `splitForMarkdown` 是纯函数，可直接单元测试。
