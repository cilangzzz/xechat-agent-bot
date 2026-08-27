# 鱼塘 (Xechat) 游戏协议参考

> 来源：上游源码 `xechat-commons/entity/game`（DTO）与 `xechat-server`（房间缓存 / action 处理）。
> 游戏房间走 **WebSocket 协议**（`CREATE_GAME_ROOM` / `GAME_ROOM` / `GAME` / `GAME_OVER`），与管理端 HTTP API 无关。房间通用协议与消息信封见 [ws-protocol.md](ws-protocol.md)。

## 1. Game 枚举（全部游戏类型）

| index | 常量 | name（中文名） | requiredLogin |
|---|---|---|---|
| 0 | `GOBANG` | 五子棋 | false |
| 1 | `LANDLORDS` | 斗地主 | false |
| 2 | `NON_GLUTTONOUS_SNAKE` | 不贪吃蛇 | false |
| 3 | `GAME_2048` | 2048 | false |
| 4 | `SUDOKU` | 数独 | false |
| 5 | `PUSH_BOX` | 推箱子 | false |
| 6 | `CHINESE_CHESS` | 中国象棋 | false |
| 7 | `TETRIS` | 俄罗斯方块 | false |
| 8 | `MINESWEEPER` | 扫雷 | false |
| 9 | `IKUN` | 爱坤大乐斗 | true |
| 10 | `UNO` | UNO | true |
| 11 | `MONOPOLY` | 大富翁 | true |
| 12 | `MAHJONG` | 爱坤麻将 | true |

`getGame(int index)` 按 ordinal 取常量，越界返回 null。

## 2. 创建游戏房间（Action.CREATE_GAME_ROOM）

### 2.1 请求体 CreateGameRoomDTO

| 字段 | 类型 | 默认 | 含义 |
|---|---|---|---|
| `game` | Game | 无 | 游戏类型 |
| `nums` | int | 0 | 几人房 |
| `gameMode` | String | null | 游戏模式 |

```json
{ "action": "CREATE_GAME_ROOM", "body": { "game": "GOBANG", "nums": 2, "gameMode": null } }
```

### 2.2 服务端行为

1. 房间号 = `LocalDateTime.now()` 格式化 `HHmmssSSS`（如 `143025123`）。
2. `GameRoomCache.seize(roomId)`：房间号撞号返回 null → 仍回 `GAME_ROOM_CREATED` 但 **body 为 null**，客户端据此判断创建失败重试。
3. 设置 `game/nums/gameMode/homeowner`（房主 = 创建者），创建者自动成为第一名成员（`joinRoom`）。
4. **仅单发创建者**，不广播。

### 2.3 响应（MessageType.GAME_ROOM_CREATED，body=GameRoom）

```json
{
  "user": null,
  "body": {
    "id": "143025123",
    "game": "GOBANG",
    "nums": 2,
    "gameMode": null,
    "homeowner": { "id": "u1", "username": "张三", "status": "PLAYING" },
    "users": { "张三": { "id": "u1", "username": "张三", "readied": false } }
  },
  "type": "GAME_ROOM_CREATED",
  "time": "08/27 14:30"
}
```

GameRoom 字段：`id`（房间号）、`game`、`nums`、`gameMode`、`homeowner`（User 房主）、`users`（**Map，key=玩家 username**，value=Player）、`inviteUsers`（transient，不序列化）。
Player 字段：`id`、`username`、`readied`（是否已准备）。

## 3. 房间消息（Action.GAME_ROOM，MessageType.GAME_ROOM）

请求体 `GameRoomMsgDTO`（继承 `GameDTO{roomId, game}`）：`msgType`（MsgType）+ `content`（Object）。

### 3.1 MsgType 枚举

