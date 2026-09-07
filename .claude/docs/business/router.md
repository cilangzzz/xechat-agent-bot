# Router 业务文档

`Router` 是消息路由与命令分发的核心 —— 它把"一条以 `CMD_PREFIX` 开头的文本"安全护栏、内置命令、**意图分类**、子智能体委托、main agent 回合五档分流。@ 提及走独立的纯聊天通道, 接入**拟人触发器**做"AI 助手腔 vs 鱼塘老网友腔"切换。

- 源文件: [lib/business/router.mjs](../../../agent/lib/business/router.mjs)（793 行, 2026-08-28 大幅扩展）
- 配套: [tools.md](./tools.md)（工具注册表）, [multi-agent.md](./multi-agent.md)（多智能体定义）, [intent.md](./intent.md)（意图分类器）, [persona.md](./persona.md)（拟人触发器）, [subagent.mjs](#) / [aggressive.md](./aggressive.md)（子智能体/复读机）

## 1. `Router` 构造参数

```js
new Router({
  cfg,           // 配置（来自 loadConfig）
  sessions,      // SessionStore —— 每用户会话
  pondState,     // { onlineUsers, activeRooms, roomLog, ... }
  startTime,     // 进程启动时间戳（uptime 工具）
  api,           // XechatApi —— 鱼塘平台 HTTP 客户端
  memory,        // MemoryStore? —— 持久用户事实
  adoptments,    // Map —— 领养子进程表
  ws,            // WsClient —— 发-等响应指令用（如 create_room）
  scheduler,     // Scheduler? —— schedule 工具
  chatLog,       // ChatLog? —— chat_log 工具
  sendup,        // { upload } —— send_file 工具
  minimaxImage,  // MiniMax 图像生成器 (generate_image 工具)
  personaEngine, // 启动时 AI 生成的拟人 prompt 引擎
})
  .bindLlm(llm)  // 注入 LLM，启用主回合与子智能体委托通道
```

构造期会建立工具注册表 `tools = createRegistry({ ... })`，但 LLM 还未绑定 —— `bindLlm` 注入 LLM 后才启用 `tools.ctx.delegate`（子智能体委托）和 `_summarize`（结构化压缩）。

### 1.1 内部状态

| 字段 | 用途 |
|---|---|
| `personaEngine` | 启动时由 agent.mjs 注入, 用于 `_buildChatSystemPrompt` 取人设 prompt |
| `subagent` | `new SubagentDelegate(this)` —— 子智能体委托通道 (subagent.mjs) |
| `persona` | `createPersonaTrigger(...)` —— 拟人触发器 (persona.mjs), 控制 mention 的 formal/human 模式 |
| `tools` | `createRegistry({...})` —— 工具注册表, 见 [tools.md](./tools.md) |
| `_summarize` | 由 `bindLlm` 注入 `summarizeWithLlm`, 用于会话压缩 |
| `builtin` | 命令注册表 (`sub -> handler(arg, {from})`), 见 [§5](#5-命令清单builtin-表) |
| `_curUser`, `_lastThink` | handle() 上下文, 给 builtin handler 用 |

## 2. 五层路由判定（指令路径）

指令路径处理函数: `Router.handle({ from, text, isLive, onThinking })`

```
parseCommand(text, cfg.cmdPrefix) → { isCmd, sub, arg }
   ↓
[1] _blockReason(text)  → 命中大批量资源操作直接返回拒绝
   ↓
[2] this.builtin[sub]   → 确定性命令(zero LLM)
   ↓
[3] _classifyAndDispatch(sub, arg, from)  → 意图分类 + 派发 (2026-08-28 新增)
   ↓
[4] main agent 回合       → llm.agentTurn 带工具循环
```

### 2.1 第一层：安全护栏 `_blockReason`

命中"批量资源消耗"模式（大量截图 / 批量下载 / 占满磁盘 / 无限循环等）直接返回拒绝文案 —— 不进 LLM 不进工具。规则覆盖：个位 2-9、十位以上、任意数字+万/亿、一百/上万/几千、模糊量"大量/无数/海量"等。

### 2.2 第二层：确定性内置命令（**零 LLM 成本**）

`builtin` 是一个 `{ sub -> handler(arg, { from }) }` 表。`handle` 中先 `if (sub && this.builtin[sub])` 命中即返回字符串。

完整命令清单见 [第 5 节](#5-命令清单builtin-表)。

### 2.3 子智能体指令（仍走 builtin 的两条特例）

`explore` 和 `math` 是 builtin 表项，但内部走 `_runSubdirect`：

- `explore`: `_delegateSub({ agent: 'explore', ... })` —— 联网/平台调研，工具视图收敛到 `resolveToolNames('explore')`；
- `math`: 不走子代理，直接 `_safeMath(arg, from)` —— 表达式白名单 `^[0-9+\-*/.%\s()]+$` 防注入，再 `tools.dispatch('python', { code: print(<expr>) })` 取结果，**确定性 + 零 LLM**。

### 2.4 第三层：意图分类 (2026-08-28 新增)

```js
const intentResult = await this._classifyAndDispatch(sub, arg, from);
if (intentResult !== null && intentResult !== undefined) return String(intentResult);
```

仅作用于**带前缀但未命中 builtin** 的自由文本; 无前缀消息完全不受影响。分类器本体见 [intent.md](./intent.md)。

| Intent | 派发路径 | 备注 |
|---|---|---|
| `explore` | `subagent._runSubdirect('explore', ...)` | 联网/调研 |
| `math` | `_safeMath` (纯数字) 或 `subagent._runSubdirect('math', ...)` | 优先级: 数字白名单 → math 子智能体 |
| `room` | `_parseRoomIntent` → builtin.create-room/close-room/rooms | 自然语言 "开个五子棋房间" → 路由到 create-room |
| `query` | `_parseQueryIntent` → builtin.gold/online/stats/games/game | 自然语言 "今日金价" → gold |
| `builtin`/`chat`/`main`/未知 | 返回 null → 回落到 main agent | 兜底 |

详细 NLP 兜底规则见 [router-intent-dispatch.md](./router-intent-dispatch.md)。

### 2.5 第四层：main agent 回合（默认）

```js
const userText = (sub && !this.builtin[sub]) ? `${sub} ${arg}`.trim() : (arg || '');
const snap = this.sessions.pushUser(from, userText || text);
if (this._summarize) await this.sessions.maybeCompress(from, this._summarize);
const systemPrompt = this._buildMainSystemPrompt(snap.summary);
reply = await this.llm.agentTurn({ systemPrompt, history: snap.history, tools: this._agentView('main'), onThinking: think, from });
this.sessions.pushAssistant(from, reply);
```

- 把用户消息入库（`sessions.pushUser`），按需压缩；
- `_buildMainSystemPrompt` 拼装环境 + 工具清单 + 摘要前缀；
- `agentTurn` 驱动工具循环，工具视图按 `resolveToolNames('main')` 白名单。
- 异常兜底: `'这个我暂时答不上来，换个问题试试？'` (2026-08-28 新增 try/catch, 防止 LLM 抛错拖死整轮)

## 3. @ 提及处理 (含拟人触发器, 2026-08-28 重构)

详见 [router-mention-persona.md](./router-mention-persona.md)。要点:

- `extractMention(text, username)` —— 同时匹配完整登录名与领养人短名; 提取 @ 后正文
- `handleMention({from, text, isLive, onThinking, repeatCount})` —— 拟人化聊天, 决策权在 persona trigger
- `_buildChatSystemPrompt` —— human 分支 (拟人, 启动时 AI 生成的 prompt + 房间氛围 + 复读机升级模板) vs formal 分支 (助手, 工具视图空)
- **不调任何工具、不做平台查询** —— `chatView()` 返回空工具视图 `tools.filter([])`；
- **上下文键以 `chat:` 前缀**，与命令会话完全隔离 —— 命令的历史与摘要不会污染闲聊上下文，反之亦然；
- **`onThinking = () => {}`** —— @ 聊天**不发** "💭 好的" 等思考提示；
- **`mentionEnabled` 默认 `cfg.mention?.enabled`** —— 若关闭，`handleMention` 直接返回空串。
- **复读机协同**: `repeatCount >= 5` → 70% 概率直接装死; 与 [aggressive.md §8](./aggressive.md#8-harassment-tracker-api) 配合

底层机制: [persona.md](./persona.md) (拟人触发器)、[aggressive.md](./aggressive.md) (复读计数)。

## 4. 子智能体委派 `delegate`

### 4.1 显式调用（用户层）

```
/大黄鱼 explore <问题>     # 走 explore 子智能体
/大黄鱼 math <算式>        # 走 _safeMath(确定性,不调 LLM)
```

### 4.2 内部委托通道 `_delegateSub`

```js
async _delegateSub({ agent, task, from, depth = 1, status }) {
  const def = getAgent(agent);
  if (!def || def.mode !== 'subagent') return { error: `未知子智能体: ${agent}` };
  const view = this._agentView(agent);
  const systemPrompt = buildAgentSystemPrompt({ agent: def, cfg, pondState, sessions, toolList });
  return await this.llm.agentRun({ agentName, systemPrompt, task, tools: view, onThinking, from, depth, maxIterations });
}
```

- 子智能体使用**独立的系统提示词**（不含 main agent 的部分业务规则）、**独立的工具白名单**（`resolveToolNames(agent)`）、**独立的 LLM agent run**（`llm.agentRun` 而非 `agentTurn`）；
- `maxIterations` 受 `def.maxIterations || cfg.agents.subagentIterations`（默认 6）控制；
- 嵌套深度受 `SUBAGENT_DEPTH`（`cfg.agents.subagentDepth`，默认 1）限制—— 防止子智能体再 delegate 进入指数级深度的资源消耗。

### 4.3 main 内部 delegate

main agent 回合内的 `delegate` 工具通过 `tools.ctx.delegate = (opts) => this._delegateSub(opts)` 注入，本质复用同一 `_delegateSub` 通道。

## 5. 命令清单（builtin 表）

下表列出所有 builtin 命令、handler、是否走 LLM、对应工具 / 子智能体。

| 命令 (sub) | handler | LLM? | 工具/子智能体 | 说明 |
|---|---|---|---|---|
| `help` | `() => '可用指令:...'` | 否 | — | 列出 `tools.describe()` + 提示子智能体指令 + 拟人指令 (2026-08-28 补充) |
| `tools` | `() => tools.describe()` | 否 | — | 工具清单 |
| `agents` | `() => '子智能体: ...'` | 否 | — | 列出可用子智能体 |
| `persona` | `_personaCmd(arg, from)` | 部分 | `persona.mjs` | 测试/重置/生成 拟人 prompt (2026-08-28 新增) |
| `ping` | `() => 'pong 🎣'` | 否 | — | 存活探针 |
| `online` | `() => 在线用户列表` | 否 | — | 读 `pondState.onlineUsers` |
| `stats` | `() => 鱼塘现状 + 会话数` | 否 | — | 在线 / 会话数 / 待办概况 |
| `games` | `async () => tools.dispatch('games')` | 否 | `games` | 鱼塘游戏列表 |
| `game` | `async (arg) => tools.dispatch('game_detail', ...)` | 否 | `game_detail` | 单游戏详情 |
| `gold` | `() => tools.dispatch('gold_price')` | 否 | `gold_price` | 实时金价 |
| `explore` | `_runSubdirect('explore', ...)` | 是 | 子智能体 `explore` | 联网调研类（独立工具视图） |
| `math` | `_safeMath(arg)` | 否 | `python`（安全白名单） | 纯数字算式 |
| `todo` | `_todoCmd(arg, from)` | 否 | `todoHelpers`（lib/todo） | 显示/添加/完成/更新/删除/清空 |
| `skills` | `() => listSkills()` | 否 | `lib/business/skills` | 列出**内置**技能 (8 个, user_dir/user_url 见 [skill-system.md](./skill-system.md)) |
| `记忆` | `_memoryCmd(from)` | 否 | `MemoryStore` | 列出已记住的用户事实 |
| `压缩` | `_forceCompress(from)` | 是（一次性） | `summarizeWithLlm` | 强制压缩当前会话历史为摘要 |
| `定时` | `_schedCmd(arg, from)` | 否 | `Scheduler` | 新建定时任务（remind） |
| `定时列表` | `_schedListCmd()` | 否 | `Scheduler` | 列出未到期任务 |
| `定时取消` | `_schedCancelCmd(arg)` | 否 | `Scheduler` | 取消任务（按 id） |
| `最近消息` | `_recentMsgsCmd(arg)` | 否 | `pondState.roomLog`（内存环形） | 当前会话最近 N 条（live） |
| `聊天记录` | `_chatLogCmd(arg)` | 否 | `ChatLog`（持久 JSONL） | 跨重启可查的历史 |
| `领养` | `_adopt(from)` | 否 | `spawn` 子进程 | 拉起专属 `<人>的大黄鱼` 进程 |
| `clear` | `() => sessions.clear(user)` | 否 | — | 清空会话历史+待办 |
| `create-room` | `tools.dispatch('create_room', ...)` | 否 | `create_room` | 创建鱼塘游戏房间（解析 `<game> <nums> [mode]`） |
| `close-room` | `tools.dispatch('close_room', { roomId })` | 否 | `close_room` | 关闭房间（**无房主校验，见坑点**） |
| `rooms` | `tools.dispatch('list_rooms', ...)` | 否 | `list_rooms` | 列出活动房间（读 `activeRooms` 增量维护） |

未命中以上 sub 的输入会进入第 2.5 节的 main agent 回合 (注: 实际上**先**经过第 2.4 节意图分类, 分类到 explore/math/room/query 才分流)。

## 6. 房间操作的实现

- `create-room` → `create_room` 工具走 `ws.sendAction('CREATE_GAME_ROOM', ...)`（经 ws-client，不走 HTTP）；
- `close-room` → 同协议 `GAME_ROOM`（`body` 带 `msgType: 'ROOM_CLOSE'`）；
- `rooms` → 读 `pondState.activeRooms` 本地 map，仅靠订阅增量，不发请求。

## 7. 关键坑点

### 7.1 M-2: `close_room` 在协议层无房主 / 成员校验

当前 `close-room <roomId>` 命令只是将 `roomId` 透传给鱼塘协议 `GAME_ROOM`（`msgType: 'ROOM_CLOSE'`）。**任何用户都可输入 `/大黄鱼 close-room <任意id>`** 让机器人关掉别人的房间（如果协议不二次校验）。

**临时缓解**：在 `_adopt` 领养 / 专属模式下房间操作风险被多用户分担较小；正式方案需在 `close_room` 工具里加白名单（房主 / 玩家列表 / 黑名单），并与 `rooms` 工具回报的房主字段做交叉校验。

### 7.2 `rooms` 数据靠订阅增量维护

`activeRooms` 仅在 agent 在线期内累积: 启动后才能听到 `GAME_ROOM_CREATED`，断线期间发生的事件丢失。详见 [agent.md](./agent.md#41-状态维护)。

### 7.3 子智能体嵌套深度

`SUBAGENT_DEPTH` 默认 1 —— main agent 可以 delegate，**子智能体再 delegate 需要显式提高 depth**。生产环境默认配置可避免指数级任务爆炸。

### 7.4 房间参数解析中文别名

`_parseCreateRoomArgs` 把第一个空格分段作为 `<game> <nums> <mode...>`。中文游戏名（含空格 / 别名）必须使用者手敲别名（参数化解析可后续增强）。

### 7.5 `extractMention` 同时匹配长名 + 短名

`@老王的大黄鱼` 与 `@老王` 都被视为提及 —— 对领养实例要意识到**任何以 `<领养人>的大黄鱼` 登录的机器人，其短名也会触发 @ 聊天路径**。

### 7.6 `mentionEnabled` 的开关位置

`handleMention` 在关闭时返回空串 —— agent.mjs 仍会 `sendReply('', from)`（reply 工厂对空串直接 no-op），最终不会发消息，但若上下游对返回值有依赖，需自行判空。

## 8. 与其它模块的协作

- **SessionStore**: 每次命令/聊天都 `pushUser` → `maybeCompress` → `pushAssistant`，完整双向维护；
- **Tools**: `builtin` 表几乎所有非 trivial 命令都 `await this.tools.dispatch(name, args)`；
- **LLM**: `agentTurn`（回合）/ `agentRun`（子代理）/ `summarizeWithLlm`（压缩）三个入口都在 `_summarize` 与 `bindLlm` 阶段接通；
- **Scheduler / ChatLog / Memory / Sendup**: 通过 `deps.*` 注入 tools 注册表，再被 builtin 命令反射调用。
