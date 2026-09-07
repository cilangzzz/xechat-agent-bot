# 周边工具模块业务文档

> **2026-08-27 重构** (commit `98b006a`): `lib/` 拆分为 `lib/foundation/` `lib/business/` `lib/platform/` 三层
> - lib/business/: 业务逻辑 (router / sessions / agents / persona / trigger / skill-* / todo / memory / scheduler / chat-log)
> - lib/platform/: 外部平台对接 (xechat-api / web / python-runner / sendup / minimax-image / pond-probe)
> - lib/foundation/: 底层 (ws-client / llm / tool-core / ...)

本文档覆盖 `agent/lib/business/` 和 `agent/lib/platform/` 下未单独建 README 的"周边工具"模块。每个子模块的字段格式统一, 便于横比。

---

## 1. todo —— 每会话待办 (lib/business/todo.mjs)

### 职责

挂在 `SessionStore` 会话对象上的**纯内存**待办列表, 为当前 LLM 对话提供任务追踪能力, 风格对齐 opencode 的 todowrite。

### 关键 API

| 导出符号 | 签名 | 行为 |
|---|---|---|
| `TODO_STATUS` | `const` | 状态枚举 `{pending, in_progress, completed, cancelled}` 的中文标签 |
| `initTodos(sess)` | `(sess) => Array` | 懒初始化 `sess.todos`, 返回数组 |
| `addTodo(sess, text, maxItems=20, priority='normal')` | 返回 `{ok, list}` 或 `{error}` | 追加一条, ID 自增 (max+1) |
| `listTodos(sess)` | 返回格式化字符串 | 渲染所有项 |
| `doneTodo(sess, index)` | 序号 (1 起) | 已 completed → 切回 pending; 否则标 completed |
| `updateTodo(sess, index, patch)` | `patch = {status, text, priority}` | 部分更新; 非法字段静默忽略 |
| `deleteTodo(sess, index)` | 序号 | splice 删除 |
| `clearTodos(sess)` | — | 清空数组 |
| `todosAsJson(sess)` | 返回原始数组 | 给 LLM 工具结果用的结构化视图 |

### 配置项

- **`TODO_MAX`** = 20: 单次 `addTodo` 调用传入, 也可在工具层重新覆盖 (`addTodo(sess, text, 30)`)
- `priority` 取值: `low | normal | high` (非法值回退到 `normal`)
- `status` 取值: `pending | in_progress | completed | cancelled` (通过 `updateTodo` 设置)

### 数据格式

```js
// sess.todos (数组, 每条结构)
{
  id: Number,           // 自增, 从 1 起; 删除后不复用
  text: String,         // 已 trim
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled',
  priority: 'low' | 'normal' | 'high',
  at: Number,           // Date.now()
}
```

### 坑点

1. **纯内存, 不落盘** —— 进程重启后待办清空 (与会话一起丢失)。若需持久化由上层 (SessionStore/agent.mjs) 自行序列化。
2. **ID 不复用** —— `addTodo` 用 `Math.max(...ids) + 1` 计算, 删除中间项后再添加, ID 不会回填空位, 显示序号按 `formatList` 重排。
3. **`updateTodo` 的非法字段静默忽略** —— 不报错, 调试时容易误以为生效了。
4. **`doneTodo` 是 toggle** —— 已 completed 再调会切回 pending, 语义不是单向完成。
5. **`addTodo` 第二个参数 `maxItems`** —— 默认 20, 但调用方若传 `0` 会触发"已达上限"; 想无限可在调用层传大数。

---

## 2. memory —— 持久用户事实 (lib/business/memory.mjs)

### 职责

按用户持久化对话中暴露的关键事实 (昵称/爱好/偏好), 重启后仍可被 `remember/recall` 工具读取。**默认关闭** (`ENABLE_MEMORY=0`), 因聊天室消息实际是广播, 持久记忆有隐私风险。

### 关键 API

`export class MemoryStore`

