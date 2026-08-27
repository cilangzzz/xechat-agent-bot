# lib/compaction.mjs — 结构化上下文压缩

> 源码: [agent/lib/compaction.mjs](../../../agent/lib/compaction.mjs) (121 行, 纯函数无依赖)
> 协作: [agent/lib/sessions.mjs](../../../agent/lib/sessions.mjs) · [agent/lib/router.mjs](../../../agent/lib/router.mjs)

## 1. 设计目标

- **长对话不爆上下文**: 会话历史有界, 旧消息压成摘要而不是直接丢弃。
- **摘要可继续推进**: 摘要是"锚点"而非"回顾"—— 另一个智能体只读摘要也能接着干活。
- **纯函数可单测**: 本模块不持有状态、不直接读配置; 状态在 `SessionStore`。

## 2. 双触发机制 (两套字段并存)

| 触发方式 | 字段 | 默认 | 说明 |
|---|---|---|---|
| 老: 消息数 | `COMPRESS_AT` | 14 | 兼容字段, 已不是唯一触发条件 |
| 老: 摘要长度 | `SUMMARY_MAX_LEN` | 400 / 800 | 摘要写回时的字符上限 (硬截断) |
| 新: token 预算 | `COMPACTION_TOKEN_BUDGET` | 3000 | 估计 token 超预算即触发 (参考 opencode) |

- 新机制是主路径: `SessionStore.compressBudgetTokens` ← `cfg.compaction.budgetTokens`。
- 老 `compressAt` 保留在 `SessionStore` 上但不参与判定, 避免旧配置/旧测试破裂。
- 另有下限保护: `history.length <= historyMax` 时不压 (默认 10 条)。

## 3. 核心函数

### estimateTokens(text)
- 轻量启发式: CJK 约 1 token/字符, 非 CJK 约 3.5 字符/token, 换行不计。
- 只用于预算决策, **不追求精确**—— 不调 tokenizer, 零依赖。

### select(messages, budget)
- 从**尾部向前**累加 token, 找"能塞进预算的最大尾部"。
- 返回 `{ head, recent }`: `head` = 要压缩的旧消息, `recent` = 原样保留。
- 与"无差别砍到 N 条"的区别: 短消息多则多留, 长消息则少留 —— 预算恒定。

### serializeForSummary(messages)
- 把消息渲染成 `用户: ... / 助手: ...` 的纯文本, 交给摘要器阅读。

### buildSummaryPrompt({ previousSummary, head })
- 无 `previousSummary`: `<conversation>` + "生成新锚定摘要" + `SUMMARY_TEMPLATE`。
- 有 `previousSummary`: 再插入 `<prior-summary>` 块 + 增量合并说明。

### summarizeWithLlm({ llm, previousSummary, messages })
- 用固定系统提示词 `你是会话压缩器, 只输出结构化的摘要。` 调 `llm.chat`。
- **失败降级**: 抛异常时返回 `previousSummary || ''` —— 压缩失败不破坏会话。

### truncateOutput(value, max = 2000)
- 工具结果统一截断, 尾部追加 `...[输出过长已截断]`。
- 与压缩互补: 压缩管历史总量, 截断管单条工具输出峰值。

## 4. 摘要模板 (SUMMARY_TEMPLATE)

按固定章节与顺序输出纯文本, 空节写 `(无)`:

```
## 目标 (Objective)              用户想达成什么
## 重要背景 (Important Details)  约束/偏好/决定与原因/关键事实
## 工作进展 (Work State)
### 已完成
### 进行中
### 阻塞
## 下一步 (Next Move)
## 相关资源 (Relevant)           URL / 游戏名 / 用户提到的名称与偏好, 保留原名
```

模板附带的硬规则:
- 每节都保留, 即使为空。
- 用简短要点, 不写整段散文。
- 尽量保留确切的名字、URL、指令、结论、数字。
- 不提及"这是摘要"或压缩过程本身。

## 5. 增量合并

有上一次摘要时, `SUMMARY_UPDATE_INSTRUCTIONS` 明确告知:
- `<prior-summary>` 合并后即丢弃 —— **没写进新摘要的内容永久丢失**。
- 必带过去: 目标 / 约束 / 用户指令 / 决定 / 进行中的工作 (即使新对话没再提)。
- 冲突以 `<conversation>` 为准 (对话更新), 修正事实、删旧说法。
- 状态迁移: 完成的"进行中"→"已完成"; 解决的"阻塞"标为已解决但保留仍需信息。
- 每轮更新"目标"与"下一步"以反映当前状态。

效果: 摘要是**单一滚动状态**, 不会随轮次堆叠重复内容。

## 6. 与 sessions.mjs 的协作

`SessionStore.maybeCompress(username, summarizeFn, opts?)` 流程:

```
estimateTokens(history)  ≤ budget → return false (不压)
history.length ≤ historyMax → return false
s.compressing = true                     // 重入保护
  select(history, budget) → { head, recent }
  keep = recent.length >= historyMax ? recent : history.slice(-historyMax)
  toCompress = history 前 (len - keep.len) 条
  newSummary = await summarizeFn(s.summary, toCompress)
  s.summary = newSummary.slice(0, summaryMaxLen)   // 硬截断
  s.history = keep
finally s.compressing = false
```

- `router` 在 `_ensureSummarizer` 处把 `summarizeFn` 绑成
  `(summary, batch) => summarizeWithLlm({ llm, previousSummary: summary, messages: batch })`。
- 主智能体回合与子智能体回合结束后各调一次 `maybeCompress`。
- 摘要通过 `_buildMainSystemPrompt` 以 `[之前的对话摘要]` 段落追加到系统提示词尾部。

## 7. 手动触发: `/大黄鱼 压缩`

`router.builtin.压缩` → `_forceCompress(from)`:
- 无历史 → `当前还没有可压缩的对话呢。`
- 否则把**全部** history (不分 head/recent) 交给 `summarizeWithLlm` 合并进现有摘要;
- 写回 `s.summary` (同样 `summaryMaxLen` 截断), `s.history = []` 清空;
- 回复里回显摘要本身与压缩条数, 便于用户核对是否漏了关键信息。

与自动压缩的差异: 手动是**全清**, 自动**保留最近预算内消息**。

## 8. 坑点

- **摘要长度是双刃剑**: 太短丢上下文 (URL/决定丢失, 后续回答跑偏), 太长吞掉本该给最近对话的预算。
  默认 400–800 字符是经验值; 调 `SUMMARY_MAX_LEN` 时同步看 `COMPACTION_TOKEN_BUDGET`。
- **截断在字符层面**: `slice(0, summaryMaxLen)` 可能切断最后一节 —— 所以模板要求要点短行。
- **`estimateTokens` 是估算**: 富 emoji / 代码块场景会低估, 预算留余量, 不要贴着模型上限设。
- **`summarizeFn` 用的是 `llm.chat`**(无工具), MOCK 模式下不触发 mock 工具调用 —— 自测时摘要是 mock 文本。
- **压缩期间的并发**: `compressing` 标记只防同会话重入; 跨用户由 `SessionStore.tryLock` 隔离。
- **摘要失败静默**: 返回旧摘要, 历史**不会**被裁剪 —— 下一轮会再试, 不会丢消息。
