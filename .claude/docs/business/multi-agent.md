# multi-agent — 多智能体层

> 路径: `agent/lib/agents.mjs` (76 行)
> 参考: opencode agent/agent.ts

每个 agent 有独立的工具白名单、提示词段落与 `maxIterations`。`main` 可通过 `delegate` 工具把任务委派给子智能体, 子智能体只持有受限工具集, 防止越权/简化提示词。

---

## 1. 设计原则

- **专精分工**: main = 全量通用; explore = 调研; math = 计算; summarize = 压缩 (内部)
- **白名单约束**: 子智能体只能调用其 `tools` 数组列出的工具 (`'all'` 表示不过滤)
- **嵌套深度**: 由 `ctx.subagentDepth` 控制 (默认 1), 防止无限递归
- **隐藏代理**: `hidden: true` 的智能体不对外暴露 (`summarize`)

---

## 2. AGENTS 表

| Agent | 类型 | 工具白名单 | 定位 | 嵌套上限 |
|---|---|---|---|---|
| `main` | primary | `all` (全量) | 默认入口, 鱼塘万能助手 | `SUBAGENT_DEPTH` (默认 1, 由 ctx 注入) |
| `explore` | subagent | `web_search / fetch_url / gold_price / games / game_detail / leaderboard / room_stats / now` | 调研专家 (类 opencode explore) | 受 `subagentDepth` |
| `math` | subagent | `python / now` | 计算专家 (只算不算别的) | 受 `subagentDepth` |
| `summarize` | subagent (hidden) | `[]` (空) | 会话压缩 (由 compaction 复用) | 不开放 |

### 字段说明 (每条 AGENT)

- `name` — 智能体 ID
- `description` — 一句话描述 (供 LLM 知道何时用)
- `mode` — `primary` (主) / `subagent` (子)
- `hidden` — true 时 router 不响应 `/大黄鱼 <name>` 指令
- `role` — 人格定位 ("本尊" / "调研专家分身" / ...)
- `expert` — 能力清单 (短句)
- `extra` — 工作流提示 (调研范式 / 多步思维链)
- `tools` — `'all'` 或字符串数组
- `maxIterations` — 单轮最大工具步数 (main=8, 子=6, summarize=1)

### `SUBAGENT_NAMES`

```js
export const SUBAGENT_NAMES = ['explore', 'math'];
```

`router.mjs` 据此识别合法 `/大黄鱼 <name>` 显式指令; `summarize` 不在列, 仅内部调用。

### 工具解析

```js
export function resolveToolNames(agentName) {
  const a = AGENTS[agentName];
  if (!a) return [];
  return a.tools === 'all' ? null : a.tools;  // null = 不过滤
}
```

LLM 收到工具列表前, `router` 调用此函数把白名单外的工具过滤掉。

### 提示词组装

```js
export function buildAgentSystemPrompt({ agent, cfg, pondState, sessions, toolList })
```

按 `agent.def` 的 `role` / `expert` / `extra` + `cfg.cmdPrefix` (每条鱼各自的前缀) + 当前环境 (`buildEnvironment`) + 工具列表组装。

---

## 3. delegate 工具实现

```js
reg.register(defineTool({
  id: 'delegate',
  parameters: {
    agent: { enum: ['explore', 'math'] },
    task:  { type: 'string' },
  },
  run: async ({ agent, task }, extra) => {
    const depth = extra.depth ?? 0;
    if (depth >= (ctx.subagentDepth ?? 1))
      return { error: `嵌套已达上限` };
    if (ctx.status) ctx.status(`把任务交给子智能体「${agent}」…`);
    const out = await ctx.delegate({ agent, task, from: extra.from, depth: depth + 1, status: extra.status });
    if (out.error) return { error: `...` };
    return `<task state="completed">\n${out.result || '(无输出)'}\n</task>`;
  },
}));
```

要点:

- **深度闸**: `depth + 1` 后传给 `ctx.delegate`, 子智能体再调 delegate 时 depth=1, 触发上限拒绝
- **状态回调**: `ctx.status(msg)` 让 UI 提示用户"交给子智能体中"
- **来源透传**: `extra.from` 透传给子智能体的会话归属 (todo / memory 用)
- **失败包装**: 子智能体失败时返回 `{error}`, LLM 据此决定重试 / 换工具 / 直接答

### 子智能体返回值

成功 → 包裹成:

```xml
<task state="completed">
子智能体的最终回复 (字符串)
</task>
```

LLM 把这串作为 `<task_result>` 继续对话。失败 → 直接 `{error}` 对象, 不带 task 包装。

---

## 4. 显式指令

用户在聊天里直接调用:

```
/大黄鱼 explore <问题>      → 委派 explore, 跑完返回结论
/大黄鱼 math   <算式>       → 委派 math, 跑 python 返回结果
```

**禁止用法**: `/大黄鱼 summarize ...` (隐藏) / `/大黄鱼 main ...` (自己委派自己没意义) / 未知 agent 名。

显式 vs 隐式的区别:
- **显式**: 用户说 `/大黄鱼 explore ...` → router 直接派给 explore
- **隐式**: main 在 LLM 决策下调用 `delegate({agent: 'explore', task})` 工具

---

## 5. 多步思维链

子智能体不能只调一次工具就答复。`agents.mjs` 用三层机制约束:

### 5.1 系统提示词明令

main 与 explore 的 `extra` 字段都写了:

> **多步调研范式**: web_search → 从结果挑 top 2-3 个 URL fetch_url → 数据/排行类用 python 处理/聚合 → 总结。
> 拿到搜索结果的 snippet 不算"完成调研", 关键 URL 必须抓详情。

这是"提示词层"的硬约束, 让 LLM 知道完成标准。

### 5.2 Reflect 注入

每次工具结果回填后, `router` 在消息流里追加一段 Reflect 评估提示 (由 `lib/llm.mjs` / `router.mjs` 注入, 不在 `agents.mjs` 内):

> 根据本次工具结果, 任务是否完成? 若未完成, 还需做什么?

LLM 据此决定继续调工具还是收尾。

### 5.3 Doom-loop 守护

`router.mjs` 维护最近 N 步的 (工具名, 参数哈希) 滑动窗口; **同名同参连续 3 次相同** → 强制停止 (返回最后结果 + 提示"循环, 已终止")。

防止 LLM 陷入"再调一次说不定就对了"的死循环。

---

## 6. todowrite 升级

`main` / `explore` 的提示词都强调 `todo_update`:

- 任务 ≥ 3 个独立步骤 → 先写 todo 再动手
- 动手前把当前步骤 `in_progress`, 完成立刻 `completed` (**不批量**)
- 阻塞 → 保持 in_progress + 加 follow-up
- `maxIterations` 内: 持续多步调用 ≥ 2 个不同类型工具 才算"已调研"

`todo_update` 工具描述里也写了同样规则, 双层提示确保 LLM 落地。

---

## 7. 新增子智能体 checklist

1. `agents.mjs` 的 `AGENTS` 加一条定义
2. 若需用户显式调用, 加入 `SUBAGENT_NAMES` 数组
3. `tools.mjs` 的 `delegate` 参数 `enum` 同步添加
4. `maxIterations` 评估: 主=8, 子=6, summarize=1
5. `extra` 字段写清楚工作流 (多步范式 / Reflect 配合)
7. `agent/test/` 加子智能体委派用例 (mock LLM)