# 测试说明 (agent/test)

> 鱼塘 agent 智能体的测试层 —— 零测试框架, 自写脚本 + Node 内置 `assert`, 全部离线可跑。

## 1. 测试策略

- **无 Jest/Mocha**: 不用任何测试框架与外部依赖, 每个测试文件是可直接执行的 `.mjs` 脚本, 用 `node:assert` (或自写 `check`/`assert` 辅助) 断言, 失败 `process.exit(1)`。
- **离线优先**: 单元测试用 fake `fetch` / fake WS 完全脱离网络; 端到端测试用本地 `mock-server.mjs` 模拟鱼塘服务端, 不产生任何外网流量。
- **真实环境仅冒烟**: `verify-*.mjs` 连真实鱼塘 (`lesscoding.net:33859`) 做人工冒烟验证, **不进入 `npm test`**, 不要求通过。
- 测试脚本全部位于 `agent/test/` 下, 从 `agent/` 目录运行。

## 2. 三层测试

### 2.1 单元测试 — `test/unit-agent.mjs` (849 行)

不连网络的模块级测试, 覆盖:

| 编号 | 范围 |
|---|---|
| [1] | `parseCommand` 前缀/子命令/参数解析 |
| [2] | `ToolRegistry` 注册/派发/参数校验/schema/白名单过滤 |
| [2b] | 技能包 `skill` 工具与 `skills.mjs` 模块 |
| [2c] | 待办 `todo` 工具 + `todo.mjs` 助手 (用户隔离) |
| [2d] | 持久记忆 `remember`/`recall` (落盘重载) |
| [2e] | `compaction` 结构化压缩 (token 估算/切分/摘要模板) |
| [3] | `llm.agentTurn` 工具调用循环 (fake fetch 返回 tool_calls) |
| [3b] | `llm.agentRun` 子智能体回合 (独立历史/工具白名单) |
| [3c] | 泄漏工具调用文本恢复/剥除 (`tool-call-parse`) |
| [3d] | agentTurn 泄漏恢复端到端 |
| [3e] | 多步思维链 (Reflect 注入) + Doom-loop 死循环守护 |
| [4] | `Router` 确定性命令 / LLM 兜底 / 多智能体指令 |
| [4b] | 游戏房间 `create_room`/`close_room` (fake WS 回包/超时/未注入) |
| [4c] | `list_rooms` 活动房间查询 (订阅式, 关闭后计数-1) |
| [5] | `SessionStore` 多用户隔离 / token 预算压缩 / tryLock |
| [6] | `python` 工具 (真实执行, 本地计算 + 超时终止) |
| [7] | `makeReplySender` 统一发送/分片 + markdown 友好分片 |
| [8] | `Scheduler` 定时任务 + `parseDuration`/`parseAtTime` |
| [8b] | `createTrigger` 主动消息触发器 (每 N 条/冷却/关闭) |
| [8c] | 定时/聊天记录工具与命令 (`schedule`/`chat_log`/`recent_messages`) |
| [8d] | 文件分享 sendup.cc (mime 推断/预检/参数透传/失败兜底) |

**fake 手段**: `globalThis.fetch` 模拟 DeepSeek 返回 `tool_calls`; 手写 `fakeWs` 对象模拟协议回包 (含 `sendActionAndWait` 等待器与 `_feed` 喂包); `fakeApiFetch` 模拟 Xechat 平台 API。

### 2.2 端到端测试 — `test/run-e2e.mjs` (262 行)

完整链路离线自测: 起 mock 鱼塘 → 以 `MOCK_LLM=1` 拉起 agent 子进程 → 验证连接→WS 握手→LOGIN→收到指令→CHAT 回复。场景:

> 注: 下方场景以生产默认前缀 `/大黄鱼` 描述; 实际 `run-e2e.mjs` 内部硬编码测试前缀 `/小黄鱼`(固定不随 `.env` 漂移), 二者语义相同。

