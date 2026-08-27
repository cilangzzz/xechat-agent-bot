# 鱼塘 (Xechat) API 参考

本目录收录鱼塘平台的 API 参考，供 agent 与开发者查阅。内容来源于上游源码
`xechat-server` + `xechat-commons`（聊天服务器/协议）与已部署的 Manager HTTP API（OpenAPI 文档）。

## 文件清单

| 文件 | 内容 | 传输层 / 基址 |
|---|---|---|
| [manager-api-docs.json](manager-api-docs.json) | **管理端 HTTP API**（Xechat Manager API，OpenAPI 3.0.1，70 路径/74 方法）：游戏管理、用户/角色/菜单、排行榜、文件、部署历史、字典、成就、仪表盘、云存档、操作日志 | HTTP `https://dld.lesscoding.net/api/` |
| [ws-protocol.md](ws-protocol.md) | **WebSocket 聊天协议**（核心）：双通道/握手、Action、MessageType、Request/Response 信封、登录/聊天/状态/天气/react/权限/断线全流程 | WebSocket `ws://host:port+1/xechat` |
| [game-protocol.md](game-protocol.md) | **游戏协议**：Game 枚举、创建房间、房间消息（邀请/准备/开始/关闭）、GAME/GAME_OVER、各游戏 DTO（五子棋/象棋/斗地主/麻将/UNO/大富翁） | WebSocket |
| [http-api.md](http-api.md) | **聊天服务器 HTTP 端点**：`GET /download/{fileName}` 静态文件下载、健康检查 | HTTP `http://host:port+1` |
| [aux-services.md](aux-services.md) | **辅助服务**：和风天气、百度翻译、IP 归属地(ip2region)、服务器列表、城市库、服务端配置汇总 | 第三方 / 服务端内部 |

## 关键约定

- **两条传输通道**：DEFAULT（原生 TCP，`port`）与 WebSocket（`port+1`，路径 `/xechat`）。agent 使用 WebSocket 通道。
- **WS 消息信封**：上行 `{action, body, protocol}`，下行 `{user, body, type, time}`。
- **管理端 HTTP 基址陷阱**：`manager-api-docs.json` 的 `servers[0].url` 写的是 `http://dld.lesscoding.net/xeManager`，**`/xeManager` 前缀实际未部署**，真实可用基址是 **`https://dld.lesscoding.net/api/`**（客户端 `agent/lib/xechat-api.mjs` 已按 `/api/` 写死）。
- **响应约定**（管理端）：HTTP 200 + body `{code: 200, data: ...}` 才算成功。

## 项目内如何使用

| 需求 | 走哪个 API |
|---|---|
| 游戏列表 / 详情 / 排行榜 | 管理端 HTTP（`xechat-api.mjs`：`gameList` / `gameDetail` / `leaderboard`） |
| 服务器列表 | 管理端 HTTP `GET /api/server/list`（`xechat-api.mjs`：`serverList`） |
| 创建/关闭/列出游戏房间 | WS 协议 `CREATE_GAME_ROOM` / `GAME_ROOM`（`ws-client.mjs`） |
| 登录/聊天/状态/天气/react | WS 协议（[ws-protocol.md](ws-protocol.md)） |

## 汇总文档

- 管理端端点摘要与调用说明：[.claude/docs/api/README.md](../.claude/docs/api/README.md)、[.claude/docs/api/endpoints-summary.md](../.claude/docs/api/endpoints-summary.md)
