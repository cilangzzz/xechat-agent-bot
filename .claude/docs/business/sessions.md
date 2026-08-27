# SessionStore 会话管理

`SessionStore` 提供每个用户独立的会话：摘要 + 最近消息 + 待办 + per-user 并发锁。压缩参考 opencode —— token 预算内保留最近消息，多余旧消息由 LLM 压成结构化摘要。

- 源文件: [lib/sessions.mjs](../../../agent/lib/sessions.mjs)（118 行）
- 配套: [compaction.md](../foundation/compaction.md)（token 估算与摘要器）

## 1. 会话模型与数据结构

每个 `userKey` 对应一条会话：

```ts
type Session = {
  history:     { role: 'user'|'assistant'; content: string }[]
  summary:     string          // 累积压缩产物
  todos:       Todo[]          // 见 lib/todo
  lastActive:  number          // ms, 供 gc 用
  compressing: boolean         // 防重入
}
```

**userKey 取值**：

- 命令/常规聊天 → `from`（登录名）；
- @ 提及纯聊天 → `chat:<from>`（**上下文隔离**，见 router.md §3）；
- 定时任务执行 → 与创建者共用 `from`。

容器：`map: Map<userKey, Session>` + `locks: Map<userKey, Promise>`。

构造参数：`{ historyMax=10, compressAt=14, summaryMaxLen=800, ttlMs=0, compressBudgetTokens=3000 }`。

| 字段 | 默认 | 含义 |
|---|---|---|
| `historyMax` | 10 | 压缩时必须至少保留的最近消息数 |
| `compressAt` | 14 | 旧版兼容字段（已非唯一触发条件） |
| `summaryMaxLen` | 800 | 摘要截断上限 |
| `ttlMs` | 0 | >0 时 `gc()` 惰性清理过期会话 |
| `compressBudgetTokens` | 3000 | token 预算式压缩阈值 |

## 2. 读写接口

- `pushUser(u, content)`：user 消息入库 + 更新 `lastActive` + 返回快照；
- `pushAssistant(u, content)`：assistant 回复入库；
- `get(u)`：返回 `{ summary, history, todos }` 副本；
- `getRawHistory(u)`：原始 history（测试用）；
- `clear(u)`：删除会话（含待办）。

`_get` 懒初始化 `{ history: [], summary: '', todos: [], lastActive, compressing: false }`；`_snapshot` 返回副本，外部 push 不污染 store。

## 3. tryLock —— per-user 并发锁

```js
async acquire(username)          // 串行等待前序任务，返回 release
tryLock(username)                // 非阻塞: 已在处理返回 null, 否则返回 release
```

- `tryLock` 是 agent.mjs 入口采用的方案：同用户已在处理 → 后续消息直接**跳过**（聊天室场景，丢弃比排队好）；
- 不同用户互不阻塞，房间内多人同时 @ 可并行处理；
- `busyUsers`（入口 Set）是锁的占位镜像：占用 → 跳过；处理完 `delete` 并释放。

## 4. 历史保留

`historyMax` 是**压缩保留的下限**：触发压缩时至少保留最近 `historyMax` 条（即使单条超预算），保证模型每次回合至少有 N 条原文 + 累积 summary。

## 5. 压缩触发 `maybeCompress`

```js
async maybeCompress(username, summarizeFn, opts = {})  // → 是否真的压缩
```

按 token 预算工作：

1. `estimateTokens(history 各条 content)` 不超预算 → 返回 false；
2. history 长度 ≤ `historyMax` → 不压；
3. `compressing=true` 防重入；
4. `select(history, budget)` 切 head（压）+ recent（留）；不足 `historyMax` 则保留最后 N 条；
5. `summarizeFn(prevSummary, head)` → 新摘要按 `summaryMaxLen` 截断写回 `s.summary`，history 收缩为 keep；
6. `finally` 复位 `compressing`。

每回合由 `router.handle` 调用（`pushUser` 后），或 `_forceCompress` 强制全量压缩。

## 6. 上下文注入 `getContext`

```js
const snap = sessions.pushUser(from, userText);          // 写入 + 读快照
const systemPrompt = _buildMainSystemPrompt(snap.summary); // summary 拼进 system prompt
reply = await llm.agentTurn({ systemPrompt, history: snap.history, ... });
```

组合模式 = system prompt 末尾追加 `[之前的对话摘要]\n${summary}`，history 作对话消息列表。

## 7. @ 提及上下文隔离

`@` 聊天键为 `chat:${from}`（`_chatKey`，前缀可配 `mention.chatKeyPrefix`）。命令上下文与闲聊上下文各自独立 summary/history，互不污染 —— 命令历史的工具调用不会混入闲聊，反之亦然。

## 8. 垃圾回收 `gc`

- `ttlMs = 0` → 禁用；
- `ttlMs > 0` → 外部调用 `store.gc()`，删除 `now - lastActive > ttlMs` 的会话。注意：入口未自动周期调用，需自行接入。

## 9. 测试要点

- `tryLock` 同用户二次拿锁返回 `null`，释放后可再拿；
- `_snapshot` 返回数组副本；
- `maybeCompress` 在 `compressing` 时返回 false（并发安全）；
- 会话仅内存态，重启丢失 —— 持久事实靠 [memory.mjs](../business/peripheral.md)。
