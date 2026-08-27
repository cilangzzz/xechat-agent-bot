# 业务层数据模型参考

> 鱼塘 Agent 业务模块(Session / 聊天 / 工具 / 调度)的核心数据结构速查。
> 侧重"代码里怎么组织 + 字段长啥样", 不重复入口装配细节(见 [README.md](./README.md))。

## 1. 核心实体

### 1.1 Session(每用户, 内存)

挂在 `SessionStore.map` 上, 以 `userKey` 为主键; 包含对话历史、压缩摘要、待办、并发锁。

```
SessionStore {
  map: Map<userKey, Session>
  locks: Map<userKey, Promise>     // 每用户 in-flight / tryLock 队列
  historyMax: number               // 默认 10
  compressAt: number               // 兼容字段(实际由 token 预算触发)
  compressBudgetTokens: number     // 默认 3000
  summaryMaxLen: number            // 默认 800
  ttlMs: number                    // >0 时超过该时长未活跃会被惰性清理
}

Session {
  history: Message[]               // 最近对话, LLM 输入的主要来源
  summary: string                  // 结构化压缩摘要(增量合并)
  todos: TodoItem[]                // 每用户独立待办
  lastActive: number               // Date.now(), 用于 ttlMs 惰性 GC
  compressing: boolean             // 重入锁(防并发压缩)
}

Message { role: 'user' | 'assistant' | 'system', content: string }
```

- `pushUser / pushAssistant`: 追加一条, 自动更新 `lastActive`。
- `_get(userKey)`: 懒加载, 不存在即 `{history:[], summary:'', todos:[], lastActive: now}`。
- `tryLock(userKey)`: 同步非阻塞, 返回 `null` 表示该用户已在处理中(聊天室里后续消息跳过); 返回 release 函数表示拿到了锁。
- `acquire(userKey)`: 异步阻塞版, 把同一用户串行化; 不同用户互不阻塞。
- `maybeCompress(userKey, summarizeFn, opts)`: token 预算式; 把超额 head 交给 LLM 压进 `summary`(增量合并), 保留最近预算内消息(至少 `historyMax` 条)。
- `clear(userKey)`: 清空该用户全部上下文(含待办)。
- 公开的 `get` / `getRawHistory` 返回的是 snapshot/copy, 不会污染内部状态。

### 1.2 pondState(全局, 内存)

`agent.mjs` 第 78 行装配, 全模块共享; 在线状态 + 订阅式游戏房间 + 当前会话聊天记录环形缓冲。

```
pondState {
  onlineUsers: Set<string>           // USER_STATE 增量维护
  snapshotAt: number                 // 最近一次 ONLINE_USERS 全量快照时间
  activeRooms: Map<roomId, Room>     // GAME_ROOM_CREATED/ROOM_CLOSE 增量
  roomLog: Entry[]                   // 环形缓冲(默认 100 条)
}

Room {
  roomId: string
  game: string            // 枚举名: GOBANG / LANDLORDS / ...
  nums: number            // 几人房
  gameMode: string | null // 部分游戏(斗地主等)用, 如 '8局'
  homeowner: string       // 房主 username
  createdAt: number
}

Entry { from: string, self: boolean, content: string, time: number }
```

- `onlineUsers`: `USER_STATE(ONLINE/OFFLINE)` 单点更新; `ONLINE_USERS` 全量快照覆盖(并刷新 `snapshotAt`)。
- `activeRooms`: 服务端**不会主动推全量房间列表** —— 只能靠 `GAME_ROOM_CREATED` 增 + `ROOM_CLOSE` 减; agent 在线时长越久越准, 启动前已存在的房间不会被发现。
- `roomLog`: `pushRoomLog` 只记 `live=true` 的非回放消息; 超过 `cfg.roomLog.maxEntries` 从头部丢弃。**不持久化**, 重启即清零(查历史用 `data/chat-log.jsonl`)。

### 1.3 Memory Fact(磁盘 JSON, 默认关)

`MemoryStore.data` 是 `{ username: Array<Fact> }`; 默认 `ENABLE_MEMORY=0` 完全不读盘不写盘, 工具直接拒绝。

```
Fact { key: string, value: string, at: ISOString }

文件: data/memory.json(JSON, 缩进 2)
去抖: 1s 内多次变更合并写一次
容量: 每用户上限 30 条(maxFactsPerUser, LRU 头出)
key 派生: remember(fact) → 'fact-' + FNV1a(value) 截断 7 字符 → 同值同 key
```

