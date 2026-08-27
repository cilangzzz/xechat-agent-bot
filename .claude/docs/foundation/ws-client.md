# lib/ws-client.mjs — WebSocket 连接层

[`agent/lib/ws-client.mjs`](../../../agent/lib/ws-client.mjs) 把原 `/大黄鱼` bot 的协议核心 (`listen_reply.mjs`) 抽出, 封装为可复用的 `WsClient` 类。

## 1. 设计目标

- 零外部依赖: 仅 `net` + `crypto`, 手写 RFC6455 帧
- 支持 HTTP CONNECT 代理 / 直连两种通道
- 一次 `runOnce()` = 一次完整连接生命周期, 返回退出原因; 外层决定重连策略
- 提供 `sendActionAndWait` 请求-响应原语

## 2. 连接模型与状态机

```
runOnce() ─► connect
              │
              ▼
        ┌─────────────┐
        │ TCP 已建立   │  (sock.on('connect'))
        └──────┬──────┘
               │ direct=true?
        ┌──────┴──────┐
        │ yes         │ no
        ▼             ▼
   (跳过隧道)   CONNECT host:port HTTP/1.1
                       │
                       ▼ 收到 200
                ┌─────────────┐
                │ 已隧道        │
                └──────┬──────┘
                       │
                       ▼ 发送 WS 握手
                ┌─────────────┐
                │ 收到 101     │
                └──────┬──────┘
                       │
                       ▼ 立即发 LOGIN
                ┌─────────────┐
                │ 已登录        │ (USER_STATE.ONLINE 触发 onLogin)
                └──────┬──────┘
                       │
                       ▼ 心跳 (heartbeatMs) + 僵死看门狗 (staleTimeoutMs)
                ┌─────────────┐
                │ 监听消息      │ ──► 退出原因:
                └─────────────┘    'closed' / 'sock-error' /
                                   'handshake-fail' / 'connect-fail' /
                                   'login-rejected' / 'server-close' /
                                   'stale' / 'stopped' / 'connect-error'
```

外层 (`agent.mjs`) 根据退出原因选择重连间隔:

| 退出原因 | 重连等待 | 含义 |
|---|---|---|
| `login-rejected` | `RECONNECT_REJECTED_MS` (默认 30s) | 服务端黑名单/拒绝, 立刻重试会被持续拒绝 |
| 其他 (`closed` / `sock-error` / `stale` / ...) | `RECONNECT_NORMAL_MS` (默认 3s) | 正常网络抖动 |

## 3. 核心原语 `sendActionAndWait`

**整个 agent 收发消息都靠这个** —— 鱼塘 WS 是纯异步消息流, 没有内置 RPC。

### 3.1 签名

```js
ws.sendActionAndWait(action, body, { match, timeoutMs = 8000 }) => Promise<{ msg, type }>
```

- `action: string` — 要发送的 action 名 (`'GAME_ROOM'` / `'API_QUERY'` / ...)
- `body: object` — 请求体
- `match: (msg, type, body) => boolean` — 命中函数, 返回 true 即消费该消息
- `timeoutMs: number` — 超时, 默认 8s

### 3.2 内部机制

```
sendActionAndWait
   │
   ├─ push {match, resolve, reject, timer} 到 _waiters 队列
   ├─ setTimeout(timeoutMs) 兜底
   └─ sendAction(action, body)  ← JSON.stringify → encodeClientText → sock.write
                                          │
                                          ▼
                                每条收到的消息:
                                   _feedWaiters(msg)
                                      │
                                      ├─ 逐个 try match, 第一个命中
                                      │  → splice 出队列 + resolve({msg, type})
                                      └─ 都未命中 → 继续留在队列等下一条
```

`_feedWaiters` 在每条解析成功的消息上调用, **无论消息类型** (包括 `SYSTEM` / `USER_STATE` / 聊天) 都会先喂给队列。这是有意的: 工具发起查询后, 服务端响应可能混在聊天流里。

### 3.3 使用示例

```js
// 发起游戏房间请求, 等带 requestId 的响应
const { msg } = await ws.sendActionAndWait('GAME_ROOM', { type: 'RANK', limit: 10 }, {
  match: (m, t, b) => t === 'GAME_ROOM' && b?.requestId === reqId,
  timeoutMs: 5000,
});
```

### 3.4 关键边界

- **聊天消息不走这里** —— 聊天是推模型, 没有"响应", 用 `onMessage` 回调
- 连接断开时 (`finish(why)`), `_waiters` 全部 reject `Error('connection ended: ...')`
- `match` 函数抛异常会被吞掉 (视为未命中), 不会冒泡到 socket 事件循环
- 超时 reject 的 `Error.message` 形如 `'timeout: GAME_ROOM'`, 调用方可据此区分超时 vs 其他错误

## 4. 帧编解码

文本帧内容是 UTF-8 JSON, 形如 `{"action": "LOGIN", "body": {...}}`。
WS 服务端帧**不带掩码**, 客户端帧**必须**带掩码 (RFC6455)。

### 4.1 `encodeClientText(text) → Buffer`

