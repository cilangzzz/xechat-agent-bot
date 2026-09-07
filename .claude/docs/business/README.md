# 业务模块总览

业务层是鱼塘 Agent Bot 的核心 —— **入口组装**、**指令路由**、**会话与并发管理**、**统一回复发送**。基础层（连接 / LLM / 工具底座）的细节见 [foundation/README.md](../foundation/README.md)，本文专注业务流程与模块协作。

## 1. 业务流程图

```
                            ┌────────────────────────────────────────┐
                            │  agent/agent.mjs  (入口 + 主循环)       │
                            │  · loadConfig + 组装依赖                │
                            │  · while(true) { client.runOnce() }    │
                            └────────────────────┬───────────────────┘
                                                 │
                          ┌──────────────────────┼──────────────────────┐
                          ▼                      ▼                      ▼
                 ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
                 │ client.onMessage│    │ client.sendAction│    │ scheduler.start │
                 │ (消息事件入口)    │    │ (统一回复出口)   │    │ (定时任务触发)   │
                 └────────┬────────┘    └────────┬────────┘    └────────┬────────┘
                          │                      ▲                      │
        ┌─────────────────┼──────────────────────┼──────────────────────┼──────────────┐
        ▼                 ▼                      │                      │              │
┌───────────────┐ ┌───────────────┐    ┌─────────┴─────────┐    ┌───────┴────────┐     │
│ 状态维护       │ │ 消息路由判定    │    │  makeReplySender  │    │  scheduler     │     │
│ USER_STATE    │ │ (前缀命中?     │    │ (200 字符分片)    │    │  (remind/auto) │     │
│ ONLINE_USERS  │ │  @ 提及?)      │    └───────────────────┘    └────────────────┘     │
│ GAME_ROOM_*   │ └───────┬───────┘                                                       │
└───────────────┘         │                                                                │
              ┌───────────┴────────────┐                                                   │
              ▼                        ▼                                                   │
   ┌────────────────────┐    ┌────────────────────┐                                         │
   │ Router.handle      │    │ Router.handleMention│                                        │
   │ (指令路径)          │    │ (@ 提及纯聊天)       │                                        │
   └─────────┬──────────┘    └─────────┬──────────┘                                         │
             │                         │                                                    │
   ┌─────────┼─────────────────────────┼──────────────┐                                     │
   ▼         ▼                         ▼              ▼                                     │
┌────────┐ ┌────────┐ ┌──────────┐ ┌──────────┐ ┌─────────┐                                 │
│ builtin│ │ 子智能体 │ │ main     │ │ chatView │ │ 安全护栏│                                 │
│ 命令   │ │ explore │ │ agent    │ │ (空工具) │ │ _block  │                                 │
│ (零LLM)│ │ / math  │ │ Turn     │ │          │ │ Reason  │                                 │
└────┬───┘ └────┬───┘ └────┬─────┘ └────┬─────┘ └─────────┘                                 │
     │          │          │            │                                                    │
     │          ▼          │            │                                                    │
     │   ┌──────────────┐  │            │                                                    │
     │   │ delegate     │  │            │                                                    │
     │   │ llm.agentRun │  │            │                                                    │
     │   └──────────────┘  │            │                                                    │
     │                     ▼            ▼                                                    │
     │            ┌───────────────────────────────┐                                          │
     │            │ SessionStore (per-user 会话)  │                                          │
     │            │  · history (队列, ≤ historyMax)│                                          │
     │            │  · summary (压缩产物)          │                                          │
     │            │  · tryLock (每用户并发锁)       │                                          │
     │            │  · maybeCompress (token 预算)  │                                          │
     │            └───────────────────────────────┘                                          │
     │                              │                                                       │
     │                              ▼                                                       │
     │                     ┌───────────────────┐                                             │
     └────────────────────►│ lib/llm.mjs       │◄────────────────────────────────────────────┘
                           │  · agentTurn      │            (触发器/定时器也走 LLM)
                           │  · agentRun       │
                           │  · summarizeWithLlm│
                           └───────────────────┘
```

### 消息生命周期（一句话）

`ws 收到 USER/CHAT` → `client.onMessage` 过滤自身与离线回放 → `Router.handle` / `handleMention` 判定命令或闲聊 → 可能调 LLM（main 子代理）或直接命中内置命令 → 输出文本走 `sendReply` → `makeReplySender` 按 200 字符分片 → `client.sendAction` 发出。

## 2. 模块清单（按职责分类）

### 2.1 入口与编排

| 模块 | 路径 | 职责 |
|---|---|---|
| **agent.mjs** | [agent/agent.mjs](../../../agent/agent.mjs) | 入口：CLI 参数解析 → 配置加载 → 依赖组装 → 消息分发 → 重连主循环 |

### 2.2 路由与会话