| 常量 | 含义 | 触发方 → 服务端行为 | 广播范围 |
|---|---|---|---|
| `PLAYER_INVITE` | 邀请玩家 | 邀请者发，content=GameInviteDTO；校验后转发 | 定向 |
| `PLAYER_INVITE_RESULT` | 邀请结果 | 被邀请者回，content=GameInviteResultDTO；处理 ACCEPT/REJECT/TIMEOUT/FAILED | 房间内/定向 |
| `PLAYER_LEFT` | 玩家离开 | 玩家发；leftRoom 并广播；若为房主再触发 roomClose | 房间内 |
| `PLAYER_READY` | 玩家准备 | readied=true 并广播 | 房间内 |
| `PLAYER_CANCEL_READY` | 取消准备 | readied=false 并广播 | 房间内 |
| `GAME_START` | 游戏开始 | 全员 readied 重置 false，content 回填整个 gameRoom 后广播 | 房间内 |
| `PLAYER_GAME_STARTED` | 玩家已开始 | **仅转发给房主** | 单发房主 |
| `GAME_OVER` | 游戏结束 | **仅回给发送者本人**（正式结束广播走 Action.GAME_OVER） | 单发 |
| `GAME_ERROR` | 游戏异常 | 服务端生成（房间不存在/已关闭/加入失败等） | 定向 |
| `ROOM_CLOSE` | 房间关闭 | 移除房间并通知 inviteUsers + 房间内成员 | 房间内+已邀 |

### 3.2 服务端前置校验（AbstractGameActionHandler）

- `roomId` 为空 → `GAME_ERROR` content=`"游戏房间不存在！"`；房间不存在 → `"游戏房间已关闭！"`；两种情况均把发送者置 `FISHING` + `updateUserStatus`。
- 例外：`PLAYER_INVITE_RESULT` 且 content.status == `TIMEOUT` → 静默放弃（原房间已关）。
- 房间存在时回填 `body.game = 房间的 game`。

### 3.3 邀请流程（PLAYER_INVITE / PLAYER_INVITE_RESULT）

DTO：
- **GameInviteDTO**：`playerId`（被邀请玩家 id）。
- **GameInviteResultDTO**：`status`（InviteStatus）、`gameRoom`（ACCEPT 成功时回填）、`playerId`（可选）。
- **InviteStatus**：`ACCEPT`（同意）/ `REJECT`（拒绝）/ `TIMEOUT`（超时）/ `FAILED`（失败）。

流程：
1. 邀请者发 `PLAYER_INVITE`（content=GameInviteDTO{playerId}）。
2. 服务端：目标不存在 → SYSTEM "该邀请用户不存在！"；目标状态非 `FISHING` → 直接回 `PLAYER_INVITE_RESULT(REJECT)` + SYSTEM "人家正在X呢！就你天天摸鱼？"；可邀 → 目标置 `PLAYING` + `updateUserStatus`、记入 inviteUsers、向目标发 `PLAYER_INVITE`（user=邀请者）、向邀请者发 SYSTEM "已向X发送《游戏名》游戏邀请！"。
3. 被邀请者回 `PLAYER_INVITE_RESULT`（content=GameInviteResultDTO{status}）。
4. 服务端：
   - `ACCEPT` 且 `joinRoom` 成功 → 回填 `dto.gameRoom`，房间内广播（response.user=被邀请者）。
   - `ACCEPT` 但满员/已在其它房间 → 被邀请者置 FISHING + 收 `GAME_ERROR` "加入游戏失败，游戏房间已满员！"。
   - `REJECT`/`TIMEOUT`/`FAILED` → 被邀请者若为 PLAYING 置 FISHING，通知房主；`TIMEOUT` 额外通知被邀请者。

### 3.4 房间状态与关闭

- 服务端**不存在**房间状态枚举/字段；"等待/对局中/结束"由客户端依据协议消息推断，服务端仅维护成员表与 `readied` 标记。
- 房间从缓存移除只有三种途径：**任意成员发 `ROOM_CLOSE`**、房主离开（`PLAYER_LEFT`）、最后一名成员离开（`leftRoom` 中 `getCurrentNums()==0`）。
- ⚠️ **`GAME_OVER` 不代表房间关闭**：`GameOverActionHandler` 只向房间成员广播 GAME_OVER，从不 `removeRoom`；房间仍在缓存中（`existRoom` 仍为 true），成员仍可继续发 `GAME` 等消息。

### 3.5 ⚠️ 已知缺陷

1. **`ROOM_CLOSE` 无房主/成员身份校验**：任何已加入房间的成员发送 `ROOM_CLOSE` 消息即可关闭整个房间、并把其他成员状态置回 `FISHING`（`close_room` / `close-room` 任意用户可关闭任意房间，即项目 M-2 已知缺陷）。
2. **`GAME_START` 等同样无身份校验**：房主/成员不区分。
3. **`isHomeowner` 无空值防护**：`homeowner.getUsername()` 直接解引用，homeowner 为 null 时 NPE（正常创建流程必设，属防御性缺陷）。
4. **房主离开双路径重置**：`leftRoom` 内先 `removeRoom`，随后 `playerLeft` 再调 `roomClose`（幂等，但会再次广播 `ROOM_CLOSE`）。

