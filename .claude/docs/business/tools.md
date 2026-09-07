# lib/business/tools/ — 工具注册表 (16 模块拆分)

> **路径**: `agent/lib/business/tools/` (2026-08-27, commit `98b006a` 拆分自原 `lib/tools.mjs`)
> **入口**: [tools/index.mjs](../../../agent/lib/business/tools/index.mjs)
> **框架**: [lib/foundation/tool-core.mjs](../foundation/tool-core.md) (`defineTool` + `ToolRegistry`)
> **参考**: opencode tool 体系

工具注册表集中管理所有 LLM 可调用的"动作"。原单文件 `lib/tools.mjs` (626 行) 拆分为 16 个独立模块, 每个模块导出 `buildXxxTools(ctx)` 返回 `defineTool` 对象数组; `index.mjs` 组装全部。

---

## 1. 注册表结构

### 导出

```js
// tools/index.mjs
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
| `api` | 鱼塘 HTTP 客户端 (gameList/leaderboard 等) | `lib/platform/xechat-api.mjs` |
| `proxy` | HTTP 代理 | `config.mjs` |
| `python` | `{ timeoutMs, cmd }` | `lib/platform/python-runner.mjs` |
| `web` | `{ enabled, timeoutMs }` | `lib/platform/web.mjs` |
| `memory` | `{ enabled, remember, search }` | `lib/business/memory.mjs` |
| `skills` | `{ enabled }` | `lib/business/skills.mjs` |
| `scheduler` | `{ enabled, add, list }` | `lib/business/scheduler.mjs` |
| `ws` | WS 客户端 `{ sendActionAndWait }` | `lib/foundation/ws-client.mjs` |
| `delegate(opts)` | 子代理委托通道 | `router.mjs` |
| `subagentDepth` | 子代理最大嵌套层数 | `config.mjs` |
| `todo` | `{ maxItems }` | `config.mjs` |
| `chatLog` | `{ enabled, readRecent, count }` | `lib/business/chat-log.mjs` |
| `host`, `port` | 当前鱼塘主机/端口 (probe_pond 防自探测护栏) | `config.mjs` |

---

## 2. 模块清单 (16 个 build* 函数)

| 模块 | 工具 ID | 类别 |
|---|---|---|
| [state.mjs](../../../agent/lib/business/tools/state.mjs) | `now`, `uptime`, `room_stats`, `session_stats` | 基础状态 |
| [compute.mjs](../../../agent/lib/business/tools/compute.mjs) | `python` | 计算 |
| [web.mjs](../../../agent/lib/business/tools/web.mjs) | `web_search`, `fetch_url`, `gold_price` | 联网 |
| [platform.mjs](../../../agent/lib/business/tools/platform.mjs) | `server_list`, `probe_pond` | 平台探测 |
| [game.mjs](../../../agent/lib/business/tools/game.mjs) | `games`, `game_detail`, `create_room`, `close_room`, `list_rooms` | 房间 |
| [delegate.mjs](../../../agent/lib/business/tools/delegate.mjs) | `delegate` | 多智能体 |
| [todo.mjs](../../../agent/lib/business/tools/todo.mjs) | `todo_list`, `todo_update` | 待办 |
| [memory.mjs](../../../agent/lib/business/tools/memory.mjs) | `remember`, `recall` | 记忆 |
| [skill-list.mjs](../../../agent/lib/business/tools/skill-list.mjs) | `skill_list` | 技能 (4 拆分) |
| [skill-get.mjs](../../../agent/lib/business/tools/skill-get.mjs) | `skill_get` | 技能 |
| [skill-install.mjs](../../../agent/lib/business/tools/skill-install.mjs) | `skill_install`, `skill_uninstall` | 技能 |
| [skill-search.mjs](../../../agent/lib/business/tools/skill-search.mjs) | `skill_search` | 技能 |
| [scheduler.mjs](../../../agent/lib/business/tools/scheduler.mjs) | `schedule`, `list_schedules` | 定时 |
| [chat.mjs](../../../agent/lib/business/tools/chat.mjs) | `recent_messages`, `chat_log` | 聊天记录 |
| [probe.mjs](../../../agent/lib/business/tools/probe.mjs) | `probe_pond` (跨鱼塘探测) | 平台 |
| [image.mjs](../../../agent/lib/business/tools/image.mjs) | `generate_image`, `upload_image` | 图像 |

**已废弃**: `send_file` (由 `upload_image` 替代)。代码保留在 git 历史里; 如确需 password/expiry 等 sendup.cc 特性, 可在未来重新从 git history 提取。

---

## 3. 工具分类清单 (按类别)

### 3.1 基础状态 (state.mjs)

| 工具 ID | 用途 | 参数 | 返回 | 风险 |
|---|---|---|---|---|
| `now` | 服务器当前时间 | `{}` | `{time}` | 无 |
| `uptime` | agent 已运行时长 | `{}` | `{uptime}` | 无 |
| `room_stats` | 在线人数 + 用户名 | `{}` | `{online_count, online_users}` | 无 |
| `session_stats` | 当前活跃会话数 | `{}` | `{active_sessions}` | 无 |

### 3.2 计算 (compute.mjs)

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

### 3.3 联网 (web.mjs)

| 工具 ID | 用途 | 参数 | 返回 | 风险 |
|---|---|---|---|---|
| `web_search` | Bing 搜索 | `{query}` | `{count, results: [...]}` | 走 `ctx.proxy` |
| `fetch_url` | 抓 URL HTML → 纯文本 | `{url}` | `{status, text}` (截断 4000) | HTML 解析 |
| `gold_price` | 今日国际/人民币金价 | `{}` | 实时数据 | 外部接口 |

**注**: `DISABLE_WEB=1` 时三个联网工具均返回 `{error: '联网功能已关闭'}`。底层实现已从 `lib/web.mjs` 移到 [lib/platform/web.mjs](../../../agent/lib/platform/web.mjs)。

### 3.4 平台探测 (platform.mjs + probe.mjs)

| 工具 ID | 用途 | 参数 | 返回 | 风险 |
|---|---|---|---|---|
| `server_list` | 鱼塘服务器列表 | `{}` | `{servers: [...]}` | 外部接口 |
| `probe_pond` | 探测鱼塘 | `{host, port}` | `{host, port, online_users}` | **防自探测护栏**: host == config.host → 拒绝 |

`probe.mjs` 是 `probe_pond` 的早期版本, 详见 [lib/platform/pond-probe.mjs](../../../agent/lib/platform/pond-probe.mjs)。

### 3.5 房间 (game.mjs)

| 工具 ID | 用途 | 参数 | 返回 | 风险 |
|---|---|---|---|---|
| `games` | 游戏列表 | `{}` | `{total, games: [...]}` | 无 |
| `game_detail` | 单游戏详情 | `{id?, name?}` | `{name, version, online, ...}` | 无 |
| `create_room` | CREATE_GAME_ROOM | `{game, nums?, gameMode?}` | `{roomId, game, nums, gameMode, homeowner}` | 中文别名 / 枚举名双接受 |
| `close_room` | GAME_ROOM 关闭 | `{roomId}` | `{closed, roomId}` | **M-2 越权: 任何房间 ID 都可关闭** |
| `list_rooms` | 列活动房间 | `{game?, limit?}` | `{total, byGame, rooms[]}` | **订阅增量** (启动前房间不可见) |

**GAME_ALIAS** 表 (中文 ↔ 枚举名): 五子棋/GOBANG、斗地主/LANDLORDS、不贪吃蛇/NON_GLUTTONOUS_SNAKE、2048/GAME_2048、数独/SUDOKU、推箱子/PUSH_BOX、中国象棋/CHINESE_CHESS、俄罗斯方块/TETRIS、扫雷/MINESWEEPER、爱坤大乐斗/IKUN、大富翁/MONOPOLY、爱坤麻将/MAHJONG。

### 3.6 多智能体 (delegate.mjs)

| 工具 ID | 用途 | 参数 | 返回 | 风险 |
|---|---|---|---|---|
| `delegate` | 委派子智能体 | `{agent: 'explore'\|'math', task}` | `<task state="completed">...</task>` | **嵌套深度上限** |

详见 [multi-agent.md](./multi-agent.md)。`delegate` 超出 `subagentDepth` (默认 1) 直接拒绝。

### 3.7 待办 (todo.mjs)

| 工具 ID | 用途 | 参数 | 返回 | 风险 |
|---|---|---|---|---|
| `todo_list` | 列/初始化清单 | `{}` | `{items}` | 无 |
| `todo_update` | 维护清单 | `{action, text?, index?, status?, priority?}` | `{list}` 或 `{error}` | `maxItems` 默认 20 |

`action` ∈ `add / done / update / delete / clear`; 状态 ∈ `pending / in_progress / completed / cancelled`; 优先级 ∈ `low / normal / high`。

### 3.8 记忆 (memory.mjs, 受 ENABLE_MEMORY 门控)

| 工具 ID | 用途 | 参数 | 返回 | 风险 |
|---|---|---|---|---|
| `remember` | 持久化用户事实 | `{fact}` | `{ok, stored}` | **默认关闭** (`ENABLE_MEMORY=1`) |
| `recall` | 按关键字查询事实 | `{query?}` | `{facts[]}` | **默认关闭** |

### 3.9 技能 (skill-{list,get,install,search}.mjs, 4 拆分, 受 DISABLE_SKILLS 门控)

| 工具 ID | 用途 | 参数 | 返回 |
|---|---|---|---|
| `skill_list` | 列出全部 skills (按 source 分组) | `{}` | `{total, builtin, user_dir, user_url}` |
| `skill_get` | 加载一个 skill 的 content | `{name}` | `{name, description, content}` |
| `skill_install` | 从 URL 远程安装 | `{url}` | `{installed, name, url}` |
| `skill_uninstall` | 卸载 user_dir skill | `{name}` | `{removed}` |
| `skill_search` | 在 skill 内容里 grep | `{pattern, path?, include?, limit?}` | `{matches, total, truncated}` |

详见 [skill-system.md](./skill-system.md)。底层用 [skill-registry.mjs](../../../agent/lib/business/skill-registry.mjs) 多源合并。

### 3.10 定时 (scheduler.mjs)

| 工具 ID | 用途 | 参数 | 返回 | 风险 |
|---|---|---|---|---|
| `schedule` | 注册一次性任务 | `{task, mode, inMinutes?/atTime?, to?}` | `{id, atMs, estimated}` | `DISABLE_SCHEDULE=1` 关闭 |
| `list_schedules` | 查未到期任务 | `{}` | `{count, tasks[]}` | 同上 |

`mode` ∈ `remind` (到点发文本) / `auto` (到点自动生成再发)。

### 3.11 聊天记录 (chat.mjs)

| 工具 ID | 用途 | 参数 | 返回 | 风险 |
|---|---|---|---|---|
| `recent_messages` | 当前会话内存 (仅连接后) | `{n?}` | `{count, messages[]}` | 上限 30 |
| `chat_log` | 持久化日志 (跨重启) | `{n?, from?}` | `{count, total, messages[]}` | JSONL 持久化, 上限 200 |

### 3.12 图像 (image.mjs, 受 minimax 工具网关门控)

| 工具 ID | 用途 | 参数 | 返回 | 风险 |
|---|---|---|---|---|
| `generate_image` | 文生图 (Minimax 网关) | `{prompt, n?, size?, aspect?}` | `{images: [{url, ...}]}` | 需 `MINIMAX_IMAGE_GATEWAY_URL` |
| `upload_image` | 上传图像到鱼塘 | `{url, toRoom?}` | `{uploaded, url}` | 替换原 `send_file` |

---

## 4. 预算 (budget)

`defineTool` 支持 `budget` 字段(字符串输出最大字符数, 超出截断, 默认 4000, 详见 [tool-core.md](../foundation/tool-core.md) §3), 防止单个工具回填把上下文撑爆。**不是超时** —— 执行超时由各模块自己的 `timeoutMs` 控制。每个工具单独配置, 常见值:

- `python`: 4000 (实际超时由 `python-runner.timeoutMs` 控制, 默认 15000)
- `web_search` / `fetch_url`: 6000
- `create_room` / `close_room` / `todo_update`: 4000
- `delegate` / `send_file`: 8000

---

## 5. MOCK 行为

测试模式下, 工具运行由 mock 替换:

| 环境变量 | 影响 |
|---|---|
| `MOCK_LLM=1` | LLM 返回固定剧本 (不调真实 API), 工具仍真实执行 |
| `MOCK_TOOLCALL=1` | 工具调用的最终结果由 mock 替换, 便于离线回归 |

`MOCK_LLM=1 npm start` 是仓库默认的离线自测命令。详见 `.claude/docs/testing/README.md`。

---

## 6. 新增工具 checklist

1. 在对应分类的 `tools/<category>.mjs` 加 `buildXxxTools(ctx)` 导出
2. 在 `tools/index.mjs` import 并 for-loop 注册
3. 若需列入子智能体白名单, 同步更新 [agents.mjs](./multi-agent.md) 的 `tools` 数组
4. 若为强副作用工具 (写磁盘/外网 POST), 默认 `DISABLE_*` 关闭, 通过 ctx 判断 `enabled`
5. 在 `M-2 越权` 等风险表里登记 (`close_room` 当前是已知风险)
6. 测试: `agent/test/test-*.mjs` 加 mock 用例