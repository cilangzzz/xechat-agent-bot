# tools.mjs — 工具注册表

> 路径: `agent/lib/tools.mjs` (626 行)
> 参考: opencode tool 体系
> 框架: `lib/tool-core.mjs` (`defineTool` + `ToolRegistry`)

工具注册表集中管理所有 LLM 可调用的"动作"。每个工具通过 `defineTool` 统一获得: 参数校验、输出截断、状态回调。

---

## 1. 注册表结构

### 导出

```js
export function createRegistry(registryCtx = {}) { ... }  // 构造注册表(注册全部内置工具)
export { ToolRegistry };                                  // 框架本体(可独立实例化)
```

### `createRegistry(ctx)` 返回

- `reg.register(toolDef)` — 注册一个 `defineTool(...)` 描述的工具
- `reg.get(id)` — 取工具定义
- `reg.list()` — 列出全部工具 ID 与 schema
- `reg.invoke(id, params, extra)` — 真正执行(由 `tool-core.mjs` 提供)

### 依赖注入 (registryCtx)

`Router` 在构造时把运行时引用注入 ctx, 工具运行期通过闭包访问:

| 字段 | 用途 | 来源模块 |
|---|---|---|
| `startTime` | 启动时刻, 用于 `uptime` | `agent.mjs` |
| `sessions` | 用户会话 Map (含 todos) | `sessions.mjs` |
| `pondState` | 平台运行时状态 (在线/房间/房间日志) | `agent.mjs` |
| `api` | 鱼塘 HTTP 客户端 (gameList/leaderboard 等) | `xechat-api.mjs` |
| `proxy` | HTTP 代理 | `config.mjs` |
| `python` | `{ timeoutMs, cmd }` | `config.mjs` |
| `web` | `{ enabled, timeoutMs }` | `config.mjs` |
| `memory` | `{ enabled, remember, search }` | `memory.mjs` |
| `skills` | `{ enabled }` | `skills.mjs` |
| `scheduler` | `{ enabled, add, list }` | `scheduler.mjs` |
| `sendup` | `{ enabled, upload }` | `sendup.mjs` |
| `chatLog` | `{ enabled, readRecent, count }` | `chat-log.mjs` |
| `ws` | WS 客户端 `{ sendActionAndWait }` | `ws-client.mjs` |
| `delegate(opts)` | 子代理委托通道 | `router.mjs` |
| `subagentDepth` | 子代理最大嵌套层数 | `config.mjs` |
| `todo` | `{ maxItems }` | `config.mjs` |
| `status(msg)` | 状态回调 (UI 提示) | Router |
| `from` | 默认发起人 (会话级) | Router |

---

## 2. 工具分类清单

### 2.1 基础状态

| 工具 ID | 分类 | 用途 | 参数 | 返回 | 风险 |
|---|---|---|---|---|---|
| `now` | 状态 | 服务器当前时间 | `{}` | `{time}` | 无 |
| `uptime` | 状态 | agent 已运行时长 | `{}` | `{uptime}` | 无 |
| `room_stats` | 平台 | 在线人数 + 用户名 | `{}` | `{online_count, online_users}` | 无 |
| `session_stats` | 平台 | 当前活跃会话数 | `{}` | `{active_sessions}` | 无 |

### 2.2 计算

| 工具 ID | 用途 | 参数 | 返回 | 风险 |
|---|---|---|---|---|
| `python` | 沙箱执行 Python (print 即结果) | `{code}` | `{exitCode, stdout, stderr, timedOut?}` | **静态审计 + 运行时拦截** 双重防护 |

**安全护栏** (`PY_BLOCK_RE` 静态拒绝):
- 系统命令 (subprocess / os.system / spawn / shell=True)
- 动态执行 (eval / exec / __import__ / compile)
- 探测服务器 (os.environ / platform / socket / psutil / uuid.getnode)
- 破坏性操作 (shutil.rmtree / os.remove / taskkill / shutdown / reg add)
- 敏感文件读取 (/etc/passwd / .env / C:\Windows)
- 下载大文件 (urlretrieve)

### 2.3 联网

| 工具 ID | 用途 | 参数 | 返回 | 风险 |
|---|---|---|---|---|
| `web_search` | Bing 搜索 | `{query}` | `{count, results: [...]}` | 走 `ctx.proxy` |
| `fetch_url` | 抓 URL HTML → 纯文本 | `{url}` | `{status, text}` (截断 4000) | HTML 解析 |
| `gold_price` | 今日国际/人民币金价 | `{}` | 实时数据 | 外部接口 |

**注**: `DISABLE_WEB=1` 时三个联网工具均返回 `{error: '联网功能已关闭'}`。

### 2.4 多智能体

| 工具 ID | 用途 | 参数 | 返回 | 风险 |
|---|---|---|---|---|
| `delegate` | 委派子智能体 | `{agent: 'explore'\|'math', task}` | `<task state="completed">...</task>` | **嵌套深度上限** |

详见 `multi-agent.md`。`delegate` 超出 `subagentDepth` (默认 1) 直接拒绝。

### 2.5 待办 (会话级)

| 工具 ID | 用途 | 参数 | 返回 | 风险 |
|---|---|---|---|---|
| `todo_list` | 列/初始化清单 | `{}` | `{items}` | 无 |
| `todo_update` | 维护清单 | `{action, text?, index?, status?, priority?}` | `{list}` 或 `{error}` | `maxItems` 默认 20 |

