# 周边工具模块业务文档

本文档覆盖 `agent/lib/` 下 10 个"周边工具"模块: todo / memory / scheduler / chat-log / trigger / persona / web / python-runner / sendup / xechat-api。每个子模块的字段格式统一, 便于横比。

---

## 1. todo —— 每会话待办 (agent/lib/todo.mjs)

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

## 2. memory —— 持久用户事实 (agent/lib/memory.mjs)

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

### 数据格式

JSON 文件, 顶层是 `username → facts[]` 的映射:

```json
{
  "user_a": [
    { "key": "fact-1abc23", "value": "喜欢喝咖啡", "at": "2026-08-27T10:00:00.000Z" },
    { "key": "nickname",   "value": "小张",     "at": "2026-08-27T10:05:00.000Z" }
  ]
}
```

写入用 `JSON.stringify(data, null, 2)`, 缩进 2 空格。

### 坑点

1. **默认关闭且无密码/加密** —— 落地文件是明文 JSON, 若开启需注意服务器访问权限。
2. **`enabled=false` 时所有写操作静默吞掉** —— `_scheduleSave` 直接 return, 不抛错; 排查"为什么记忆没生效"时第一检查 `enabled`。
3. **`set` 同 key 覆盖** —— 业务上若把同一 key 当事件流用, 老 `at` 会丢。
4. **哈希 key 来自 fact 文本本身** —— `remember("喜欢喝咖啡")` 和 `remember("喜欢喝咖啡 ")` (末尾空格) 会因 `trim` 而生成相同 key, 而 `remember("喜欢喝咖啡")` 和 `remember("喜欢喝咖 啡")` 是不同 key。
5. **去抖窗口期内进程崩溃会丢未落盘的 dirty** —— 关键节点调用方需主动 `flush()`。

---

## 3. scheduler —— 定时任务处理器 (agent/lib/scheduler.mjs)

### 职责

到点触发提醒或调 LLM 执行。**内存 Map 为主**, 可选开启磁盘持久化 (`ENABLE_SCHEDULE_PERSIST`); 启动时 `start(onFire)` 启动 tick 循环, 到期回调。

### 关键 API

`export class Scheduler`

| 方法 | 签名 | 行为 |
|---|---|---|
| `constructor({enabled=true, tickMs=5000, persist=false, file, log})` | — | `persist && file` 时构造即 `_load` |
| `add({atMs, task, to=null, mode='remind'})` | 返回 `{id, atMs}` | 注册一次性任务; ID 形如 `sched_<seq>_<base36>` |
| `cancel(id)` | 返回 boolean | 从队列删, 触发 `_save` |
| `list()` | 返回数组 | 仅列出**未到期** (`atMs > now`) |
| `start(onFire)` | — | 启动 `setInterval(tick, tickMs)`; timer `.unref()` 不阻塞进程退出 |
| `stop()` | — | clearInterval |
| `tick()` | 返回到期条目数组 | 手动触发一次到期检查 (测试用) |
| `get size()` | 返回 `queue.size` | 当前队列长度 |

辅助导出:

| 导出 | 签名 | 行为 |
|---|---|---|
| `parseAtTime(str, now=Date.now())` | `(HH:MM[:SS]) => Number\|null` | 今天/明天绝对毫秒; 已过期 → 明天 |
| `parseDuration(str)` | `('5分钟' / '2小时' / '30秒' / '2h' / '30s')` | 相对毫秒; 非法 → null |

### 配置项

- **`tickMs`** = 5000: 扫描间隔, 改小更灵敏但 CPU 更多
- **`persist`** = false: 是否落盘 (`ENABLE_SCHEDULE_PERSIST=1` 开启)
- **`enabled`** = true: 总开关
- **`mode`**: `'remind'` (只发提醒) 或 `'auto'` (调 LLM 执行)

### 数据格式

内存: `Map<id, entry>`, `entry = {id, atMs, task, to, mode, createdAt}`。

磁盘 (persist 模式) JSON:

```json
{
  "seq": 12,
  "tasks": [
    { "id": "sched_12_xyz", "atMs": 1730000000000, "task": "...", "to": null, "mode": "remind", "createdAt": 1699999999000 }
  ]
}
```

