# 鱼塘 (Xechat) WebSocket 聊天协议参考

> 来源：上游源码 `xechat-commons`（协议实体/枚举）与 `xechat-server`（服务端实现）。
> 本页是 agent 机器人走 WebSocket 通道（`ws-client.mjs`）所依赖的**核心协议**。管理端 HTTP API 见 [manager-api-docs.json](manager-api-docs.json) 与 `.claude/docs/api/`；游戏房间协议见 [game-protocol.md](game-protocol.md)。

## 1. 双通道与 WebSocket 连接

服务端 XEChatServer 同时启动两条 Netty 通道（同属一个 EventLoopGroup，端口相邻）：

| 通道 | 端口 | 编码 | 用途 |
|---|---|---|---|
| DEFAULT（原生 TCP） | `P`（默认 1024；线上 `lesscoding.net:33858`） | Protostuff 二进制 + 4 字节长度前缀 + TLS 双向认证 | IDEA 插件 / 控制台客户端 |
| WebSocket | `P + 1`（默认 1025；线上 `:33859`） | **JSON 文本帧** | Web 浏览器（webview 页面）、agent 机器人 |

- 握手路径：`ws://host:port+1/xechat`（agent 的 `ws-client.mjs` 即连 `XE_PORT=33859`，发送 `GET /xechat HTTP/1.1` 升级握手）。
- WebSocket 通道 **未配置 SSL**（不支持 `wss://`）；DEFAULT 通道才有 SSL + 客户端证书双向认证。
- `enableWS`：代码级默认 **false**（`ConfigUtil` 无显式默认，仅当随附 `config.setting` 含 `enableWS = true` 时 WebSocket 通道才开启）。
- 空闲超时：两条通道均配置 `IdleStateHandler(0, 0, 60)`，**60 秒**无读写（ALL_IDLE）即 `ctx.close()`。

## 2. 消息信封（Request / Response）

### 2.1 客户端 → 服务端：`Request<T>`

| 字段 | 类型 | 说明 |
|---|---|---|
| `body` | T | 请求体，随 `action` 不同而为 LoginDTO / UserMsgDTO / WeatherDTO / ReactRequest / ... |
| `action` | Action | 客户端动作枚举（见 §3） |
| `protocol` | Protocol | `DEFAULT` / `WEBSOCKET`（WebSocket 通道由服务端自动置为 `WEBSOCKET`） |

```json
{ "body": { "username": "摸鱼大师" }, "action": "LOGIN", "protocol": "WEBSOCKET" }
```

### 2.2 服务端 → 客户端：`Response<T>`

所有下行消息（含广播）都是该结构，`body` 的类型由 `type` 决定：

| 字段 | 类型 | 说明 |
|---|---|---|
| `user` | User | 消息来源用户；系统消息为 `null` |
| `body` | T | 内容 |
| `type` | MessageType | 消息类型 |
| `time` | String | 发送时间，格式 `MM/dd HH:mm` |

```json
{
  "user": { "id": "f0e1...", "username": "摸鱼大师", "status": "FISHING" },
  "body": { "content": "大家好", "msgType": "TEXT", "toUsers": null },
  "type": "USER",
  "time": "08/27 14:23"
}
```

## 3. 枚举

### 3.1 Action（客户端动作，上行 `action` 字段）

| 常量 | 含义 | 服务端处理器（@DoAction） |
|---|---|---|
| `LOGIN` | 登录 | LoginActionHandler |
| `CHAT` | 聊天 | ChatActionHandler |
| `GAME` | 游戏数据 | GameActionHandler |
| `SET_STATUS` | 设置状态 | SetStatusActionHandler |
| `GAME_OVER` | 游戏结束 | GameOverActionHandler |
| `GAME_ROOM` | 游戏房间消息 | GameRoomActionHandler |
| `CREATE_GAME_ROOM` | 创建游戏房间 | GameRoomCreateActionHandler |
| `LIST_USERS` | 在线用户列表 | **无处理器**（见下） |
| `HEARTBEAT` | 心跳 | 无（RequestHandler 直接忽略） |
| `WEATHER` | 查询天气 | WeatherActionHandler |
| `REACT` | react 指令（上传/下载/管控） | ReactActionHandler |

> `LIST_USERS` 在服务端**没有**注册处理器。WebSocket 通道发送该 action 时，`ActionHandlerFactory.produce()` 返回 null 并在异步线程中触发 NPE，被 `RequestHandler` 的 try/catch 捕获 → 客户端收到 SYSTEM `"消息内容解析异常!"`。在线用户列表实际由服务端在**登录成功时主动推送** `ONLINE_USERS` 消息（见 §5）。

### 3.2 MessageType（下行 `type` 字段）