`action` ∈ `add / done / update / delete / clear`; 状态 ∈ `pending / in_progress / completed / cancelled`; 优先级 ∈ `low / normal / high`。

### 2.6 记忆 (受 ENABLE_MEMORY 门控)

| 工具 ID | 用途 | 参数 | 返回 | 风险 |
|---|---|---|---|---|
| `remember` | 持久化用户事实 | `{fact}` | `{ok, stored}` | **默认关闭** (`ENABLE_MEMORY=1`) |
| `recall` | 按关键字查询事实 | `{query?}` | `{facts[]}` | **默认关闭** |

### 2.7 房间 (鱼塘游戏)

| 工具 ID | 用途 | 参数 | 返回 | 风险 |
|---|---|---|---|---|
| `create_room` | CREATE_GAME_ROOM | `{game, nums?, gameMode?}` | `{roomId, game, nums, gameMode, homeowner}` | 中文别名 / 枚举名双接受 |
| `close_room` | GAME_ROOM 关闭 | `{roomId}` | `{closed, roomId}` | **M-2 越权: 任何房间 ID 都可关闭** |
| `list_rooms` | 列活动房间 | `{game?, limit?}` | `{total, byGame, rooms[]}` | **订阅增量** (启动前房间不可见) |

**GAME_ALIAS** 表 (中文 ↔ 枚举名): 五子棋/GOBANG、斗地主/LANDLORDS、不贪吃蛇/NON_GLUTTONOUS_SNAKE、2048/GAME_2048、数独/SUDOKU、推箱子/PUSH_BOX、中国象棋/CHINESE_CHESS、俄罗斯方块/TETRIS、扫雷/MINESWEEPER、爱坤大乐斗/IKUN、大富翁/MONOPOLY、爱坤麻将/MAHJONG。

### 2.8 定时

| 工具 ID | 用途 | 参数 | 返回 | 风险 |
|---|---|---|---|---|
| `schedule` | 注册一次性任务 | `{task, mode, inMinutes?/atTime?, to?}` | `{id, atMs, estimated}` | `DISABLE_SCHEDULE=1` 关闭 |
| `list_schedules` | 查未到期任务 | `{}` | `{count, tasks[]}` | 同上 |

`mode` ∈ `remind` (到点发文本) / `auto` (到点自动生成再发)。

### 2.9 聊天记录

| 工具 ID | 用途 | 参数 | 返回 | 风险 |
|---|---|---|---|---|
| `recent_messages` | 当前会话内存 (仅连接后) | `{n?}` | `{count, messages[]}` | 上限 30 |
| `chat_log` | 持久化日志 (跨重启) | `{n?, from?}` | `{count, total, messages[]}` | JSONL 持久化, 上限 200 |

### 2.10 文件 / 平台

| 工具 ID | 用途 | 参数 | 返回 | 风险 |
|---|---|---|---|---|
| `send_file` | sendup.cc 三步上传 | `{content, filename, is_binary?, mime_type?, password?, expire_minutes?}` | `{share_url, filename, file_size, mime_type, expires_at}` | 50MB 上限 |
| `room_stats` | 在线用户 (重复, 见 2.1) | — | — | — |

### 2.11 技能 (受 DISABLE_SKILLS 门控)

| 工具 ID | 用途 | 参数 | 返回 |
|---|---|---|---|
| `skill` | 加载技能包 | `{name}` | `{loaded, instruction}` |

详见 `skills.md`。

---

## 3. 预算 (budget)

`defineTool` 支持 `budget` 字段(**字符串输出最大字符数**, 超出截断, 默认 4000, 详见 `tool-core.md` §3), 防止单个工具回填把上下文撑爆。**不是超时** —— 执行超时由各模块自己的 `timeoutMs` 控制 (如 `python-runner.timeoutMs`)。每个工具单独配置, 常见值:

- `python`: 4000 (实际超时由 `python-runner.timeoutMs` 控制, 默认 15000)
- `web_search` / `fetch_url`: 6000
- `create_room` / `close_room` / `todo_update`: 4000
- `delegate` / `send_file`: 8000

---

## 4. MOCK 行为

> 路径: `agent/lib/tool-core.mjs` (不在本文档范围)

测试模式下, 工具运行由 mock 替换:

| 环境变量 | 影响 |
|---|---|
| `MOCK_LLM=1` | LLM 返回固定剧本 (不调真实 API), 工具仍真实执行 |
| `MOCK_TOOLCALL=1` | 工具调用的最终结果由 mock 替换, 便于离线回归 |

`MOCK_LLM=1 npm start` 是仓库默认的离线自测命令。详见 `.claude/docs/testing/README.md`。

---

## 5. 新增工具 checklist

1. 在 `tools.mjs` 内 `reg.register(defineTool({...}))`
2. 若需列入子智能体白名单, 同步更新 `agents.mjs` 的 `tools` 数组
3. 若为强副作用工具 (写磁盘/外网 POST), 默认 `DISABLE_*` 关闭, 通过 ctx 判断 `enabled`
4. 在 `M-2 越权` 等风险表里登记 (`close_room` 当前是已知风险)
5. 测试: `agent/test/test-*.mjs` 加 mock 用例