- opcode = 0x1 (text), FIN = 1
- mask = 4 字节随机密钥, payload 逐字节 XOR
- 长度 < 126 → 7-bit 头
- 长度 < 65536 → 16-bit extended (126 + UInt16BE)
- 长度 ≥ 65536 → 64-bit extended (127 + BigUInt64BE)

### 4.2 `decodeServerFrame(buf) → { opcode, payload, consumed } | null`

- 不够一个完整帧 → 返回 `null` (由调用方继续 `Buffer.concat` 等待)
- opcode ≠ 0x1 → 跳过 (0x8 = close frame, 触发 `finish('server-close')`)
- 返回 `consumed` 字节数, 调用方 `buf = buf.slice(consumed)` 推进

### 4.3 解析流程 (`sock.on('data')`)

```
data 事件
   ├─ this._buf = concat(_buf, chunk)
   ├─ 推进 TCP 隧道 / WS 握手状态 (仅前几个包)
   ├─ handshaked 后进入帧循环:
   │     while (fr = decodeServerFrame(_buf)):
   │        _buf = _buf.slice(fr.consumed)
   │        JSON.parse → msg
   │        _feedWaiters(msg)        ← sendActionAndWait 队列
   │        处理 SYSTEM / USER_STATE  ← 登录判定 / 黑名单识别
   │        onMessage(msg, { live }) ← 业务层回调
   └─ 每次 data 更新 lastData (看门狗用)
```

## 5. 僵死看门狗

```js
watchdog = setInterval(() => {
  if (Date.now() - lastData > opts.staleTimeoutMs) {
    finish('stale');
  }
}, 30000);
```

- `lastData` 在每次 `sock.on('data')` 时更新
- 看门狗每 30s 检查一次 (而不是每 staleTimeoutMs)
- 超过 `staleTimeoutMs` (默认 90s) 无任何数据 → 主动 `finish('stale')`, 外层走普通重连 (3s)
- **作用**: 防止"TCP 还活着但服务端不再推消息"导致的静默死连接 (NAT 超时 / 运营商旁路)

## 6. 登录被拒识别

服务端在 `SYSTEM` 消息的 body 文本里给黑名单/拒绝信号, 模块用正则识别:

```js
if (/黑名单|重复|不合法|为空|未获取|禁言|拒绝/.test(txt)) {
  loginRejected = true;
  finish('login-rejected');
}
```

命中后外层用 `RECONNECT_REJECTED_MS` (30s) 而不是 3s 重连, 避免被持续拒绝刷屏。

## 7. 代理 vs 直连

由 `config.direct` 决定 (`PROXY_PORT=0` → `direct=true`):

| 模式 | 连接流程 |
|---|---|
| **直连** (`direct=true`) | `net.connect(port, host)` → 跳过 CONNECT → 直接发 WS 握手 |
| **代理** | `net.connect(proxy.port, proxy.host)` → 发 `CONNECT host:port HTTP/1.1` → 收到 `200` → 发 WS 握手 |

WS 握手报文与原 bot 字节级一致 (`GET /xechat HTTP/1.1` + 标准 `Sec-WebSocket-Key/Version`)。

## 8. 坑点

### 8.1 鱼塘预发会快速封禁新登录 IP

> 预发会快速封禁新登录 IP, 长期挂机建议走稳定代理出口 (见 `config.mjs` 注释与 `.env.example` 第 7 行)

- 24×7 部署必须 `PROXY_PORT=<稳定代理端口>`, 且代理出口 IP 信誉良好
- 单次调试可用 `PROXY_PORT=0` 直连, 但被封 IP 需要换出口或等冷却
- 同一登录名连续 5 次登录被拒 → 服务端可能临时拉黑, 见 `RECONNECT_REJECTED_MS=30000`

### 8.2 `uuid` 每次连接重新生成

```js
uuid: 'web-' + Math.random().toString(36).slice(2)
```

与原 bot 字节级一致。**不要**复用 uuid —— 旧 uuid 被服务端识别后可能强制踢线。

### 8.3 HEARTBEAT 不带 body 字段

```js
sendText(JSON.stringify({ action: 'HEARTBEAT' }));
```

- 不是 `sendAction` —— 故意省略 body
- 任何字段变更都会被服务端识别为非法, 触发断线

### 8.4 `LOGIN` 的 `pluginVersion: ''` 和 `reconnected: false`

也是为字节级兼容, 不要补字段。`platform: 'WEB'` 固定。

### 8.5 `onMessage` 在 `_feedWaiters` 之后调用

业务层收到消息时, waiters 可能已经消费掉了请求-响应消息。
- 工具查询走 `sendActionAndWait` → 不会到 `onMessage`
- 聊天 / 系统消息 → 直接走 `onMessage`
- 两者不冲突, 但调试时记得 waiter 可能"抢先"

### 8.6 `finish()` 一次性清理

`finish(why)` 清空 `_timers` / `_waiters` / `sock.destroy()`, 同一个 `WsClient` 实例**不应**复用 —— 每次重连 `agent.mjs` 会 `new WsClient(cfg)` 重建。