# 基础层模块概览 (Foundation)

基础层是 agent 的"网络/协议/配置"底座, 位于业务路由与会话层之下, 几乎不依赖业务模块。

## 1. 模块清单

| 模块 | 一句话职责 | 主要依赖 |
|---|---|---|
| [`config.mjs`](../../../agent/config.mjs) | 从 `.env` / `process.env` 聚合所有运行配置, 无硬编码密钥 | Node `fs` / `path` |
| [`lib/ws-client.mjs`](../../../agent/lib/ws-client.mjs) | 手写 WebSocket 帧编解码 + 连接/登录/心跳/僵死看门狗 + 请求-响应原语 | Node `net` / `crypto` |
| `lib/llm.mjs` | DeepSeek (OpenAI 兼容) 客户端 + `agentTurn` / `agentRun` 回合 | config, sessions |
| `lib/tool-core.mjs` | `defineTool` 工具定义框架 (schema + 执行 + 错误包装) | 无 |
| `lib/tool-call-parse.mjs` | 从泄漏的 `<tool_use>` 文本里恢复工具调用 | tool-core |
| `lib/compaction.mjs` | token 预算 + 结构化摘要 (旧消息压缩) | llm |
| `lib/system.mjs` | 系统提示词拼接 (角色 + 工具 + 上下文) | config |

> 本目录详细文档:
> - [config.md](./config.md) — 配置加载与所有 `.env` 变量
> - [ws-client.md](./ws-client.md) — WS 协议、状态机、`sendActionAndWait` 原语
> - [llm.md](./llm.md) — DeepSeek 客户端与 agent 工具循环
> - [tool-core.md](./tool-core.md) — `defineTool` 工具定义框架
> - [tool-call-parse.md](./tool-call-parse.md) — 泄漏工具调用文本恢复
> - [compaction.md](./compaction.md) — 结构化上下文压缩
> - [system.md](./system.md) — 系统提示词组合

## 2. 关键设计原则

### 2.1 `ws-client` 的请求-响应原语 `sendActionAndWait`

整个 agent 收发都靠这一个原语。鱼塘 WS 是**纯异步消息流**, 没有内置 RPC。
- 工具发起 `GAME_ROOM` 等需要响应的请求时, 调用 `sendActionAndWait(action, body, {match, timeoutMs})`
- 内部维护 `_waiters` 队列, 每条收到的消息按 `match` 函数逐个尝试匹配
- 第一个 `match(msg, type, body) === true` 的 waiter 消费该消息并 resolve
- 默认 8s 超时, 拒绝时返回 `{error: 'timeout', lastSeen}`
- **聊天消息不走这里**——只用于工具/查询类请求

详见 [ws-client.md §3](./ws-client.md#3-核心原语-sendactionandwait)。

### 2.2 `config` 的环境变量覆盖

零硬编码: 所有配置来自 `process.env`, `.env` 仅作"首次启动的种子"。
- 启动顺序: `loadDotEnv()` 注入缺失变量 → `loadConfig(env)` 聚合成单一对象 → 全应用 `import` 一次
- **dotenv 不覆盖**: `if (process.env[k] === undefined) process.env[k] = v;` —— shell 已 export 的同名变量永远优先
- bool 解析规则: `'1' / 'true' / 'yes'` → true, 其他全部 false (注意: 空串、'0'、'no' 都是 false)
- 整型解析: `int(v, dft)` 用 `parseInt(_, 10)`, 空串/缺失走默认值, 非数字 → `NaN` (调用方需注意)

详见 [config.md §3](./config.md#3-关键陷阱)。

### 2.3 其他基础约定

- **零外部依赖**: 仅用 Node 内置 `net` / `crypto` / `fs` / `path` —— 不引入 `ws` 包, 手写 RFC6455 帧编解码
- **HTTP CONNECT 代理**: 走代理时先与代理服务器建 TCP, 发 `CONNECT host:port HTTP/1.1`, 收到 `200` 后再发 WS 握手
- **僵死看门狗**: 90s 内未收到任何数据 (含心跳/帧) → 主动重连, 避免静默死连接
- **登录重连分流**: `login-rejected` (黑名单) 30s 后重试, 普通断线 3s 后重试

## 3. 跨模块引用

```
                      ┌─────────────────────┐
                      │    config.mjs       │
                      │  loadDotEnv()       │
                      │  loadConfig()       │
                      └──────────┬──────────┘
                                 │ cfg 对象
                                 ▼
        ┌────────────────────────────────────────────────┐
        │            lib/ws-client.mjs                    │
        │  WsClient.runOnce()                             │
        │   ├─ net.connect(direct ? host : proxy)         │
        │   ├─ HTTP CONNECT 代理隧道 (可选)                │
        │   ├─ WS 握手 (Sec-WebSocket-Key)                │
        │   ├─ LOGIN (uuid/username/status)               │
        │   ├─ HEARTBEAT 心跳 (heartbeatMs)               │
        │   ├─ 僵死看门狗 (staleTimeoutMs)                 │
        │   └─ sendActionAndWait(action, body, {match})   │
        └────────────────────┬───────────────────────────┘
                             │ msg 流入
                             ▼
                   业务层 (router / sessions / tools)
```

调用关系:
- `agent.mjs` → `loadDotEnv()` + `loadConfig()` 拿到 cfg → `new WsClient(cfg)`
- `WsClient.runOnce()` 返回退出原因 → `agent.mjs` 决定重连间隔 (`reconnect.loginRejectedMs` / `reconnect.normalMs`)
- `WsClient.onMessage(msg, {live})` 把所有消息灌入业务层 router
- 工具模块需要"等响应"时 → `ws.sendActionAndWait('GAME_ROOM', {...}, {match: m => m.body?.id === reqId})`