加载时 `atMs <= now` 的过期任务**不恢复**。

### 坑点

1. **同 ID 重复 add 不会去重** —— 但 ID 含自增 seq, 实际不会撞。
2. **`tickMs` 决定最大误差** —— 5s 间隔意味着到点最多晚 5s 触发。
3. **`tick()` 内先 `delete` 再回调** —— 若 `onFire` 内又 `add` 新任务且其 `atMs <= now`, 会**立即**被下次 tick 触发 (因为新 entry 不在本次 due 数组里, 但已入队)。
4. **`_save` 失败吞掉异常** —— 磁盘满/权限问题不会上报, 仅 log。
5. **`timer.unref()`** —— 进程没有其它活动时定时器不阻止退出, 持续运行需要别的事件源 (WS 连接)。

---

## 4. chat-log —— 聊天记录日志 (agent/lib/chat-log.mjs)

### 职责

把当前会话收到的聊天消息**追加写入 JSONL** 文件 (`data/chat-log.jsonl`), 跨重启可查; `recent_messages` (内存当前会话) + `chat_log` 工具/`/大黄鱼 聊天记录` 都从该日志读历史。**默认开启** (`DISABLE_CHAT_LOG=1` 关闭)。

### 关键 API

`export class ChatLog`

| 方法 | 签名 | 行为 |
|---|---|---|
| `constructor({enabled=true, file, maxEntries=1000, log})` | — | `enabled` 或 `file` 缺失时全部写读都 noop |
| `append({from, content, self=false, time=Date.now()})` | — | 同步追加一行; content 截断到 300 字符 |
| `readRecent(n=10, {from})` | `async → Array` | 读最近 `min(200, n)` 条; `from` 可选过滤用户 |
| `count()` | 返回行数 | 文件不存在/关闭时返回 0 |
| `_maybeTrim()` | 内部 | 文件 >64KB 且行数 > `maxEntries` 时只保留最新 `maxEntries` 行 |

### 配置项

- **`enabled`** = true (`DISABLE_CHAT_LOG=1` 关)
- **`maxEntries`** = 1000 (裁剪阈值)
- **`file`** = `data/chat-log.jsonl` (由 config 决定)
- **trim 触发** = `fileSize >= 64KB && lines > maxEntries` (避免小文件反复读写)

### 数据格式

JSONL 每行:

```json
{"from":"user_a","self":false,"content":"今天天气真好","time":1730000000000}
```

字段:

- `from`: String, 缺失记为 `'?'`
- `self`: Boolean, 是否是 bot 自己发出
- `content`: String, **截断到 300 字符** (避免恶意/长文本撑爆文件)
- `time`: Number, ms 时间戳

### 坑点

1. **`append` 是同步 `appendFileSync`** —— 在高频消息下是阻塞点; 大文件时尤其明显。
2. **`content` 300 字符截断** —— 长消息会被砍, 后续查询拿不到完整内容; 不可逆。
3. **`_maybeTrim` 在每次 append 后检查** —— 大文件时 (虽然有 64KB 短路) 会全文件读 + 写一次; 极端高频下需注意。
4. **没有并发锁** —— 多进程同时 append 可能交错 (虽然通常单实例)。
5. **`readRecent` 读全文件再 slice** —— 文件极大时 O(N), 没有索引; 当前默认 1000 条内可接受。

---

## 5. trigger —— 多人发言主动消息触发器 (agent/lib/trigger.mjs)

### 职责

累计**非自己**的聊天消息条数, 达阈值后触发一次主动广播 (把窗口内收集的消息交 LLM 生成观点鲜明的发言), 然后重置窗口 + 进入冷却。**默认关闭** (`ENABLE_TRIGGER=0`), 防刷屏。

### 关键 API

`export function createTrigger(opts) → {onMessage, getState, reset}`

| 函数 | 签名 | 行为 |
|---|---|---|
| `onMessage({from, content, time})` | 返回 `Array\|null` | 喂一条消息; 累计到 `threshold` 时返回待分析批次并重置; 否则返回 null |
| `getState()` | 返回 `{enabled, threshold, windowCount, windowMsgCount, lastFireAt}` | 调试/监控 |
| `reset()` | — | 清空当前窗口 |