| 常量 | 含义 | body 实际类型 |
|---|---|---|
| `USER` | 用户聊天消息 | UserMsgDTO |
| `SYSTEM` | 系统消息 | String（提示文本） |
| `ONLINE_USERS` | 在线用户列表 | UserListMsgDTO |
| `GAME` | 游戏数据消息 | 游戏相关 DTO |
| `GAME_OVER` | 游戏结束消息 | 游戏相关 DTO |
| `HISTORY_MSG` | 历史聊天记录 | HistoryMsgDTO |
| `GAME_ROOM` | 游戏房间消息 | GameRoomMsgDTO |
| `GAME_ROOM_CREATED` | 游戏房间已创建 | GameRoom |
| `STATUS_UPDATE` | 用户状态更新 | null（仅 `user` 有值） |
| `USER_STATE` | 用户上线/离线 | UserStateMsgDTO |
| `HEARTBEAT` | 心跳 | **服务端从不发送该类型响应**；客户端插件将其视为 no-op |
| `REACT` | react 请求响应 | ReactResult |

### 3.3 其它枚举

- **UserStatus**：`WORKING`（简称"工"，别名"工作中"）、`FISHING`（"鱼"/"摸鱼中"）、`PLAYING`（"戏"/"游戏中"）。
- **Platform**：`IDEA`（Jetbrains 插件）、`WEB`（Web/webview）、`COMMAND`（命令行）。
- **Protocol**：`DEFAULT`（原生 TCP）、`WEBSOCKET`。
- **Permissions**（位掩码）：`SPEAK = 0b01 (1)` 发言、`SEND_FILE = 0b10 (2)` 发文件、`ALL = 0b11 (3)` 所有权限。

### 3.4 广播范围（三种发送方式）

| 方式 | 实现 | 范围 |
|---|---|---|
| `ChannelAction.send(Response)` | 写入全局 `ChannelGroup` | **全服广播**；type 为 `SYSTEM`/`USER` 时同时写入历史 |
| `user.send(Response)` | 写入该用户自己的 channel | **单发** |
| `GameRoom.getUsers()` 遍历 `player.send` | 逐个写房间成员 channel | **房间内广播** |

## 4. 请求分发与服务端入口

1. `RequestHandler.exec()`：`action` 为 null 或 `HEARTBEAT` → 直接 return（心跳不回包）。
2. `body` 为空 → 回 SYSTEM `"Body is null!"`。
3. 提交 `GlobalThreadPool` 异步执行 → `ActionHandlerFactory.produce(action)` 取单例 handler。
4. WebSocket 协议下按 handler 泛型反序列化 `body`（`SET_STATUS` 用 `UserStatus.valueOf`）；转换异常 → SYSTEM `"消息内容解析异常!"`。
5. `produce.handle(ctx, body)`。

## 5. 登录流程（Action.LOGIN）

### 5.1 请求体 LoginDTO

| 字段 | 类型 | 默认/容错 | 含义 |
|---|---|---|---|
| `username` | String | 必填 | 昵称 |
| `status` | UserStatus | 解析失败回退 FISHING | 初始状态 |
| `reconnected` | boolean | false | 是否断线重连 |
| `pluginVersion` | String | 可空 | 客户端版本（仅 IDEA 平台比对） |
| `token` | String | 可空 | 管理员令牌，与服务端配置一致则角色为 ADMIN |
| `uuid` | String | 必填 | 客户端全局唯一 ID |
| `platform` | Platform | null 时服务端补为 IDEA | 来源平台 |
| `ipRegion` | IpRegion | 入参未使用 | 服务端忽略，地区由服务端按 IP 解析 |

### 5.2 服务端校验（失败回 SYSTEM 消息）

| 序号 | 校验 | 失败响应 | 是否关连接 |
|---|---|---|---|
| 1 | 已登录 | "请勿重复登录！" | 否 |
| 2 | IDEA 平台版本比对 | 版本提醒文本 | 否 |
| 3 | 昵称为空 | "昵称不能为空！" | 是 |
| 4 | 昵称含非法字符（不可见字符等） | "昵称不合法，请修改后重试！" | 是 |
| 5 | 昵称长度 > 12 | "昵称长度不能超过12个字符！" | 是 |
| 6 | 昵称重复 | "[昵称]昵称重复！" | 是 |
| 7 | 昵称含敏感词 | "昵称含有违规字符，请修改后重试！" | 是 |
| 8 | uuid 为空 | "未获取到UUID，请尝试重新登录！" | 是 |

### 5.3 登录成功后的消息序列（按顺序）