| 方法 | 签名 | 行为 |
|---|---|---|
| `constructor({file, enabled, maxFactsPerUser=30})` | — | `enabled=false` 时不读盘也不存盘 |
| `get(username)` | 返回 `Array<{key, value, at}>` | 取某用户全部事实 |
| `set(username, key, value)` | — | **同名 key 覆盖**; 超 `maxFactsPerUser` 时 `shift` 丢最旧 |
| `remember(username, fact)` | 返回 `{key, value}` 或 `null` | 无 key 时用 FNV-1a 哈希 `fact` 生成稳定 key (`fact-<base36>`) |
| `search(username, query)` | 返回最多 8 条 | 大小写不敏感, 匹配 key 或 value 的子串 |
| `flush()` | — | 立即落盘 (取消去抖 timer) |

### 配置项

- **`ENABLE_MEMORY`** = 0 (默认关) → 1 开启; 开启需管理员明确配置
- **`maxFactsPerUser`** = 30: 单用户最大事实数, 超限 FIFO 淘汰
- **去抖窗口** = 1000ms (`_scheduleSave` 的 setTimeout)

---

## 3. scheduler —— 定时任务 (lib/business/scheduler.mjs)

### 职责

注册到点发送的提醒任务或自动生成任务。仅支持一次性 (`remind` / `auto`), 不支持 cron 周期。

### 关键 API

| 导出符号 | 签名 | 行为 |
|---|---|---|
| `createScheduler({enabled, log})` | — | 构造; `enabled=false` 时所有 add/list 返回 `{error: '定时任务未开启'}` |
| `add({task, mode, inMinutes?, atTime?, to?})` | 返回 `{id, atMs, estimated}` 或 `{error}` | 新增任务 |
| `list()` | 返回 `{count, tasks[]}` | 列出未到期任务 |
| `cancel(id)` | 返回 `{ok}` 或 `{error}` | 取消任务 |
| `tick()` | 每 30s 调一次 | 检查到期任务, 触发后从队列移除 |

### 模式

| `mode` | 行为 |
|---|---|
| `remind` | 到点直接发 `task` 文本到 `to` 用户 |
| `auto` | 到点调 LLM 生成内容再发 |

### 时间格式

| 参数 | 格式 | |
|---|---|---|
| `inMinutes` | 数字 (分钟) | 相对当前时间 |
| `atTime` | `HH:MM` (24h) | 当日 (已过则次日) |

### 坑点

1. **重启丢任务** —— 调度器纯内存, 进程重启后未触发的任务丢失。需要持久化要重启时从 JSON 重新注册。
2. **`atTime` 已过则次日** —— 早上 8 点注册 `atTime: '07:00'`, 实际触发是明天 7 点。
3. **`tick` 周期 30s** —— 触发误差最大 30s (调小会浪费, 调大会迟)。

---

## 4. chat-log —— 聊天日志 (lib/business/chat-log.mjs)

### 职责

把每条聊天消息持久化为 JSONL (`log/chat-log-<date>.jsonl`), 跨重启可被 `chat_log` 工具查询。

### 关键 API

| 导出符号 | 签名 | 行为 |
|---|---|---|
| `createChatLog({enabled, dir, maxLinesPerFile=200})` | — | 构造 |
| `append({from, content, roomId, isPrivate})` | 异步落盘 | 一条 JSON 一行 |
| `readRecent({n, from?})` | 返回 `{count, total, messages[]}` | 读最近 N 条 |
| `count()` | 返回总条数 | |
| `flush()` | 立即落盘 | 取消去抖 timer |

### 配置项

- **`ENABLE_CHAT_LOG`** = 0 → 1 开启
- **`CHAT_LOG_DIR`** = `agent/log/chat-log/` (默认)
- **`CHAT_LOG_MAX_LINES`** = 200: 单文件行数上限, 满了轮转

---

## 5. trigger —— 主动消息触发器 (lib/business/trigger.mjs)

### 职责

在多人对话中, 当 bot 看到"足够有趣"的发言时, 主动插一句话 (不依赖被 @)。由 `ENABLE_TRIGGER=1` 开启, 默认关。

### 关键 API

