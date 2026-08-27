# agent.mjs 入口

`agent.mjs` 是鱼塘 Agent Bot 的启动入口 —— 配置 → 依赖组装 → 消息分发 → 重连主循环，所有业务模块在此装载连接。

- 源文件: [agent/agent.mjs](../../../agent/agent.mjs)（269 行）

## 1. 启动流程

```
loadDotEnv → applyArgs(CLI) → loadConfig → makeLogger
   ↓
组装: llm / sessions / pondState / api / memory / scheduler /
      trigger / chatLog / sendup / client / router
   ↓
兜底: 无 API Key 且未开 mock → 警告日志
   ↓
scheduler.start(handler)            ← 定时任务回调
while (true) { client.runOnce() }   ← 主循环: 自动重连
```

## 2. CLI 参数 (`applyArgs`)

`node agent.mjs [登录名] [--prefix /xxx] [--owner 领养人] [--help]`

| 参数 | 作用 |
|---|---|
| 位置参数 / `--name/-n` | 登录名（写 `process.env.BOT_USERNAME`） |
| `--prefix/-p` | 自定义触发前缀，默认随登录名派生 `/<登录名>` |
| `--owner` | 领养人 → 专属模式：仅服务该用户；名改为 `<人>的大黄鱼`，前缀 `/<人>的大黄鱼` |
| `--help/-h` | 打印帮助后退出 |

CLI 优先于 `.env`，直接写回 `process.env` 再被 `loadConfig` 读取。

## 3. 主循环 + 自动重连

```js
while (true) {
  const why = await client.runOnce();   // 登录/心跳/看门狗封装
  if (why === 'login-rejected') await sleep(cfg.reconnect.loginRejectedMs); // 默认30s
  else if (why === 'stopped') break;
  else await sleep(cfg.reconnect.normalMs); // 默认3s
}
```

`client.runOnce()` 结束返回退出原因，按 登录被拒/正常断线 分流重连，`stopped` 退出。

## 4. 消息处理 `client.onMessage`

按 `m.action / m.type` 分流：

### 4.1 在线状态维护

- `USER_STATE` → 单用户 ONLINE 加 / OFFLINE 删；
- `ONLINE_USERS` → 登录后一次性全量快照，重置 `Set` + 打 `snapshotAt`。

数据源供 `online` / `stats` / `room_stats` 工具查询。

### 4.2 游戏房间订阅（增量维护）

- `GAME_ROOM_CREATED` → `activeRooms.set(id, {roomId, game, nums, gameMode, homeowner, createdAt})`；
- `GAME_ROOM msgType=ROOM_CLOSE` → `activeRooms.delete(roomId)`。

服务端**不推全量房间列表**，仅靠这两类事件增量累积；断线期间事件丢失，重启后从零重建。

### 4.3 聊天消息判定（指令 vs @ 提及 vs 忽略）

`USER/CHAT` 且 `body.content` 非空，顺序判定：

1. **live 采集**：入 `roomLog` 环形缓冲（默认 100 条）+ `chatLog.append`（持久化）；
2. **触发器喂数据**：`trigger.onMessage(...)`（若开启）；
3. **专属模式**：`cfg.owner` 且 `from !== owner` → return；
4. **忽略自己**：`from === cfg.username` → return；
5. **触发判定**：以 `cmdPrefix` 开头 → 指令；否则 `extractMention()` 命中 → @ 提及；都无 → return；
6. **重放期**：`!live` 只记日志不处理；
7. **冷却**：距上次回复 `< replyCooldownMs` → 跳过；
8. **per-user 锁**：`busyUsers.has(from)` → 跳过（同一用户后续消息丢弃）；
9. 占用 `busyUsers` + 记录 `lastReply`，按需发 💭 思考提示；
10. **异步处理**：`router.handle(...)` 或 `handleMention(...)`；
11. 异常兜底：`这个我暂时答不上来，换个问题试试？`；
12. `sendReply(reply, from)` 定向发送，最后 `busyUsers.delete(from)` 释放。

### 4.4 主动消息触发器（默认关）

每条 live 消息喂 `trigger.onMessage`；窗口内不同用户数达 `cfg.trigger.threshold` → 返回批次 → LLM 按 `TRIGGER_SYSTEM`（真人口吻，40-80 字）生成争议性消息 → `sendReply(msg, null)` 广播。LLM 判定无槽点（空串/纯标点/"路过"等）→ 静默不广播，避免刷屏。生成失败仅记日志。

### 4.5 兜底

- 启动检查：无 API Key 且未开 mock → 警告日志；
- 路由异常 → 兜底文案；触发器/定时器异常 → 仅日志，不拖垮主循环。

## 5. 定时任务回调 `scheduler.start(handler)`

```js
scheduler.start(async (t) => {
  if (t.mode === 'auto') {  // 用 LLM 按 task 生成结果
    const text = await llm.chat(...);
    await sendReply(`⏰ [定时执行] ${msg}`, t.to);
  } else {                  // remind: 直接发文本
    await sendReply(`🔔 [定时] ${t.task}`, t.to);
  }
});
```

## 6. 依赖总图

```
agent.mjs
  ├── config.mjs         loadDotEnv / loadConfig / applyArgs
  ├── lib/ws-client.mjs  WsClient: 连接 + onMessage 回调
  ├── lib/llm.mjs        createLlm
  ├── lib/sessions.mjs   SessionStore: per-user 会话 + tryLock
  ├── lib/router.mjs     Router: 命令路由
  ├── lib/reply.mjs      makeReplySender: 分片回复
  ├── lib/memory.mjs     MemoryStore: 持久事实(默认关)
  ├── lib/scheduler.mjs  Scheduler: 定时任务
  ├── lib/trigger.mjs    createTrigger: 主动消息(默认关)
  ├── lib/chat-log.mjs   ChatLog: JSONL 聊天记录
  ├── lib/sendup.mjs     sendup.cc 上传
  └── lib/xechat-api.mjs XechatApi: 平台 HTTP API
```

## 7. 关键常量（config.mjs 默认）

`REPLY_COOLDOWN_MS`(4s 防刷) · `MSG_MAX_LEN`(200 单条上限) · `MSG_CHUNK_DELAY_MS`(600ms 分片间隔) · `RECONNECT_NORMAL_MS`(3s) · `RECONNECT_REJECTED_MS`(30s) · `TRIGGER_THRESHOLD` · `HISTORY_MAX`(10) · `COMPACTION_TOKEN_BUDGET`(3000)

## 8. 错误与边界

- 鱼塘 `toUsers` 实际是广播（仅带目标标记）—— 不发敏感内容，持久记忆默认关；
- 单点失败（LLM/触发器/定时器）均被局部 try/catch 吞掉，不中断主循环；
- 触发器 LLM 输出做安静过滤：空串 / 纯标点 / "路过"开头 → 不广播。