### 配置项

- **`enabled`** = false (`ENABLE_TRIGGER=1` 开)
- **`threshold`** = 10: 触发阈值 (最少 1, 自动 clamp)
- **`cooldownMs`** = 300000 (5 分钟): 触发后冷却; 冷却期内既不收集也不累计
- **`botNames`** = `[]`: 同族 bot 名单, 完全同名或名字**末字 = '鱼'** 的发言不计

### 数据格式

纯内存 state, 无持久化:

```js
{
  enabled, threshold, cooldownMs,
  botNameSuffix,                 // 末字数组 (用于过滤同族 bot)
  botNames: Set,                 // 完整名集合
  windowCount,                   // 窗口累计消息条数
  windowMsgs: [{from, content, time}],
  lastFireAt,
}
```

### 坑点

1. **过滤规则依赖名字末字 `'鱼'`** —— 同族 bot 命名约定若改变, 过滤失效。
2. **含 `/` 的消息被完全跳过** —— 命令型消息不计入窗口也不累计, 即便用户实际在对话。
3. **冷却期内既不累计也不收集** —— 阈值期间窗口停滞, 可能让 bot"看起来不说话"。
4. **触发后立即冷却** —— `lastFireAt = now`, 即使后续持续高强度聊天也只等 5 分钟。
5. **同一人连发 N 条会一次性触发** —— 不去重发言人, 高频刷屏用户最容易引爆。

---

## 5.5 persona —— 拟人形态触发器 (agent/lib/persona.mjs)

### 职责

`@ 提及` 聊天时, 决定用哪一套"人设"回复:
- **`MODE_FORMAL`** (默认) — `main` agent 的 `AI 助手腔` (礼貌 / 准确 / 工具清单)
- **`MODE_HUMAN`** — `鱼塘老网友腔` (短句 / 玩梗 / 阴阳怪气 / 像群里泡久了的鱼)

两条路会拼出**完全不同的 system prompt**, 然后走同一个 `chatView()` (空工具) 的 `llm.agentTurn`。
与 `trigger.mjs` (主动插话) 互补: 那条路是旁观找茬, 这条路是被 @ 后的回应者。

### 关键 API

| 导出符号 | 签名 | 用途 |
|---|---|---|
| `MODE_FORMAL / MODE_HUMAN` | `const` | mode 常量 |
| `createPersonaTrigger({enabled, defaultMode, tieMargin, hourBiasHumanRanges, roomWindowSize, maxStickiness, log})` | 工厂 | 返回 `{analyze, reset, snapshot, getStickiness}` |
| `pickPersona(text, from, ctx)` | `(text, from, {lastModeByUser, roomLog, tieMargin, defaultMode, ...})` | 直接打分; 不写入黏性 |
| `scoreMessage(text, {hourBias, isLateHour, now})` | — | 只算文本特征基础分 (测试用) |
| `getHumanSystemPrompt()` | → string | 鱼塘老网友 system prompt |

### 触发评分 — 4 路信号, 总分高者胜出

| 信号 | 命中加 `human` | 命中加 `formal` | 来源 |
|---|---|---|---|
| **招呼** | `咋了 / 咋啦 / 在么` (+0.85) | `你好 / 您好 / hi / 在吗` (+0.85) | `GREETING_*` 正则 |
| **长度** | 空/≤6/≤15 字 (+0.20~0.55) | 41~120 字 (+0.30) / >120 字 (+0.50) | `len()` |
| **俚语** | `笑死 / 服了 / 好家伙 / 牛马 / 儒雅随和 / yyds / 666 / 喷粪 / 搁这` …(+0.20/处, 上限 0.55) | — | `SLANG_PATTERNS[]` |
| **正式请求** | — | `请 / 请问 / 帮我 / 总结 / 翻译 / 分析 / 解释 / 代码 / bug / 怎么 / 如何` …(+0.20/处, 上限 0.65) | `FORMAL_PATTERNS[]` |
| **emoji 密度** | ≥3 个 (+0.35) / 2 个 (+0.15) | — | unicode range |
| **标点** | `!!` / `??` (+0.10~0.15) | — | regex |
| **结构** | — | 列表/编号体 (+0.30) | regex |
| **时间偏好** | 凌晨 00-07 点 (+0.15) | 工作时段 9-18 点 (+0.05) | `hour` |
| **用户黏性** | 同用户上一轮 `human` (+0.20) | 同用户上一轮 `formal` (+0.20) | `lastModeByUser` Map |
| **房间氛围** | 最近 N 条俚语占比 ≥50% (+0.20) / ≥20% (+0.08) | — | `roomLog` |