| 序号 | 消息 | MessageType | body | 范围 |
|---|---|---|---|---|
| 1 | 在线用户列表 | ONLINE_USERS | `UserListMsgDTO{userList}`（含新用户本人） | 单发新用户 |
| 2 | 上线通知 | USER_STATE | `UserStateMsgDTO{user, state=ONLINE}` | 全服广播 |
| 3 | 重连提示（仅 reconnected=true） | SYSTEM | "重新连接服务器成功！" | 单发 |
| 4 | 欢迎语 | SYSTEM | "修身洁行，言必由绳墨。" | 单发 |
| 5 | **进塘通知** | SYSTEM | `[省份简称·用户名]进入了鱼塘！`（如 `[粤·张三]进入了鱼塘！`；省份未命中简称映射时回退为国家名） | 全服广播 |
| 6 | 历史消息（非空时） | HISTORY_MSG | `HistoryMsgDTO{msgList}`，`getHistory(30)` 取最近 30 条 | 单发 |

### 5.4 用户对象 User（协议中的用户）

字段：`uuid`、`id`（Netty 通道长 ID，用户主键）、`username`、`status`、`shortRegion`、`ip`(transient)、`region`(transient)、`role`（`ADMIN`/`USER`）、`permit`（int 位掩码）、`platform`、`channel`(transient)。
`equals/hashCode` 以 `id` 为唯一键；`isAdmin()` 判断 `role == ADMIN`。`ip/region/channel` 为 transient，JSON 中通常不出现。

## 6. 聊天消息（Action.CHAT）

### 6.1 请求体 UserMsgDTO

| 字段 | 类型 | 说明 |
|---|---|---|
| `content` | Object | 内容（TEXT 为字符串，IMAGE 为文件名） |
| `msgType` | MsgType | `TEXT` / `IMAGE` |
| `toUsers` | String[] | 目标昵称数组（私聊标记；`null`/空数组 = 群发） |

### 6.2 服务端处理（ChatActionHandler.process）

1. 权限校验：本人无 `SPEAK` 权限 → 本人收 SYSTEM "您已被禁言！"；全局禁言（`GLOBAL_PERMIT` 不含 SPEAK）→ "鱼塘已开启全员禁言！"。
2. `TEXT`：`content` 长度 > 200 字符 → "发送的内容长度不能超过200字符！"。
3. 内容管线：`BaiDuFyUtil.translate(SensitiveWordUtils.loveChina(msg))` —— 敏感词命中则整条替换为随机正能量词；默认**未配置百度翻译**，原样返回。
4. `IMAGE` 一律被转成 `TEXT`（"暂时不支持这种形式的消息"）。
5. `ChannelAction.send(user, body, USER)` → **全服广播**，并写入历史。

### 6.3 ⚠️ 私聊（toUsers）真实行为：广播 + 目标标记

服务端**不做定向推送**。`toUsers` 只是携带在 body 里的目标昵称标记，**实际是发给所有在线客户端的全服广播**，真正的过滤由客户端根据 `response.user` 与 `body.toUsers` 在本地完成。因此"私聊"在协议层面与群聊相同 —— **不要通过 toUsers 发送敏感信息**（见项目 README 已知约束）。

### 6.4 禁言 / 黑名单 / 敏感词

- **禁言（服务端）**：位掩码权限。个人禁言 = 移除该用户 `permit` 的 SPEAK 位；全员禁言 = 从 `GLOBAL_PERMIT` 移除 SPEAK 位（见 §9.2）。
- **黑名单（屏蔽）**：服务端源码**无黑名单逻辑**；屏蔽是客户端（IDEA 插件）本地功能，不经过服务端。
- **敏感词**：服务端仅两处 —— 昵称校验 + 聊天内容替换（loveChina）。

## 7. 状态更新（Action.SET_STATUS）

请求 `body` 直接是 `UserStatus` 字符串（非 DTO）：`{"action":"SET_STATUS","body":"FISHING"}`。
处理：`user.setStatus(body)` → `ChannelAction.updateUserStatus(user)` → **全服广播** `STATUS_UPDATE`（body=null，user=状态变更者）。

游戏房间操作会隐式触发 `updateUserStatus`（加入房间置 PLAYING、离开/房间关闭置 FISHING），同样全服广播 `STATUS_UPDATE`。

## 8. 天气查询（Action.WEATHER）

请求体 `WeatherDTO{type: WeatherType, location: String}`。`type`：`NOW`/`WEATHER_3D`/`WEATHER_7D`（`"3"`→3D，`"7"`→7D，其它→NOW）。
结果以 `SYSTEM` 文本（ConsoleTable ASCII 表格）**仅单发请求者**。详细流程与和风接口见 [aux-services.md](aux-services.md)。

## 9. React（Action.REACT，上传/下载/管控）

### 9.1 请求体 ReactRequest

`ReactRequest<T>`（继承 `BaseReact{id, uid}`）：`body`（子请求 DTO）、`react`（`UPLOAD`/`DOWNLOAD`/`ADMIN`）。

### 9.2 响应 ReactResult（MessageType.REACT，仅回发请求方）