- `_load`: 启动时一次性读, 解析失败静默回 `{}`。
- `_scheduleSave`: 1s 去抖; 关闭/flush 时立即同步写。
- `search(username, query)`: 大小写不敏感, key/value includes; 命中返回末尾 8 条。
- 协议层鱼塘私聊是广播(M-1), 所以持久记忆默认关 —— 别默默开起来敏感信息可能外泄。

### 1.4 Todo(每会话, 内存)

挂在 Session 上(`sess.todos`); 状态机采用 opencode todowrite 风格。

```
TodoItem {
  id: number              // 单调自增(当前 list 中最大 + 1)
  text: string
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
  priority: 'low' | 'normal' | 'high'   // 仅 low/high 才在 list 里加标签显示
  at: number              // Date.now()
}
```

- 工具接口: `todo_list` 只读, `todo_update` 一个 entry 通吃五种 `action: add/done/update/delete/clear`。
- `doneTodo(index)` 切换: 已 `completed` 再调切回 `pending`, 否则标 `completed`。
- `in_progress` 同时只能有 1 条 —— 这一点是 LLM `extra` 提示里的硬约束, 否则会破多步调研范式。
- 上限默认 20 条(`TODO_MAX`), 满则 `add` 报错。
- 状态/优先级越界时静默回退默认值, 不抛错(由 LLM 通过重试纠正)。

### 1.5 Schedule(内存队列 / 可选磁盘)

`Scheduler.queue` 是一次性任务(到点即出队, 不重复)。

```
ScheduleTask {
  id: string              // 'sched_<seq>_<rand>' (seq 单调自增)
  atMs: number            // 触发的绝对时间戳(已过期不入队)
  task: string            // 任务文本(remind 直接发, auto 喂给 LLM)
  to: string | null       // 指定接收 username; null/缺省 = 广播
  mode: 'remind' | 'auto'
  createdAt: number
}

文件(可选): data/schedule.json, ENABLE_SCHEDULE_PERSIST=1 时落盘
tick: 默认 5000ms(setInterval, unref)
```

- `parseDuration('5分钟'|'2小时'|'30秒')` 返回相对毫秒。
- `parseAtTime('18:30'|'18:30:00')` 返回今天或明天的绝对毫秒(已过期 → 第二天)。
- 过期任务在 `_load` 时不恢复; 周期内落盘的 `seq` 续接以防 id 冲突。

### 1.6 ChatLog Entry(JSONL, 每行一条)

跨重启可查的持久日志, `data/chat-log.jsonl`。

```
Entry { from: string, self: boolean, content: string, time: number }

写入: live=true 的聊天消息, content 截断到 300 字符
读取: readRecent(n, {from?}) → 末尾 n 条(≤200); 行级 try/catch, 坏行吞掉
裁剪: 文件 ≥ 64KB 才检查; 超出 maxEntries(默认 1000) 从头砍到上限
关闭: DISABLE_CHAT_LOG=1 完全停写停读
```

`recent_messages` 工具读的是 `pondState.roomLog`(内存, 仅当前连接); `chat_log` 工具读的是这里(磁盘, 跨重启)。两个是互补不是替代。

### 1.7 工具调用消息格式

工具侧参数统一用 `defineTool({id, description, parameters, run})`, `parameters` 是标准 JSON Schema。

```
ToolResult = Record<string, any>          // 给 LLM 看的 JSON
异常: { error: '人类可读字符串' }         // 不抛异常, LLM 读 error 继续
截断: stdout ≤4000 字符, stderr ≤2000, fetch 文本 ≤4000
超时: python 15000ms 默认; web 15000ms; sendup 90000ms
Python 安全护栏: 6 类正则, 命中即拒(执行系统命令 / 动态执行 / 探主机 / 破坏性文件 / 敏感文件 / 下载写盘)
预算(budget): token 估算阈值, 超限截断; LLM 主回合有 maxIterations(默认 8)
```

子智能体委托 (`delegate`) 返回结构:

```
<task state="completed">
  {结论文本}
</task>
```

失败则 `delegate` 的 result 形如 `{error: '子智能体「explore」失败: ...'}`(LLM 看到后继续推).

### 1.8 WS 消息帧

所有服务端→客户端 / 客户端→服务端消息都走单条文本帧(action=1), JSON payload:

```
客户端→服务端: {"action":"LOGIN", "body":{...}} | {"action":"HEARTBEAT"} | {"action":"CREATE_GAME_ROOM", "body":{...}} ...
服务端→客户端: {"action":"USER_STATE", "body":{user:{username}, state:"ONLINE|OFFLINE"}} 
              | {"action":"ONLINE_USERS", "body":{userList:[{username,...}]} | [..直] } 
              | {"action":"GAME_ROOM_CREATED", "body":{id,game,nums,gameMode,homeowner:{username,...}}} 
              | {"action":"GAME_ROOM", "body":{roomId, msgType:"ROOM_CLOSE|GAME_ERROR"}} 
              | {"action":"SYSTEM", "body":"欢迎 xxx | 重复登录 | 黑名单..." } 
              | {"action":"CHAT/USER", "body":{content, msgType?, toUsers?, user?:{username}}}
```