`tieMargin` (默认 0.15) 内算平局: 平局优先沿用用户黏性 → 再退到 `defaultMode`。

### 调试入口

`/大黄鱼 persona` —— 打印开关/默认/最近 10 条黏性。
`/大黄鱼 persona 测试 <文本>` —— 看任意文本会被打几分、判哪个人设。
`/大黄鱼 persona 重置 [用户]` —— 清空黏性 (便于重新观察)。
每次触发都会在 `agent.log` 写一行 `[persona] <user> → <mode> (<reason>)`。

### 配置项 (`config.persona`)

- **`enabled`** = true (`DISABLE_PERSONA=1` 关掉, 一律退回 formal)
- **`defaultMode`** = `'formal'` (`PERSONA_DEFAULT_MODE=human|formal` 平局默认)
- **`tieMargin`** = 0.15 (`PERSONA_TIE_MARGIN`)
- **`hourBiasHumanStart / End`** = 0 / 7 (`PERSONA_LATE_HOUR_START/END` 默认 0:00-7:00)
- **`stickinessSize`** = 200 (`PERSONA_STICKINESS_MAX` FIFO 上限)

### 坑点

1. **中文没有 `\b`** —— `SLANG_PATTERNS` 用 substring 匹配, 别加 `\b` (会匹配不到中文)
2. **招呼 + 长度信号会冲突** —— `scoreMessage` 里招呼信号**先判**且**跳过长度权重**, 避免 "你好" 被长度偏见盖过
3. **用户黏性会双向粘** —— 同一人上一轮什么 mode, 本轮 +0.20 该 mode (防止风格跳变), 但本轮文本强烈反向也能覆盖
4. **FIFO 淘汰用户黏性** —— 超过 `maxStickiness` 最早的用户被丢弃; 长生命周期 bot 长期积累后老用户会"失忆"
5. **与 `trigger.mjs` 不冲突** —— trigger 是主动插话 (广播), persona 是被动回复 (定向); 都开也互不干扰
6. **关闭时 `analyze` 一律返回 `defaultMode`** —— 不写黏性, 等于关闭整套拟人逻辑

---

## 6. web —— 联网工具 (agent/lib/web.mjs)

### 职责

Node 原生 fetch 不支持 HTTP 代理, 鱼塘外网必须走代理 (7897)。本模块**统一通过 python requests 走代理**执行: `httpGet` 抓 URL, `webSearch` Bing RSS 搜索, `goldPrice` 国际金价 (人民币折算)。

### 关键 API

| 导出 | 签名 | 行为 |
|---|---|---|
| `httpGet(url, {proxy, timeoutMs=15000, headers})` | `async → {status, text}` 或 `{status:-1, error}` | 自动处理 GBK/GB2312 编码; text 截断 300KB; 失败返回简短原因避免泄漏 Traceback |
| `webSearch(query, {proxy, timeoutMs=15000, maxResults=6})` | `async → Array<{title, url, snippet}>` | Bing RSS (`format=rss&mkt=zh-CN&setlang=zh-hans`); 走代理限流自动重试 1 次 |
| `goldPrice({proxy, timeoutMs=15000})` | `async → {usdPerOz, cnyPerOz, cnyPerGram, exchangeRate, updatedAt}` | gold-api.com XAU, 两次请求: 国际 + 人民币 |

### 配置项

- **`proxy`** = `{host, port}`: 通常 `127.0.0.1:7897`, 由 config 注入
- **`timeoutMs`** = 15000: 单次 HTTP 超时
- **`maxResults`** = 6: 搜索返回数上限
- **`UA`**: Chrome 126 Windows UA 写死