| 模块 | 路径 | 职责 |
|---|---|---|
| **Router** | [lib/business/router.mjs](../../../agent/lib/business/router.mjs) | 五层路由：内置命令 / **意图分类** (NEW) / 子智能体指令 / main agent 回合；@ 提及独立通道 + **拟人触发器** |
| **SessionStore** | [lib/business/sessions.mjs](../../../agent/lib/business/sessions.mjs) | per-user 会话：`history + summary + todos + tryLock`，token 预算压缩 |

### 2.3 输出与工具

| 模块 | 路径 | 职责 |
|---|---|---|
| **makeReplySender** | [lib/business/reply.mjs](../../../agent/lib/business/reply.mjs) | 200 字符硬上限 + markdown 友好分片 + 续段前缀 `↪` |
| 工具注册表 | [lib/business/tools/index.mjs](../../../agent/lib/business/tools/index.mjs) | 16 个模块的 `buildXxxTools` 聚合入口 |
| 多智能体定义 | [lib/business/agents.mjs](../../../agent/lib/business/agents.mjs) | main/explore/math/summarize 智能体描述与工具视图 |
| 子智能体委托 | [lib/business/subagent.mjs](../../../agent/lib/business/subagent.mjs) | SubagentDelegate: 显式调用 + 内部 delegate (NEW, 2026-08-27) |
| LLM 客户端 | [lib/foundation/llm.mjs](../../../agent/lib/foundation/llm.mjs) | `agentTurn`（回合带工具）/ `agentRun`（子智能体独立运行） |
| 系统提示词 | [lib/foundation/system.mjs](../../../agent/lib/foundation/system.mjs) | system prompt 拼装（环境 + 工具清单 + 行为约束） |
| 结构化压缩 | [lib/foundation/compaction.mjs](../../../agent/lib/foundation/compaction.mjs) | token 预算摘要生成（参考 opencode） |

### 2.4 拟人化 (NEW, 2026-08-28)

| 模块 | 路径 | 职责 |
|---|---|---|
| **Persona Trigger** | [lib/business/persona.mjs](../../../agent/lib/business/persona.mjs) | 拟人触发器 + 动态人设 prompt 引擎 + `humanizeReply` / `_addReplyPrefix` 后处理 |
| **意图分类器** | [lib/business/intent.mjs](../../../agent/lib/business/intent.mjs) | 7 类意图 (builtin/explore/math/room/query/chat/main) + LRU 缓存 |
| **Rage Mode** | [lib/business/aggressive.mjs](../../../agent/lib/business/aggressive.mjs) | 被 @ 后主动攻击模式 + 复读机计数 |

### 2.5 技能系统 (opencode 风格, NEW, 2026-08-28)

| 模块 | 路径 | 职责 |
|---|---|---|
| **skill-registry** | [lib/business/skill-registry.mjs](../../../agent/lib/business/skill-registry.mjs) | 多源合并: builtin + user_dir + user_url |
| **skill-fetcher** | [lib/business/skill-fetcher.mjs](../../../agent/lib/business/skill-fetcher.mjs) | 远程仓库协议 (index.json) + 文件抓取 |
| **skill-frontmatter** | [lib/business/skill-frontmatter.mjs](../../../agent/lib/business/skill-frontmatter.mjs) | SKILL.md frontmatter 解析 + 校验 |
| **skill-grep** | [lib/business/skill-grep.mjs](../../../agent/lib/business/skill-grep.mjs) | ripgrep 优先 + Node 回退, 16KB 输出截断 |

## 3. 关键设计

### 3.1 per-user `tryLock`（agent.mjs 入口)

不同用户可并行处理 —— 同一用户的连续消息只处理首条，后续直接跳过。这样：

- 房间内多个用户几乎同时 @ 机器人不会相互阻塞；
- 同一用户刷屏期间不会积压 N 轮 LLM 调用浪费 token；
- 全局辅以 `REPLY_COOLDOWN_MS`（默认 4s）防瞬时风暴。

并发锁实现在 [SessionStore.tryLock](./sessions.md)，由 agent.mjs 的 `busyUsers` 占位/释放。

### 3.2 200 字符分片（reply.mjs）

鱼塘服务端单条聊天 200 字符硬上限，所有对外文本（回答 / 💭思考 / 工具提示 / 主动广播）必须经 `makeReplySender`：

- 优先在 **行边界** 切（保住 markdown 结构）；
- 单行超长退到 **可读标点 / 空格** 边界；
- emoji 代理对按码点计，永不拆散；
- 续段前缀 `↪`、片间隔 `MSG_CHUNK_DELAY_MS` 默认 600ms。

### 3.3 在线状态增量维护（agent.mjs → pondState）

- `USER_STATE` 事件 → 单用户 ONLINE/OFFLINE 增删；
- `ONLINE_USERS` 全量快照（登录后一次）→ 重置 `Set`；
- `GAME_ROOM_CREATED` / `ROOM_CLOSE` → 维护 `activeRooms` Map。