字段：`id`、`uid`（原样回传）、`succeed`（boolean）、`data`（Upload/Download/AdminReactResult）、`msg`（初始 `"请求无响应！"`）。
未登录（`UserCache.get(uid)` 为空）→ `msg="请先登录！"`。

### 9.3 子类型

| react | 请求 DTO | 成功 data | 说明 |
|---|---|---|---|
| UPLOAD | `UploadReact{fileType, bytes}` | `UploadReactResult{fileName}` | 上传文件；成功后全服广播 `USER` + `UserMsgDTO{msgType=IMAGE, content=文件名}` |
| DOWNLOAD | `DownloadReact{fileName}` | `DownloadReactResult{fileName, bytes}` | 下载文件 |
| ADMIN | `AdminReact{operate, permissions, uid, value}` | `AdminReactResult{globalPermit, maxFileSize}` | 权限/配置管控，仅管理员 |

**Upload 双权限校验**：本人无 `SEND_FILE` 权限 → "您没有上传文件的权限！"；全局禁文件（`GLOBAL_PERMIT` 不含 SEND_FILE）→ "鱼塘已禁止发送文件！"；`bytes` 超 `UPLOAD_FILE_MAX_SIZE`（默认 2048KB）→ "发送的文件大小不能超过2048KB!"。

## 10. 权限（Permissions / AdminReact 管控）

### 10.1 权限载体

- **User.permit**（int）：个人权限位。
- **GlobalConfig.GLOBAL_PERMIT**（int）：全局权限位，默认 `3`（ALL）。
- **GlobalConfig.UPLOAD_FILE_MAX_SIZE**：上传大小上限（KB），默认 `2048`。
- **GlobalConfig.USER_PERMIT_CACHE**（Map）：key 为 uuid 或 ip 的持久化权限缓存。

### 10.2 AdminReact 管控操作（Operate 枚举）

| operate | 服务端行为 | 全服通知（SYSTEM） |
|---|---|---|
| `QUERY_PERMIT` | 仅返回数据，无动作 | - |
| `GLOBAL_MAX_FILE_SIZE` | `UPLOAD_FILE_MAX_SIZE = Integer.parseInt(value)` | "管理员已将文件上传的大小限制为[大小]KB!" |
| `GLOBAL_PERMIT_ADD` | `GLOBAL_PERMIT |= permissions.value` | SEND_FILE→"鱼塘已允许全员发送图片！"；SPEAK→"鱼塘已解除全员禁言！" |
| `GLOBAL_PERMIT_REMOVE` | 已含该权限时 `GLOBAL_PERMIT ^= value` | SEND_FILE→"鱼塘已禁止全员发送图片！"；SPEAK→"鱼塘已开启全员禁言！" |
| `USER_PERMIT_ADD` | 目标用户 `addPermit` + 写缓存；随后 `STATUS_UPDATE` **全服广播**（body=null） | "已允许[昵称]发送图片！"/"已允许[昵称]发言！" |
| `USER_PERMIT_REMOVE` | 同上用 `removePermit` | "已禁止[昵称]发送图片！"/"已禁止[昵称]发言！" |

> 注意：`USER_PERMIT_ADD/REMOVE` 的 `STATUS_UPDATE` 走 `ChannelAction.send`（全局 ChannelGroup），是**全服广播**而非单发。
> 非管理员调用 ADMIN → `result.msg = "没有权限！"`。

## 11. 心跳、断线与离线通知

- **心跳**：客户端定时发送 `{"action":"HEARTBEAT"}`；服务端收到**直接忽略、不回任何包**。Agent 心跳默认 25s。
- **断线清理**（`ChannelAction.cleanUser`）：用户处于游戏房间时，先向房间内其它玩家发 `GAME_ROOM`（`PLAYER_LEFT`）并 `leftRoom`；然后 `UserCache.remove(id)`；最后**全服广播** `USER_STATE`（`UserStateMsgDTO{user, state=OFFLINE}`）。
- 在线列表维护：客户端根据登录时的 `ONLINE_USERS` 快照 + 后续 `USER_STATE` ONLINE/OFFLINE 事件增量维护。

## 12. 与 agent 的对应关系

| agent 模块 | 使用的协议 |
|---|---|
| `agent/lib/ws-client.mjs` | WS 握手（/xechat）、`LOGIN`、`HEARTBEAT`、`GAME_ROOM`、`CREATE_GAME_ROOM`；解析 `SYSTEM`/`USER`/`USER_STATE` 等下行消息 |
| `agent/lib/xechat-api.mjs` | 管理端 HTTP API（`gameInfo/list`、`gameInfo/detail`、`leaderboard/ranking`），见 [manager-api-docs.json](manager-api-docs.json) |
| 房间工具 `create_room`/`close_room`/`list_rooms` | WS 协议 `CREATE_GAME_ROOM` / `GAME_ROOM`，**不经管理端 HTTP API** |