### 数据格式

- `httpGet` 失败: `{status: -1, error: "<异常类名>: <前160字符>"}`; 成功: `{status: 200, text: "<截断到 300KB>"}`
- `webSearch` 成功: `[{title, url, snippet(≤300字)}]`, snippet 已去除 HTML 标签
- `goldPrice`: `{usdPerOz, cnyPerOz, cnyPerGram(元/克, 31.1035g/oz), exchangeRate, updatedAt}`

### 坑点

1. **底层是 python 子进程** —— 每次调用都要起进程, 有 100~300ms 启动开销; 高频调用需考虑批量化。
2. **`httpGet` 失败时仅返回前 160 字符** —— 排查"为什么 404"会丢失堆栈; 调试时可在 Python 输出加日志。
3. **Bing RSS 反爬** —— `webSearch` 走 RSS 模式相对稳定, 但偶发被拦; 错误信息"搜索无结果(可能被反爬)"。
4. **`goldPrice` 默认汇率 6.7** —— 第二次 `/XAU/CNY` 失败时 fallback 到 USD × 6.7, 偏差可能大。
5. **`httpGet` text 截断 300KB** —— 大文档会被切, 后续解析注意; `maxOutput` 放宽到 400KB 应对 Python 端 stdout。

---

## 7. python-runner —— Python 执行器 (agent/lib/python-runner.mjs)

### 职责

供两个用途共用: (1) `python` 工具让 LLM 做计算; (2) `web.mjs`/`sendup.mjs` 走 python requests 跑网络。**沙箱**强制超时 + 输出上限 + 在临时目录运行, 文件读写不污染 agent 目录; 运行期注入安全 prelude 拦截危险模块/函数。

### 关键 API

| 导出 | 签名 | 行为 |
|---|---|---|
| `runPython(code, {timeoutMs=15000, cmd='python', cwd, env, maxOutput=51200})` | `async → {stdout, stderr, exitCode, timedOut}` | spawn 子进程执行; 超时 SIGKILL |

### 配置项

- **`PYTHON_TIMEOUT_MS`** = 15000: 单次执行超时, 超时立即 SIGKILL
- **`MAX_OUTPUT`** = 50 * 1024 (50KB): stdout+stderr 合计上限, 超限截断
- **`cwd`**: 缺省自动 `fs.mkdtempSync(os.tmpdir()/'yutang-py-')`, 完成后删除
- **`cmd`**: 默认 `python` (Windows 上需 PATH 中有 `python.exe`, 也可换 `python3`/`py`)

### 数据格式

返回结构:

```js
{
  stdout: String,    // 已截断到 maxOutput, 含 '...[输出超限截断]'
  stderr: String,    // 同上; 超时时追加 '[超时] python 执行超过 Xms 已终止'
  exitCode: Number,  // 0 = 正常; -1 = 超时; -2 = spawn 失败
  timedOut: Boolean,
}
```

**安全 prelude** 在用户代码前注入 (第二道防线, 字符串审计可能被拼接/编码绕过):

- 拦截 `__import__` 危险模块: `subprocess, psutil, commands, netifaces, ctypes, winreg, multiprocessing, pty, ftplib, telnetlib, paramiko`
- 禁函数: `os.{system,popen,spawn*,exec*,remove,rmdir,unlink,chmod,chown}`; `shutil.{rmtree,move,copy,...}`; `socket.{gethostname,getfqdn,sethostname}`; `platform.*`; `urllib.request.urlretrieve`
- `os.environ` 清空 (requests 显式传 `proxies`, 不依赖 env vars, 防 `getenv` 读取 API key)

### 坑点