- 登录发包 `_bytes_` 严格: `username, status, platform:'WEB', uuid:'web-<rand>', pluginVersion:'', reconnected:false`。
- HEARTBEAT 不带 body(只有 `action`)。
- `sendActionAndWait(action, body, {match, timeoutMs})`: 排队匹配; 第一个 `match(m,t,body)=true` 命中即 resolve, 默认 8s 超时。
- 协议层鱼塘 `toUsers` 是广播(带目标标记), 不是真私密(M-1); 别在回复里发敏感信息。
- 登录成功标志: 服务端推 `USER_STATE + state=ONLINE + user.username == opts.username`。在这之前的帧视为登录回放(`replaySkipMs` 默认 2s), router 会跳过。

## 2. 实体关系

```
                  ┌─────────────────────────┐
                  │       pondState         │   (全局, 模块单例)
                  │  onlineUsers/activeRooms│
                  │  roomLog (环形 100)     │
                  └────────────┬────────────┘
                               │ 提供数据(room_stats/recent_messages/list_rooms)
                               ▼
   ┌──────────────┐    订阅/广播    ┌──────────────────────┐
   │  WsClient    │◄──────────────►│  chat-log.jsonl      │  (持久 JSONL)
   │ (连接层)     │   LIVE 消息     │  ChatLog / chat_log  │
   └──────┬───────┘                 └──────────────────────┘
          │ onMessage
          ▼
   ┌─────────────────────────────┐
   │  agent.mjs 主循环           │
   │  - 登录回放过滤             │
   │  - per-user tryLock         │
   │  - 触发器 batch 检测        │
   └──────┬──────────────────────┘
          │ router.handle / handleMention
          ▼
   ┌─────────────────┐                  ┌──────────────────┐
   │     Router      │  维护             │   SessionStore   │
   │ (确定性内置+LLM) │◄────────────────►│  Session[]/locks │
   └────┬──────┬────┘                  │  history/summary │
        │      │                       │  todos (TodoItem)│
        │      └─ tool call ─┐         └──────────────────┘
        ▼                    ▼
   ┌────────────┐     ┌────────────────┐    ┌─────────────┐
   │  ToolReg   │     │ MemoryStore    │    │ Scheduler   │
   │ (25 工具)  │     │ (JSON, 默认关) │    │ (map/可选盘)│
   └────┬───────┘     └────────────────┘    └─────────────┘
        │ 委托
        ▼
   ┌──────────────────────────┐
   │ 子智能体 explore / math  │ (自带独立 SessionStore / tools)
   │  受 subagentDepth 限制   │
   └──────────────────────────┘
```

### 关系要点

- `UserKey` 是大多数内存结构的隐式主键: Session / Memory / Todo / Scheduler.to。
- 协议 `from` 字段时间是 `m.user?.username || body.user?.username || '?'`, 缺省 `'?'` 时 `pushRoomLog` 跳过、`@提及` 命中失败。
- `roomLog` 和 `chat-log.jsonl` 是同一份信息的两种存储: 一个内存快查(连接后 + 重启即丢)、一个磁盘慢查(跨重启 + 上限 1000 条)。

## 3. 容量与上限速查

| 项 | 默认值 | 控制变量 | 来源 |
|---|---|---|---|
| Session.history(每用户) | 10 条 | `historyMax` / `compaction.budgetTokens` | sessions.mjs / config.mjs |
| Session.summary | ≤800 字符 | `summaryMaxLen` | sessions.mjs |
| Memory 事实(每用户) | 30 条 | `memory.maxFactsPerUser` | config.mjs |
| Todo(每会话) | 20 条 | `TODO_MAX` | config.mjs |
| roomLog 内存 | 100 条 | `cfg.roomLog.maxEntries` | agent.mjs |
| chat-log.jsonl | 1000 条 | `CHAT_LOG_MAX` | config.mjs |
| send_file | 50MB | `SENDUP_MAX_BYTES` | config.mjs |
| 工具超时(Python / web / sendup) | 15s / 15s / 90s | `python.timeoutMs` 等 | config.mjs |
| 回复分片 | 200 字符 | `MSG_MAX_LEN` | config.mjs(reply.mjs) |
| 子智能体嵌套 | 1 层 | `SUBAGENT_DEPTH` | config.mjs |
