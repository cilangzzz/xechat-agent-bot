# 鱼塘 Manager API 参考 (Xechat Manager API)

> **⚠️ 基址前缀陷阱**
> OpenAPI 文档 `api/api-docs.json` 的 `servers[0].url` 写的是 `http://dld.lesscoding.net/xeManager` —— **`/xeManager` 前缀实际未部署**。
> 真实可用的基址是 **`https://dld.lesscoding.net/api/`**。本页所有路径请按 `/api/...` 前缀使用, 不要用文档里的 `/xeManager`。
> 客户端 `agent/lib/xechat-api.mjs` 已按 `/api/` 前缀写死, 直接可用。

## 1. 文档源与实际客户端

| 项 | 说明 |
|---|---|
| 文档源 | [`api/api-docs.json`](../../../api/api-docs.json) — OpenAPI 3.0.1, 标题 "Xechat Manager API" v1.0.0, **70 个路径 (74 个方法)**, 未声明 security scheme |
| 实际客户端 | [`agent/lib/xechat-api.mjs`](../../../agent/lib/xechat-api.mjs) — `XechatApi` 类 (87 行), 基址 `https://dld.lesscoding.net` + `/api/`, 无鉴权 |
| 响应约定 | HTTP 200 + body `{ code: 200, data: ... }` 才算成功, 否则 `_req` 抛错 (`HTTP <status>` 或 `业务码 <code>`) |

客户端三个方法对应关系:

| 方法 | 调用端点 | 用途 |
|---|---|---|
| `api.gameList({size, keyword})` | `POST /api/gameInfo/list` | 游戏列表 (分页, keyword 本地模糊过滤), 映射出 `id/name/zhName/version/status/online/playUrl/categories/fileSize` |
| `api.gameDetail(idOrName)` | `GET /api/gameInfo/detail/{id}` 或 `GET /api/gameInfo/{gameName}` | 游戏详情 (按 id 或英文名; 中文名/描述编码正常) |
| `api.leaderboard({gameInfoId, rankKey, limit})` | `POST /api/leaderboard/ranking` | 排行榜查询, 归一化为 `rank/username/score[/nickname]` |

## 2. 项目内如何调用

| 工具 (tools.mjs) | 通道 | 底层 |
|---|---|---|
| `games` | HTTP (`XechatApi`) | `POST /api/gameInfo/list` → `gameList()` |
| `game_detail` | HTTP (`XechatApi`) | `GET /api/gameInfo/detail/{id}` 或 `/api/gameInfo/{gameName}` → `gameDetail()` |
| `leaderboard` | HTTP (`XechatApi`) | `POST /api/leaderboard/ranking` → `leaderboard()` |
| `create_room` | **WS 协议** | `CREATE_GAME_ROOM` action, 不经过 Manager HTTP API |
| `close_room` | **WS 协议** | `GAME_ROOM` action, 不经过 Manager HTTP API |
| `list_rooms` | **WS 协议** | `GAME_ROOM` action, 不经过 Manager HTTP API |

要点:
- **查询类** (游戏/详情/排行) 走 HTTP `XechatApi` —— 公共只读接口, 无需登录, `ctx.api` 在 `tools.mjs` 中注入;
- **房间类** (`create_room` / `close_room` / `list_rooms`) 走 WebSocket 的 `CREATE_GAME_ROOM` / `GAME_ROOM` action, 与本 HTTP API 无关;
- 注册 / 登录 (`/api/user/register` `/api/user/login`) 存在但当前客户端**未封装**。

## 3. 端点域划分

完整逐端点清单见 **[endpoints-summary.md](./endpoints-summary.md)**。按域:

| 域 | 端点数 | 组成 |
|---|---|---|
| 游戏管理 | 27 | `gameInfo` 15 (增删改查/部署/版本/详情) + `category` 7 + `server` 5 |
| 用户/角色/菜单 | 18 | `user` 7 + `role` 5 + `menu` 6 (RBAC) |
| 排行榜 | 2 | `leaderboard/submit` + `leaderboard/ranking` |
| 文件 | 4 | `file` upload / page / view / download |
| 部署历史 | 5 | `deployHistory` 增删改查 |
| 其它 | 18 | `storage` 存档 4 + `dict` 字典 9 + `achievement` 成就 2 + `operLog` 日志 2 + `dashboard` 统计 1 |

## 4. 调用约定与陷阱

- **前缀**: 文档写 `/xeManager`, 实际是 `/api/` (见顶部警告)。OpenAPI 里的 70 个路径去掉首段即真实路径, 例: 文档 `/gameInfo/list` → `POST https://dld.lesscoding.net/api/gameInfo/list`。
- **鉴权**: 文档未声明任何 security scheme, 客户端也是匿名调用; 但部分端点描述注明"需登录" (`/api/file/upload`, `/api/file/page`) 或"免登录" (`/api/file/view/{fileId}`, `/api/file/download/{fileId}`, `/api/server/list`)。
- **响应包装**: 一律 `{ code, message, data }`; 客户端只认 `code === 200` 并返回 `data`。
- **上传类** (`/api/gameInfo/upload`, `/api/file/upload`) 为 multipart 表单, 客户端未封装。
- **游戏状态**: `status === 1` 表示上线 (`gameList` / `gameDetail` 里的 `online`)。

## 5. 相关文件

- 端点摘要: [endpoints-summary.md](./endpoints-summary.md)
- OpenAPI 原始文档: [`api/api-docs.json`](../../../api/api-docs.json)
- 客户端实现: [`agent/lib/xechat-api.mjs`](../../../agent/lib/xechat-api.mjs)
- 工具注册: [`agent/lib/tools.mjs`](../../../agent/lib/tools.mjs) (116 行起, "鱼塘平台功能查询")
- WS 房间协议 (非本 API): [`agent/lib/ws-client.mjs`](../../../agent/lib/ws-client.mjs)