1. **`PYTHON_TIMEOUT_MS` 是硬上限** —— SIGKILL 不可被 Python `signal.signal` 捕获, 子进程必被杀。
2. **stdout/stderr 各算 50KB** —— 总上限 100KB, 但单个流 50KB 即截断; print 多别分两个流。
3. **`createdSandbox` 才清理** —— 调用方传 `cwd` 时不清理, 由调用方负责。
4. **`spawn` 失败时 exitCode=-2** —— 通常是 `python` 不在 PATH (Windows 常见)。
5. **安全 prelude 是 Python 层** —— JS 层仍需自己做参数/输入校验; prelude 可被 importlib/动态导入绕过 (理论)。
6. **socket 模块未禁, 只禁探测函数** —— 因为 `email.utils` 依赖 socket, 完全禁会破坏 requests。

---

## 8. sendup —— 文件分享 sendup.cc 三步上传 (agent/lib/sendup.mjs)

### 职责

把 agent 聊天中产生的文件 (LLM 整理的 .md 文章, 生成的 PNG/JPG 截图, 代码/数据) 上传到 **sendup.cc** 拿分享链接。文本 UTF-8, 二进制 base64。**协议三步**: 拿 presigned URL → PUT 到 Cloudflare R2 → POST 落 metadata 拿分享链接。

### 关键 API

| 导出 | 签名 | 行为 |
|---|---|---|
| `guessMimeType(filename)` | `(filename) => String` | 按扩展名猜 MIME; 兜底 `application/octet-stream` |
| `uploadContent(content, opts)` | `async → Object` | 上传主入口, 返回 sendup 响应 (含 `share_url`) |

`uploadContent` opts:

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `filename` | String | **必填** | 文件名 (含扩展名); 非法字符校验 `^[\w\-. -￿]+$` |
| `mimeType` | String | 扩展名猜 | 强制 MIME |
| `isBinary` | Boolean | false | content 是否是 base64 |
| `password` | String | '' | 访问密码 |
| `expireMinutes` | Number/String | '1440' (24h) | 链接有效期 |
| `lang` | String | 'zh-cn' | — |
| `proxy` | {host,port} | — | 走代理 |
| `timeoutMs` | Number | 90000 | Python 端总超时 |
| `maxBytes` | Number | 52428800 (50MB) | 文件大小上限 |
| `log` | Function | ()=>{} | 日志 |

### 配置项

- **`SENDUP_MAX_BYTES`** = 50 * 1024 * 1024 = 50MB (单文件上限)
- **`expireMinutes`** 默认 1440 (24h)
- **`UA`/proxy**: 同 web.mjs, 由 config 注入

### 数据格式

请求 payload (三步):

1. `POST /api_get_upload_url.php` body: `{filename, filesize, mime_type}` → `{success, presigned_url, r2_key, upload_token}`
2. `PUT <presigned_url>` body: 文件 bytes, header `Content-Type: mime_type` → 200/201/204
3. `POST /api_save_upload.php` body: `{r2_key, original_filename, file_size, mime_type, upload_token, password, expire_minutes, lang}` → `{success, url/share_url, expires_at}`

成功返回:

```json
{
  "success": true,
  "stage": "saved",
  "share_url": "https://...",
  "original_filename": "report.md",
  "file_size": 12345,
  "mime_type": "text/markdown",
  "expires_at": "2026-08-28T...",
  "raw": { ... }
}
```

失败返回带 `stage`: `get_url` / `put_file` / `exception`。

### 坑点

1. **文件名校验正则** —— 不允许中文标点 / `(` `)` `/` 等; 文件名包含中文括号会被拒。
2. **50MB 硬上限** —— `SENDUP_MAX_BYTES` 是 JS 层校验, 超过抛错, 不会上传。
3. **临时文件路径传给 Python** —— Python 在沙箱里读绝对路径; 沙箱不影响 fs 绝对路径读取。
4. **`share_url` 字段多版本兼容** —— 兼容 `url / share_url / download_url / data.url / data.share_url`, 缺失时返回 undefined。
5. **PUT 超时 180s** —— Python 端 `timeout=180`; JS 端默认 90s 包不住 50MB PUT, 高负载时需调大 `timeoutMs`。
6. **三步走 Python 一脚本** —— 任何一步失败整次失败, 无断点续传; 重传需重新走完整流程。

---

## 9. xechat-api —— Xechat 平台 API 客户端 (agent/lib/xechat-api.mjs)

### 职责

