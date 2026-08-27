# lib/system.mjs — 系统提示词组合

> 源码: [agent/lib/system.mjs](../../../agent/lib/system.mjs) (48 行)
> 上游调用: [agent/lib/agents.mjs](../../../agent/lib/agents.mjs) `buildAgentSystemPrompt` · [agent/lib/router.mjs](../../../agent/lib/router.mjs)

## 1. 三段组合

```
buildSystemPrompt({ agent, env, toolList, cfg })
  = <env> 环境块          ← buildEnvironment()  动态
  + 人设 (per-agent)       ← talk(agent, cfg)
  + 可用工具清单           ← toolList.join('\n')
  + 全局行为/输出/安全约束  ← 模块内固定常量段
```

## 2. 环境块 (buildEnvironment)

`{ cfg, pondState, sessions, agentName }` → 首行身份 + `<env>` 块:

- 首行: `你正运行在鱼塘(Xechat)聊天室, 登录名「<cfg.username>」。`
- `今天的日期`: `toLocaleDateString('zh-CN')` (北京时间) —— 每次组装重算
- `运行平台`: `process.platform`
- `房间当前在线`: `pondState.onlineUsers.size`
- `正在对话的会话数`: `sessions.size`
- `指令前缀`: `cfg.cmdPrefix` (默认 `/大黄鱼`, 领养实例为 `/<领养人>的大黄鱼`)

全部动态 —— 在线人数/会话数每回合都可能变, 所以不能缓存整份提示词。

## 3. 人设 (talk)

`agent` 定义来自 `lib/agents.mjs`, 组成三行:

- `base`: `你是鱼塘里被 "<prefix>" 召唤的 AI 助手「<species>」的<agent.role>`
  - `species` = `cfg.username`, `prefix` 优先取**当前实际** `cfg.cmdPrefix`(领养实例正确)
- `你的专长: <agent.expert>`
- `<agent.extra>` —— 各智能体的行为范式细则

各 agent 定位:

| agent | role | 定位 |
|---|---|---|
| `main` | 本尊 | 全量工具, 多步调研范式 (search→fetch→python→总结)、todo 跟进、send_file 触发规则 |
| `explore` | 调研专家分身 | 搜索/抓取 + 平台数据查询, 供 delegate 调研 |
| `math` | 计算专家分身 | 把需求写成 python 执行, 输出确定数字/表格 |
| `summarize` | 会话压缩器 | 内部用, 工具为空; 提示词即结构化摘要要求 (被 compaction 复用) |

## 4. 工具清单

- 由 `ToolRegistry.describe()` 渲染: 每行 `- <id>: <description>`。
- `router._agentView(name).describe().split('\n')` 作为 `toolList` 传入 —— 即**按 agent 白名单过滤后**的视图。
- 白名单来自 `resolveToolNames(agentName)`: `'all'` → `null`(不过滤), 否则数组。
- 参数 schema **不进文本清单**, 只通过 `openAiSchemas()` 走函数调用协议 (`parameters` 字段), 省 token 且避免模型照抄成文本。
- 空清单渲染为 `(无)` (如 `summarize`、`@提及` 闲聊模式)。

## 5. 固定约束段 (buildSystemPrompt 尾部)

- **回答风格**: 自然简洁中文, 通常 100 字内, 复杂任务分步。
- **工具调用纪律**: 必须走函数调用机制; 禁止输出 `<tool_calls>`/`<invoke>`/`{"name":...}` 文本形式
  (兜底恢复见 [tool-call-parse.md](tool-call-parse.md))。
- **输出格式**: 单条 200 字上限, 自动按行分片 → 要求**短行/短段落**, 每要点 1–2 行。
- **隐私**: 聊天室消息实际广播给所有人, 不回显密码/密钥/手机号。
- **安全护栏**: 拒绝批量资源消耗型操作 (海量截图/下载/文件、无限循环、占满磁盘内存)。
- **系统隔离**: 禁执行系统命令、禁泄露服务器信息 (主机名/IP/环境变量/磁盘/CPU), 用户要求也不执行。

## 6. 注入机制

- **每次 `agentTurn` 前重新组装**: `router` 调 `_buildMainSystemPrompt(summary)` → `buildAgentSystemPrompt(...)`。
- 组装结果作为 `runLoop` 的 `msgs[0]` (`role: 'system'`), 每轮工具循环内不再变更。
- 会话摘要以尾部段落追加: `\n\n[之前的对话摘要]\n<summary>` (见 [compaction.md](compaction.md))。
- 迭代超限时 `runLoop` 会**追加**第二条 system 收尾指令, 而不是重写第一条。
- `@提及` 闲聊模式用 `{ ...def, extra: '只闲聊与答疑, 不调用工具...' }` + `toolList: []` 重组, 复用同一函数。

## 7. 与多智能体的关系

- 每个 agent = 独立提示词 (role/expert/extra) + 独立工具白名单; 两者都由 `agents.mjs` 集中定义。
- 子智能体走 `llm.agentRun`, 系统提示词同样经 `buildAgentSystemPrompt` 生成, 只是 `toolList` 更窄。
- 详见 [business/multi-agent.md](../business/multi-agent.md)。

## 8. 设计原则

- **短行短段**: 每要点 1–2 行 —— 200 字符分片后每片仍是完整 markdown 行, 不会从中间切断。
- **动态优先**: 身份名/前缀/日期/在线数一律运行时注入, 不写死"大黄鱼", 领养实例才能自称正确。
- **约束显式**: 安全与格式规则写进提示词而非只靠代码拦截, 双层防护 (提示词劝退 + 工具层硬拦)。
- **零缓存**: 组装成本极低 (纯字符串拼接), 换取每回合状态准确。
