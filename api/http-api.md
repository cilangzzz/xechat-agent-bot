# 鱼塘 (Xechat) 聊天服务器 HTTP 端点

> 来源：上游源码 `xechat-server/handler/HttpChannelHandler.java` 与 `HttpAndWebSocketChannelInitializer.java`。
> 这是 **Netty 聊天服务器自身**的 HTTP 端点（与 WebSocket 通道同端口+1、非 /xechat 路径），和管理端 HTTP API（[manager-api-docs.json](manager-api-docs.json)，`https://dld.lesscoding.net/api/`）**是两回事**。

## 1. 定位与管线

- 处理器：`HttpChannelHandler`。走该 HTTP 管线：`IdleStateHandler(0,0,60)` → `HttpServerCodec` → `HttpObjectAggregator(65536)` → `ChunkedWriteHandler` → … → `HttpChannelHandler`（普通 HTTP 请求）→ `WebSocketChannelHandler`（升级到 `/xechat` 的 WS 请求）。
- HTTP 请求体最大聚合 64KB；空闲 60 秒无读写则关闭连接。

## 2. GET /download/{fileName} —— 下载/查看聊天上传的文件

### 2.1 行为

1. `fileName = uri.replace("/download/", "")`。
2. 若 `fileName` **以 `.` 开头**（如 `.hidden`）→ 直接 `404`，不读取。
3. 读取 `{user.home}/xechat/upload/{fileName}`；文件存在 → `200` + 以下响应头；不存在 → `404`。
4. 非 `/download/` 的任意 URI → `200`，响应体为 `Hello World!`（探测/健康检查用）。

### 2.2 成功响应头

| 响应头 | 值 |
|---|---|
| `Content-Type` | `image/jpeg,image/png,image/gif,image/bmp`（源码原样的逗号分隔多值） |
| `Cache-Control` | `max-age=86400` |
| `Content-Disposition` | `inline;filename="<fileName>"` |
| `Connection` | `close`（写后关闭） |
| `Content-Length` | 文件字节数 |

```http
GET /download/3f1c2a4b5d6e7f8a9b0c1d2e.png HTTP/1.1
Host: xechat.xeblog.cn:33859
```

```http
HTTP/1.1 200 OK
Connection: close
Content-Type: image/jpeg,image/png,image/gif,image/bmp
Cache-Control: max-age=86400
Content-Disposition: inline;filename="3f1c2a4b5d6e7f8a9b0c1d2e.png"
Content-Length: 12345

<二进制图片字节>
```

### 2.3 失败模式

| 场景 | 结果 |
|---|---|
| 文件不存在 | `404 text/plain`，连接关闭 |
| fileName 以 `.` 开头 | `404`（不读取） |
| 非 `/download/` URI | `200 Hello World!` |
| 路径穿越 | 源码仅拒绝"以 `.` 开头"，**未过滤 `../` 等**（拼接为 `UPLOAD_FILE_PATH + "/" + fileName`）——存在路径穿越风险，属源码事实 |

## 3. 文件存储

- 存储根：`GlobalConfig.UPLOAD_FILE_PATH = System.getProperty("user.home") + "/xechat/upload"`。
- 上传入口：WS 协议 `REACT/UPLOAD`（见 [ws-protocol.md](ws-protocol.md) §9），保存名 `UUID.文件类型`；成功后广播 `USER` 消息（`UserMsgDTO{msgType=IMAGE, content=文件名}`），客户端用 `GET /download/<文件名>` 取图。