（说明：`removeRoom` 中按 `Player.getId()` 清理 `USER_ROOM_MAP` 是与 `joinRoom` 写入 key 一致的必要清理 —— 若不清除，玩家后续会被判定"已在其他房间"而无法再加入新房间。）

## 4. 游戏数据（Action.GAME）与游戏结束（Action.GAME_OVER）

### 4.1 GAME（对局数据）

- Action：`GAME`；MessageType：`GAME`；body：**GameDTO 的子类**（各游戏自定义字段，见 §5）。
- 服务端：房间存在校验 + 回填 `body.game` 后，遍历房间内成员，**除发送者本人外**原样转发（response.user=发送者）。发送者自己收不到回包（本地直接应用）。

> 勘误：`GameDTO` 只有 `roomId` + `game` 两个字段，**没有** gameName/action/data。

### 4.2 GAME_OVER（正式结束广播）

- Action：`GAME_OVER`；MessageType：`GAME_OVER`；body：GameDTO（roomId+game，可携带子类扩展字段）。
- 服务端：遍历房间内所有成员，**含发送者本人**，每人收 `Response(user=发送者, body, type=GAME_OVER)`。

```json
{
  "user": { "id": "u1", "username": "张三", "status": "PLAYING" },
  "body": { "roomId": "143025123", "game": "GOBANG" },
  "type": "GAME_OVER",
  "time": "08/27 14:31"
}
```

## 5. 各游戏 DTO（GAME action 的 body 子类，均继承 GameDTO{roomId, game}）

> 服务端对 `GAME` 消息只做房间内转发，游戏逻辑完全在客户端（插件/前端）实现；以下字段供解析对局消息时参考。

### 5.1 五子棋 GobangDTO

| 字段 | 类型 | 含义 |
|---|---|---|
| `x` | int | 横坐标 |
| `y` | int | 纵坐标 |
| `type` | int | 玩家类型（先手/后手） |

### 5.2 中国象棋 ChessDTO

| 字段 | 类型 | 含义 |
|---|---|---|
| `x` / `y` | int | 坐标 |
| `type` | int | 对战方式：1-红棋 2-黑棋 |
| `index` | int | 棋子索引 |
| `option` | Option | 操作：`SURRENDER`/`UNDO`/`UNDO_CONSENT`/`UNDO_REJECT`/`GAME_OVER`/`CHECK`/`DEFAULT` |
| `currentUI` | UI | 界面模式：`CLASSIC`（经典模式，value=1） |

### 5.3 斗地主 LandlordsGameDTO

| 字段 | 类型 | 含义 |
|---|---|---|
| `msgType` | MsgType | `JOIN_ROBOTS`（加入机器人）/`ALLOC_POKER`（分牌）/`CALL_SCORE`（叫分）/`OUT_POKER`（出牌） |
| `player` | String | 玩家昵称 |
| `data` | Object | 数据内容 |

辅助对象：
- **AllocPokerDTO**：`pokers`（List&lt;Poker&gt; 手牌）、`lastPokers`（List&lt;Poker&gt; 底牌）、`prioritized`（boolean 是否优先叫分）。
- **Poker**：`value`（int，3~10、11=J、12=Q、13=K、14=A、15=2、16=小王、17=大王）、`suits`（`SPADE`黑桃/`HEART`红桃/`DIAMOND`方块/`CLUB`梅花）、`sort`(transient)。
- **PokerInfo**：`pokers`、`pokerModel`（牌型）、`value`（比较值）。
- **PokerModel**：`ROCKET`火箭/`BOMB`炸弹/`SINGLE`单牌/`PAIR`对牌/`THREE`三张/`THREE_ONE_SINGLE`三带一单/`THREE_ONE_PAIR`三带一对/`SHUN_ZI_SINGLE`单顺/`SHUN_ZI_PAIR`对顺/`PLAIN_UNMANNED`无人飞机/`PLAIN_MANNED`载人飞机/`FOUR_TWO_SINGLE`四带两单/`FOUR_TWO_PAIR`四带两对。

### 5.4 爱坤麻将 MahjongGameDto

