# lib/foundation/ws-client.mjs — 僵死看门狗详解

> 本文件是 [ws-client.md](./ws-client.md) 第 5 节的展开。详细解释 2026-08-28 重写的双信号 (入站数据 + 心跳写入) 看门狗机制。

## 1. 背景: 为什么要双信号

`HEARTBEAT` 协议帧是**单向**的 —— 客户端发, 服务端不回包。这导致:

- 安静鱼塘 (夜间无人发言) 长时间没有"入站数据"
- 老 bot 用单一 `lastData > staleTimeoutMs` 判定僵死 → 误触发重连
- 重连后再次长时间安静 → 再次误判 → 形成"安静-重连-再安静"死循环

新版引入 `lastHeartbeatOk` 追踪心跳写入, 把"链路活"与"链路死"分开:

| 链路状态 | lastData | lastHeartbeatOk | 判定 |
|---|---|---|---|
| 活跃聊天 | 持续刷新 | 持续刷新 | 健康 |
| 安静但活 | 不刷新 | 持续刷新 (心跳写入 OK) | **不**触发重连 |
| 真死链 (NAT 超时 / 服务端抽风) | 不刷新 | 不刷新 (sock.destroyed 或写入失败) | 触发重连 |

## 2. 时间戳追踪

```js
// sock.on('data') —— 入站数据时间戳
sock.on('data', (chunk) => {
  this._buf = Buffer.concat([this._buf, chunk]);
  lastData = Date.now();          // ← 每收到 chunk 更新
  // ...
});

// 心跳 interval —— 心跳写入时间戳
hb = setInterval(() => {
  try {
    this.sendText(JSON.stringify({ action: 'HEARTBEAT' }));
    lastHeartbeatOk = Date.now(); // ← 写入未抛即更新
  } catch (e) { /* swallow */ }
}, this.opts.heartbeatMs);
```

关键点:
- `lastHeartbeatOk` 在 `sendText` **未抛** 时更新, 而非在收到响应时更新 (因为没响应)
- 心跳写入失败 (sock 已 destroy) 不会更新, 看门狗会同时看到两个时间戳都 stale

## 3. 看门狗判定逻辑

```js
watchdog = setInterval(() => {
  const now = Date.now();
  const staleData = (now - lastData)        > this.opts.staleTimeoutMs;
  const staleHb   = (now - lastHeartbeatOk) > this.opts.staleTimeoutMs;
  if (staleData && staleHb) {
    this.log(`[-] ${this.opts.staleTimeoutMs / 1000}s 无入站数据 + 心跳写入停滞, 判定连接真僵死, 重连`);
    finish('stale');
  }
}, 30000);
```

判定: **两个都 stale** → `finish('stale')`。

| 配置 | 默认 | 含义 |
|---|---|---|
| `heartbeatMs` | 30000 (30s) | 心跳写入间隔 |
| `staleTimeoutMs` | 90000 (90s) | 任一时间戳超此值算 stale |
| 看门狗轮询 | 30000 (30s) | 每 30s 检查一次 (不是每 staleTimeoutMs) |

## 4. 调试指南

看到 `'stale'` 退出原因时, 按以下顺序排查:

1. **确认 `heartbeatMs` 已设置**: 默认值应该够用, 但若你把它设成 0 或非常大, 看门狗会一直 stale
2. **确认 `staleTimeoutMs >= 2 × heartbeatMs`**: 否则心跳来不及写就被判 stale
3. **检查 sock 健康**: 用 `MOCK_LLM=1 npm start` 跑离线测试, 看是否还报 `'stale'`
4. **不要回退到单信号版本**: 那是"安静即死"的过时判定, 已在新版移除

## 5. 历史

- **原 bot**: 单一 `lastData` 判定, 安静鱼塘误触重连
- **第一版 ws-client (2026-08-27 前)**: 沿用单信号
- **当前 (2026-08-28+)**: 双信号, 修复安静鱼塘误判