封装鱼塘 (lesscoding.net) 平台常用查询接口: 游戏列表 / 游戏详情 / 排行榜。**无需鉴权** (与注册接口同前缀), 注意 `/xeManager` 实际未部署, 真实可用的是 `/api/`。`fetchFn` 可注入便于离线测试。

### 关键 API

`export class XechatApi`

| 方法 | 签名 | 行为 |
|---|---|---|
| `constructor({base='https://dld.lesscoding.net', timeoutMs=12000, fetchFn, log})` | — | 末尾 `/` 自动 strip; `fetchFn` 默认 `globalThis.fetch` |
| `gameList({size=20, keyword=''})` | `async → Array` | `POST /api/gameInfo/list`; `keyword` 模糊匹配 `gameName/gameNameZhCn/description` |
| `gameDetail(idOrName)` | `async → Object` | `GET /api/gameInfo/detail/<id>` (id) 或 `GET /api/gameInfo/<name>` (名) |
| `leaderboard({gameInfoId, rankKey='score', limit=10})` | `async → Array` | `POST /api/leaderboard/ranking`; 返回 `[{rank, username, score, nickname?}]` |
| `serverList()` | `async → Array` | `GET /api/server/list`; 返回 `[{id, name, ip, port, version, status, enabled, sort, remark}]` |
| `_req(method, path, body)` | 内部 | 带 AbortController 超时; 业务码 `code !== 200` 抛错 |

### 配置项

- **`base`** = `https://dld.lesscoding.net` (末尾 `/` 自动 strip)
- **`timeoutMs`** = 12000: 单次请求超时
- **`fetchFn`**: 测试时可注入 mock
- **`rankKey`**: 排行榜排序键, 默认 `score`

### 数据格式

统一响应 envelope: `{code: 200, message, data}`. `_req` 检查 `code !== 200` 直接抛 `Error(message || "业务码 X")`。

`gameList` 返回每项:

```js
{ id, name, zhName, version, status, online (status===1), playUrl, categories (拼接), fileSize }
```

`gameDetail` 返回附加: `description, downloadUrl, updateTime`。

`leaderboard` 返回每项: `{rank (1 起), username, score, nickname?}`. 字段名兼容 `username/userName/playerName`, `score/value/rankValue`.

`serverList` 返回每项: `{id, name, ip, port, version, status, enabled (status===1), sort, remark}`.

### 坑点

1. **`_req` 业务码非 200 直接抛** —— 上层必须 try/catch; 失败信息只有 `data.message`。
2. **`fetchFn` 注入** —— 测试用, 但需自行模拟 `{ok, json()}` 接口形态。
3. **`gameDetail` 中文名编码** —— `/api/gameInfo/<name>` 此接口中文描述编码正常, 但 list 接口里中文字段可能需客户端处理。
4. **leaderboard 字段名多版本** —— username 兼容 `userName/playerName`; score 兼容 `value/rankValue`; 缺字段默认 `'?'`/`null`。
5. **`/xeManager` 路径不可用** —— OpenAPI 文档 (`api/manager-api-docs.json`) 写的 `xeManager` 前缀实际未部署, 必须用 `/api/`。
6. **没鉴权** —— 公开数据可查; 涉及用户隐私/写操作的接口不在此模块, 需另走 WS 协议。

---

## 附录: 模块依赖关系

```
                        ┌──────────────┐
                        │  tools.mjs   │
                        │ (注册表)      │
                        └──────┬───────┘
                               │ 引用
        ┌──────────┬───────────┼───────────┬──────────┬──────────┐
        ▼          ▼           ▼           ▼          ▼          ▼
     todo      memory     scheduler    chat-log    trigger    web ──► python-runner
                                                                       │
                                                                    sendup
                                                                       │
                                                                 xechat-api (独立, 不依赖其它周边)
```

- **web.mjs** 依赖 `python-runner.mjs` (走代理)
- **sendup.mjs** 依赖 `python-runner.mjs` (三步上传)
- **xechat-api.mjs** 独立, 仅依赖 `globalThis.fetch`, 不走 Python
- 其余 (todo/memory/scheduler/chat-log/trigger) 是纯 JS 模块, 零依赖