- **A**: `/大黄鱼 ping` 确定性命令直接回复, 无思考占位
- **B**: LLM 自由文本 + `MOCK_TOOLCALL` 触发 `room_stats` 工具, 工具执行不泄漏提示
- **C/J**: 无前缀普通消息不触发回复
- **D**: 心跳帧字节级校验 `{"action":"HEARTBEAT"}`
- **E**: 超长回复分片 (≥3 片, 每片 ≤200 字符, 拼接还原)
- **F**: `/大黄鱼 math 6*7` → `= 42` (确定性 python 计算, math 子智能体)
- **G**: `/大黄鱼 explore 今天天气` 委派 explore 子智能体
- **H**: todo 流程 `添加 买菜` → `显示` (含待办)
- **I**: `@e2e_agent` 提及 → 纯聊天, 不触发命令/工具/思考提示
- **K**: 多步调研范式注入 (main.extra 含 web_search→fetch_url→python 链路)
- **L**: 定时任务 `定时 1秒 提醒我喝水` → 到点 `🔔 [定时]` 触发
- **M**: 聊天记录日志持久化 (`e2e-chat-log.jsonl`) + `聊天记录 3`/`最近消息 10`
- **N**: 独立 agent 实例 (触发器) 每 2 条消息主动广播

测试通过输出 `E2E PASS`, 否则 `E2E FAIL` 并 `exit(1)`。

### 2.3 Mock 服务端 — `test/mock-server.mjs` (144 行)

用原生 `net` 实现的最简 WebSocket 服务端, 模拟 Xechat 协议:

- 服务端帧不带掩码 (`encodeServerText`), 客户端帧带掩码 (`decodeMaskedFrame`)
- 流程: WS 握手 (Sec-WebSocket-Accept) → `LOGIN` → 回 `SYSTEM` 欢迎 + `USER_STATE` 上线 + `ONLINE_USERS` 快照
- 记录 `CHAT` 作为回复 (`replies`)、`HEARTBEAT` (`heartbeats`)、回调 `onLogin`/`onReply`/`onLog`
- 导出 `MockPondServer` 供 `run-e2e.mjs` 使用, 测试用例内可 `sendChat(from, text)` 喂消息

### 2.4 真实环境验证 — `verify-*.mjs`

人工冒烟脚本, 直连真实鱼塘 (`lesscoding.net:33859`), **不进 `npm test`**:

| 脚本 | 用途 |
|---|---|
| `verify-close-room.mjs` | **M-2 复现**: 攻击者用 close-room 越权关闭受害者房间, 验证"已关闭"且房间已不存在 |
| `verify-list-rooms.mjs` | **订阅式房间计数**: 监听 `GAME_ROOM_CREATED`/`ROOM_CLOSE` 全服广播维护 `activeRooms`, 自建 3 房关 2 房, 打印 `list_rooms` 与 `/x rooms` 渲染 |

```bash
node test/verify-close-room.mjs [host] [port]      # 默认 lesscoding.net:33859
node test/verify-list-rooms.mjs [host] [port] [dur] # dur 默认 20s 监听
```

## 3. 运行命令

```bash
cd agent
npm test                  # 单元 + 端到端 (全部离线)
npm run test:unit         # 只跑单元: node test/unit-agent.mjs
npm run test:e2e          # 只跑端到端: node test/run-e2e.mjs
```

`package.json` 中 `test` = `unit-agent.mjs && run-e2e.mjs`, 任一失败即非零退出。

## 4. 离线自测 (不跑测试也能验证)

```bash
cd agent
MOCK_LLM=1 PROXY_PORT=0 node agent.mjs
```

`MOCK_LLM=1` 时 LLM 返回 mock 回复 (含 mock tool_calls), `PROXY_PORT=0` 走直连; 配合 `.env` 连真实鱼塘即可在聊天室手动验证, 不消耗真实 LLM 调用。

## 5. 测试覆盖矩阵

| 模块 | 单元 | e2e | 真实环境 |
|---|---|---|---|
| ws-client | ✅ | ✅ | - |
| llm | mock | mock | - |
| tools | ✅ | 部分 | 部分 |
| sessions | ✅ | ✅ | - |
| compaction | ✅ | - | - |
| router | 部分 | ✅ | - |
| create_room | - | - | ✅ |
| list_rooms | - | - | ✅ |

说明: `llm` 在单元/e2e 中均为 mock (fake fetch / MOCK_LLM); `create_room`/`list_rooms` 依赖真实服务端广播与订阅, 仅在 `verify-*.mjs` 中冒烟。

## 6. 测试数据

| 文件 | 说明 |
|---|---|
| `agent/test/e2e-chat-log.jsonl` | e2e 场景 M 的聊天日志样本 (测试产物) |
| `agent/data/chat-log.jsonl` | 运行时聊天日志持久化文件 (已 gitignore, 不入库) |