数据仅在 agent 进程存活期内累积 —— 重启后从零重建。这是给 `rooms` 查询工具（list_rooms）的实时数据源。

### 3.4 房间订阅增量维护

鱼塘**服务端不会主动推全量房间列表**，只能靠监听两类事件增量：

```
GAME_ROOM_CREATED (全服广播) ──► pondState.activeRooms.set(id, ...)
ROOM_CLOSE         (msgType=ROOM_CLOSE) ──► pondState.activeRooms.delete(id)
```

受此约束：`/大黄鱼 rooms` 在新启动的几秒内可能返回"暂无"，随着增量事件逐渐丰盈。

### 3.5 五层路由策略 (router.mjs, 2026-08-28 扩)

1. **安全护栏**（零 LLM 成本先拦截大批量资源操作类请求）；
2. **确定性内置命令**（help/ping/games/gold/记忆/压缩/定时/...）：`builtin[sub]()` 查表执行；
3. **意图分类** (NEW): `_classifyAndDispatch` 对未命中 builtin 的自由文本分类到 explore/math/room/query, 详见 [intent.md](./intent.md) + [router-intent-dispatch.md](./router-intent-dispatch.md)；
4. **子智能体指令**（explore / math）：`_delegateSub()` 起独立 agent run；
5. **main agent 回合**（默认）：`llm.agentTurn` 带工具视图的循环。

@ 提及路径**不**走任何工具 / 命令 / 平台查询 —— 只调一个空工具视图的 LLM 纯聊天，且会话上下文以 `chat:<user>` 前缀独立，与命令上下文隔离。@ 提及由 **persona trigger** 决策 AI 助手腔 vs 鱼塘老网友腔, 详见 [persona.md](./persona.md) + [router-mention-persona.md](./router-mention-persona.md)。

### 3.6 上下文的"传输层"问题

鱼塘的 `toUsers` 私聊在协议层实际是广播给所有客户端（仅带目标标记），并非真私密。设计上：

- 持久记忆（memory）**默认关闭**，需管理员显式开 `ENABLE_MEMORY=1`；
- 即便广播，因机器人只定向单用户回复，旁观客户端通常不展示"指向他人"的消息。

## 4. 子文档

- [agent.md](./agent.md) — `agent.mjs` 入口、主循环、消息处理、触发器、定时回调、CLI 参数
- [router.md](./router.md) — 五层路由 / builtin 表 / @ 提及 / 子智能体委托 / 关键坑点
  - [router-intent-dispatch.md](./router-intent-dispatch.md) — 意图分类派发逻辑展开 (NEW)
  - [router-mention-persona.md](./router-mention-persona.md) — @ 提及与拟人触发器展开 (NEW)
- [sessions.md](./sessions.md) — SessionStore 数据结构 / tryLock / token 预算压缩 / 上下文隔离
- [reply.md](./reply.md) — makeReplySender 工厂 / 分片策略 / 续段前缀 / 定向 vs 广播
- [tools.md](./tools.md) — 工具注册表: 16 模块聚合入口 / 全量工具分类清单 / budget / 新增工具 checklist
- [multi-agent.md](./multi-agent.md) — 多智能体定义 / delegate 工具 / 显式指令 / 新增子智能体 checklist
- [skills.md](./skills.md) — 内置技能 SKILLS 表 / 加载流程 / 新增技能 checklist
- [skill-system.md](./skill-system.md) — opencode 风格 skill 系统: 多源合并 + 远程仓库 + ripgrep (NEW)
  - [skill-system-detail.md](./skill-system-detail.md) — SkillRegistry + grep 工具后端详解
  - [skill-system-pitfalls.md](./skill-system-pitfalls.md) — 集成示例 + 11 个坑点
- [intent.md](./intent.md) — 意图分类器: 7 类 + LRU + 兜底 (NEW)
- [persona.md](./persona.md) — 拟人触发器: 评分 + 引擎 + 后处理 (NEW)
  - [persona-engine.md](./persona-engine.md) — 人设 prompt 引擎 (createPersonaEngine + BASE_PERSONA_PROMPT)
  - [persona-scoring.md](./persona-scoring.md) — 评分模式参考 (NEW)
  - [persona-callflow.md](./persona-callflow.md) — 完整调用链 (NEW)
  - [persona-pitfalls.md](./persona-pitfalls.md) — 11 个坑点 (NEW)
- [aggressive.md](./aggressive.md) — Rage Mode + 复读机计数 (NEW)
- [peripheral.md](./peripheral.md) — 周边工具: todo / memory / scheduler / chat-log / trigger / **lib/platform/** 重组
- [data-model.md](./data-model.md) — 业务层核心数据结构速查 (Session / pondState / 工具消息 / WS 帧)
- [pitfalls.md](./pitfalls.md) — 坑点清单 (协议 M-* / 行为 B-* / 数据 D-* / LLM L-* / 测试 T-*)