| 导出符号 | 签名 | 行为 |
|---|---|---|
| `createTrigger({enabled, intervalMs, minParticipants, ...})` | — | 构造 |
| `tick(roomLog)` | 返回 `null` 或 `{reply, reason}` | 检查是否要主动插话 |
| `recordReply(user)` | 记录本轮我已发话 | 用于冷却 |

### 触发条件 (满足任一即触发)

- 同一用户连续 ≥3 条聊天, 内容相似度 > 0.6 → "复读机" 主动怼回去
- 房间内 ≥ 5 个不同用户发言后, 我上一条消息 ≥ 30 分钟前 → "氛围" 主动发
- 看到关键词 (金价 / 行情 / 涨跌) → "热点" 主动发

### 与 persona.mjs 的区别

| 项 | trigger.mjs | persona.mjs |
|---|---|---|
| 角色 | **发起者** (我主动插话) | **被回应的角色** (别人 @ 我) |
| 默认 | `ENABLE_TRIGGER=0` (默认关) | `ENABLE_PERSONA=1` (默认开) |
| 用途 | 大众版 bot 提升活跃度 | 拟人化回复 |

详见 [persona.md §7](./persona.md#7-与-triggermjs-的区别)。

---

## 6. agent —— 平台对接 (lib/platform/)

> lib/platform/ 是 2026-08-27 重构引入的**外部平台对接层**, 跟业务逻辑解耦。

### 6.1 xechat-api.mjs (HTTP 客户端)

| API | 用途 | 端点 |
|---|---|---|
| `serverList()` | 鱼塘服务器列表 | `GET /api/server/list` |
| `gameList()` | 游戏列表 | `GET /api/game/list` |
| `gameDetail({id, name})` | 游戏详情 | `GET /api/game/detail` |
| `leaderboard({game, limit})` | 排行榜 | `GET /api/leaderboard` |
| `goldPrice()` | 实时金价 | `GET /api/gold/price` |
| `recentGoldDays(n)` | 历史金价 | `GET /api/gold/recent` |

底层封装 fetch + proxy + 超时 + JSON 解析。详见 [lib/platform/xechat-api.mjs](../../../agent/lib/platform/xechat-api.mjs)。

### 6.2 web.mjs (联网搜索 / 抓 URL / 金价)

| API | 用途 |
|---|---|
| `webSearch(query, opts)` | Bing 搜索 |
| `fetchUrl(url, opts)` | 抓 URL HTML → 纯文本 |
| `goldPrice()` | 实时金价 (与 xechat-api.goldPrice 类似, 走不同源) |

`DISABLE_WEB=1` 时三个 API 返回 `{error: '联网功能已关闭'}`。

### 6.3 python-runner.mjs (Python 沙箱)

| API | 用途 |
|---|---|
| `runPython(code, opts)` | 沙箱执行 Python (print 即结果) |

**安全护栏** (`PY_BLOCK_RE` 静态拒绝): 见 [tools.md §3.2](./tools.md#32-计算-computemjs)。

### 6.4 sendup.mjs (sendup.cc 文件分享)

| API | 用途 |
|---|---|
| `upload(content, opts)` | sendup.cc 三步上传 (获取 token → 上传 → 返回 share_url) |

50MB 上限。**注**: 已被 [tools/image.mjs `upload_image`](./tools.md#312-图像-imagemjs-受-minimax-工具网关门控) 部分替代, sendup 代码保留在 git 历史。

### 6.5 minimax-image.mjs (Minimax 图像生成网关)

| API | 用途 |
|---|---|
| `generateImage(prompt, opts)` | 文生图 (Minimax 网关) |

需 `MINIMAX_IMAGE_GATEWAY_URL` 配置。

### 6.6 pond-probe.mjs (跨鱼塘探测)

| API | 用途 |
|---|---|
| `probePond({host, port})` | 探测指定鱼塘的在线情况 |

**防自探测护栏**: `host:port == config.host:port` → 拒绝 (避免 bot 探测自己)。底层走 WS 协议 (`LOGIN` 后看 `USER_STATE`)。