| 字段 | 类型 | 含义 |
|---|---|---|
| `id` | String | 消息 id |
| `prevId` | String | 上一条消息 id |
| `msgType` | MahjongMsgType | 见下 |
| `player` | String | 玩家昵称 |
| `data` | Object | 数据内容 |
| `isRun` | Boolean | 是否运行中 |

**MahjongMsgType**：`JOIN_ROBOTS`/`ALLOC_MAHJONG`（分牌）/`IDENTIFY_BANKER`（指定庄家）/`OUT_MAHJONG`（出牌）/`GANG`（杠）/`AN_GANG`（暗杠）/`PENG`（碰）/`CHI`（吃）/`HU`（胡）/`HEAD_TOUCH`（从头摸）/`TAIL_TOUCH`（从尾摸）。

### 5.5 UNO UNOGameDto

| 字段 | 类型 | 含义 |
|---|---|---|
| `playerName` | String | 玩家名 |
| `msgType` | MsgType | 见下 |
| `data` | Object | 数据 |
| `actionId` | Integer | 行动 id |

**MsgType**：`REFRESH_TIPS_MSG`/`JOIN_ROBOTS`/`OUT_CARDS`（出牌）/`UNO`/`CATCH`（抓）/`QUESTION`（质疑）/`ALLOC_CARDS`（分牌）/`INIT_ALLOC_CARDS`/`INIT_DISCARD`/`CHANGE_COLOR`（换色）/`PASS`。
**Card**：`id`、`score`、`value`（数字/`CHANGE`/`+2`/`+4`/`REVERSE`/`CLEAR`/`SKIP`）、`color`（红/黄/绿/蓝/黑）、`isFunctionCard`、`changeColor`。

### 5.6 大富翁 MonopolyGameDto

| 字段 | 类型 | 含义 |
|---|---|---|
| `msgType` | MsgType | 见下 |
| `player` | String | 玩家名 |
| `actionId` | Integer | 动作 id |
| `data` | Object | 数据 |

**MsgType**（zillionaire）：`JOIN_ROBOTS`/`PAY_TOLL`（过路费）/`DICE_ROLL`（掷骰）/`BUY_POSITION`（买地）/`UPGRADE_BUILDING`（升级）/`SALE_POSITION`（卖地）/`PAY_TO_BANK`/`TO_JAIL`（进监狱）/`REST`/`DICE_ROLL_AGAIN`/`CHANCE`（机会）/`DESTINY`（命运）/`REFRESH_TIPS`/`TAX`（税）/`BROKE_EXIT`（破产）/`PAY_TO_OTHERS`/`PASS`/`AGAIN_RESULT`/`REMOVE_TEMP_PLAYER`/`PULL_DOWN`（摧毁）。

棋盘格子 DTO（均继承 PositionDto）：
- **PositionDto**：`position`、`isCity`、`allowBuy`、`name`、`color`、`owner`、`upgradeAllowed`、`action`、`positionStatus`（false=待赎回）。
- **CityDto**：`level`、`price`、`zeroToll`~`fifthToll`（0~5 级过路费）、`userId`（拥有者）、`buildMoney`（建造价）。
- **CompanyDto**：`price`（默认 1000）。
- **StationDto**：`level`、`price`、`oneStationPrice`(250)/`twoStationPrice`(500)/`threeStationPrice`(1000)/`fourStationPrice`(2000)。
- **LuckDto**：功能格（不可买）。
- **LuckEntity**：`id`、`title`、`action`、`description`、`type`。

## 6. GameRoomCache 关键行为

| 方法 | 行为 |
|---|---|
| `seize(roomId)` | 已存在返回 null，否则新建入 `GAME_ROOM_MAP` |
| `joinRoom(roomId, user)` | 房间不存在 / 用户已在其它房间 / 满员（`currentNums > nums-1`）→ false；成功写 `USER_ROOM_MAP` |
| `leftRoom(roomId, user)` | 移除玩家；空房间或房主离开 → 同时 `removeRoom` |
| `removeRoom(roomId)` | 清 `GAME_ROOM_MAP` 与 `USER_ROOM_MAP`；inviteUsers + 房间内用户除房主外全部置 FISHING + `updateUserStatus` |
| `getGameRoom / getGameRoomByUserId` | 按 roomId / userId 查房间 |

断线清理（`ChannelAction.cleanUser`）：用户断线时若在房间内，先向其它玩家发 `GAME_ROOM(PLAYER_LEFT)` 并 `leftRoom`，再广播 `OFFLINE`。
