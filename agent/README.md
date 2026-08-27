# 鱼塘 agent v2:多智能体智能体骨架 🎣

把原来只做「`/小黄鱼` 指令 → DeepSeek 回复」的 bot 升级为**参照 opencode 架构**的多智能体 agent:
在鱼塘(Xechat)聊天室里随叫随到,能记多用户上下文、能委派子智能体、能调工具、能掉线自动重连。

## 架构

```
agent/
├── agent.mjs               # 入口: 组装 + 每用户并发锁 + 重连循环 + 消息处理
├── config.mjs              # 配置(全部来自环境变量/.env, 无硬编码密钥)
├── lib/
│   ├── ws-client.mjs       # 连接层: 代理/直连, WS握手, 帧编解码, LOGIN/HEARTBEAT, 僵死看门狗, sendActionAndWait(发-等响应原语)
│   ├── llm.mjs             # LLM层: agentTurn(主回合) + agentRun(子智能体回合), 截断/重试
│   ├── agents.mjs          # 多智能体定义: main / explore / math / summarize(每 agent 工具白名单+提示词)
│   ├── system.mjs          # 系统提示词组合: <env> 环境块 + 人设 + 工具清单
│   ├── tool-core.mjs       # 工具定义 v2: defineTool + 参数校验 + 输出截断 + filter(白名单视图)
│   ├── tool-call-parse.mjs # 泄漏工具调用文本解析: 识别并恢复/剥除模型写成的 <invoke>/JSON 工具调用
│   ├── tools.mjs           # 内置工具注册表: 查询/联网/计算 + delegate/todo/skill/remember/recall + create_room/close_room/list_rooms(游戏房间)
│   ├── compaction.mjs      # 结构化上下文压缩: token预算选择 + 结构化摘要模板 + 增量合并
│   ├── sessions.mjs        # 会话层: 每用户上下文 + 待办 + token预算压缩 + 每用户并发锁
│   ├── memory.mjs          # 持久用户事实(JSON, ENABLE_MEMORY 开关)
│   ├── todo.mjs            # 每会话待办
│   ├── skills.mjs          # 技能包(工作流指令包)
│   ├── python-runner.mjs   # Python 执行器 (超时/输出上限/沙箱目录)
│   ├── web.mjs             # 联网: Bing 搜索 / 抓URL / 金价 (走代理)
│   ├── xechat-api.mjs      # Xechat 平台 API 客户端 (游戏/详情/排行榜)
│   └── router.mjs          # 路由: 确定性内置命令(含 create-room/close-room/rooms) + 子智能体指令 + main agent 回合
└── test/
    ├── mock-server.mjs     # 本地 mock 鱼塘服务器(离线模拟服务端)
    ├── run-e2e.mjs         # 端到端测试: 协议 + math/explore/todo 新场景
    ├── unit-agent.mjs      # 单元测试: 工具循环/委托/压缩/待办/技能/记忆 + game room(fake WS)
    ├── verify-close-room.mjs # 真实环境验证: M-2 close-room 越权关闭复现(需连接真实鱼塘)
    └── verify-list-rooms.mjs # 真实环境验证: list_rooms 订阅式活动房间计数
```

## 多智能体(参考 opencode 的 agent 定义)

每个智能体有**独立的系统提示词 + 工具白名单 + 迭代上限**,互不干扰:

| 智能体 | 类型 | 工具白名单 | 定位 |
|---|---|---|---|
| `main` | 主智能体 | 全量 | 大众版/专属版默认入口,可委派子智能体 |
| `explore` | 子智能体 | 联网+平台查询 | 调研: 搜索/抓取/查游戏榜单金价, 返回简洁结论 |
| `math` | 子智能体 | python | 计算: 任何计算都经 python 执行, 不编造数字 |
| `summarize` | 内部(隐藏) | 无 | 会话压缩, 输出结构化摘要 |

- **delegate 工具**: main agent 在多步长链时可把专项任务委派给子智能体(`<task state="completed">…` 返回),带嵌套深度限制(`SUBAGENT_DEPTH`)。
- **显式指令**: `/小黄鱼 explore <问题>`、`/小黄鱼 math <算式>` 直接调子智能体,省 token 省时。

## 多步思维链(参考 opencode: Reflect 注入 + Doom-loop 守护)

借鉴 opencode 提示词里的"Task Management"段与 `todowrite.txt` 反向约束,加上循环守护,让 agent 像 Claude Code / opencode 一样具备**规划→多步执行→评估→继续**的能力。三个组合机制:

1. **系统提示词多步调研范式**: `main` / `explore` 的 `extra` 写明确明:`web_search → fetch_url → python → 总结`,禁止只调一次 web_search 就给结论。
2. **Reflect 注入**: 每次工具结果回填后, 非最后一轮给模型推一条 `user` 角色提示:"工具结果已就绪。评估是否够?web_search 是 snippet,关键 URL 应 fetch_url;数据用 python;≥2 个不同类型工具 才算已调研"。**仅真实 LLM 模式生效**(`MOCK_LLM=1` 关闭,避免污染自测)。
3. **Doom-loop 守护**: 同名同参连续 3 次相同工具调用 → 强制停止并提示"我好像陷入重复",防无限循环。

**`todowrite` 升级**(对照 [opencode/tool/todowrite.txt](output/opencode/packages/opencode/src/tool/todowrite.txt)):
- 状态:`pending / in_progress(同时只能 1 条) / completed / cancelled`;
- 规则:动手前标 in_progress, 完成立刻勾 completed(不批量), 阻塞时保持 in_progress + 加 follow-up;
- 工具参数支持 `priority(low/normal/high)` 与 `action=update(index, status)` 精确管理;
- 持续多步调用 ≥2 个不同类型工具 才算"已调研"。

### 调研类技能包(参考 opencode skill)

`lib/skills.mjs` 提供命名工作流,LLM 通过 `skill` 工具加载后按其 instructions 执行:

| Skill | 适用场景 | 工作流 |
|---|---|---|
| `report` | 写结构化研究报告 | 结论/详述/来源 三段 |
| `explain` | 通俗解释概念 | 类比+例子+分步 |
| `analyze` | 数据分析 | python 处理 + 结论 + 依据 |
| `translate` | 翻译 | 中英互译 + 注解 |
| `story` | 故事连载 | 分章节 + 钩子 |
| `task` | 多步任务 | 拆 todo + 边干边勾 |
| **`news_roundup`** | **新闻/热点榜单** | **web_search → fetch_url → python → 结论/重点/来源** |
| **`trending`** | **热门/趋势** | **多源 + 聚合 + 趋势分组** |

**示例**:`/小黄鱼 skill news_roundup` 加载后,再问"今日头条"会按"搜→抓详情→去重排序→三段式输出"自动推进。

## 结构化上下文压缩(参考 opencode compaction)

按 **token 预算**保留最近对话、把多余旧消息压成**结构化摘要**(目标/重要背景/工作进展[已完成·进行中·阻塞]/下一步/相关资源),
并支持与上次摘要**增量合并** —— 长对话不爆上下文,且下一轮能据摘要继续。
可调 `COMPACTION_TOKEN_BUDGET`;`/小黄鱼 压缩` 手动触发。

## 新工具与新指令

**新工具**(LLM 可自动调用):
- `delegate` — 委派 explore/math 子智能体
- `todo_list` / `todo_update` — 每会话待办(add/done/delete/clear)
- `remember` / `recall` — 持久用户事实(`ENABLE_MEMORY=1` 开启)
- `skill` — 加载技能包(report/explain/analyze/translate/story/task)
- `create_room` — 在鱼塘创建游戏房间(走 WS `CREATE_GAME_ROOM`)
- `close_room` — 关闭鱼塘游戏房间(走 WS `GAME_ROOM`/`ROOM_CLOSE`)
- `list_rooms` — 列出当前活动的鱼塘游戏房间(总数/按游戏分组/列表)
- `server_list` — 查询鱼塘平台启用中的服务器列表(名称/地址/端口/版本)
- `schedule` — 注册一次性定时任务(相对 `inMinutes` / 绝对 `atTime`;`remind` 到点发提醒 / `auto` 到点自动生成)
- `list_schedules` — 查看未到期的定时任务
- `recent_messages` — 查看当前会话最近收到的聊天消息(仅连接后,不含历史,内存)
- `chat_log` — 查看聊天记录日志中最近的聊天消息(持久化到磁盘,跨重启可查)
- `send_file` — 把"聊天中产生的内容"上传到 sendup.cc 并生成分享链接(默认 MD 文本, base64 也可传截图/图表)
- `probe_pond` — 访问其他鱼塘(WebSocket 聊天服务): 一次性访客昵称登录目标鱼塘, 获取其在线用户列表(可附最近聊天)后立即断开, 只读不发言。已知: 充电鸭鱼塘=lesscoding.net:33859(直连可通)、官方鱼塘=xechat.xeblog.cn:33859(域名未备案一般被墙)。拒绝探测自己(当前鱼塘看在线用 room_stats)。

**新指令**(确定性,零 LLM 成本):
```
/小黄鱼 explore <问题>      → 委派 explore 子智能体调研
/小黄鱼 math 6*7            → math 子智能体 python 计算(纯数字安全表达式;复杂计算直接说)
/小黄鱼 todo 显示|添加 <事项>|完成 <序号>|删除 <序号>|清空
/小黄鱼 skills              → 列出技能包
/小黄鱼 记忆                → 查看已记住的关于你的事实(需 ENABLE_MEMORY=1)
/小黄鱼 压缩                → 手动触发上下文压缩
/小黄鱼 定时 <N分钟|HH:MM> <内容> → 注册定时提醒
/小黄鱼 定时列表            → 查看未到期定时任务
/小黄鱼 定时取消 <id>       → 取消定时任务
/小黄鱼 最近消息 [N]        → 查看当前会话最近 N 条消息(默认 10, 仅连接后, 内存)
/小黄鱼 聊天记录 [N]        → 查看聊天记录日志中最近 N 条(默认 10, 持久化到磁盘, 跨重启可查)
/小黄鱼 create-room <游戏> [人数] [模式]
                            → 创建游戏房间。游戏支持中文别名:五子棋/斗地主/不贪吃蛇/2048/数独/推箱子/中国象棋/俄罗斯方块/扫雷/爱坤大乐斗/大富翁/爱坤麻将,也可传枚举名 GOBANG/LANDLORDS/...
/小黄鱼 close-room <房间ID> → 关闭游戏房间。⚠ 鱼塘协议层无房主/成员校验,任意用户可关闭任意房间(M-2 已知缺陷)
/小黄鱼 rooms [游戏] [limit] → 列出当前活动游戏房间: 总数/按游戏分组计数/详细列表。⚠ 鱼塘无房间快照协议,数据靠订阅全服广播(GAME_ROOM_CREATED/ROOM_CLOSE)增量维护,agent 在线越久越准;启动前已存在的房间不会被发现
```

## 定时任务 / 聊天记录 / 主动消息

- **定时任务**: `/小黄鱼 定时 5分钟 提醒我喝水` 或 `定时 18:30 查金价`。到点发 `🔔 [定时] …` 提醒(可 `mode=auto` 让 LLM 自动执行)。默认内存队列(重启丢失),需要跨重启可 `ENABLE_SCHEDULE_PERSIST=1`。
- **当前会话聊天记录**: `recent_messages` 工具 / `/小黄鱼 最近消息 [N]`,只返回**这次连接后**收到的消息(环形缓冲,默认 100 条,不回溯历史,内存)。
- **聊天记录日志**: `chat_log` 工具 / `/小黄鱼 聊天记录 [N]`,把所有聊天消息**落盘到 `data/chat-log.jsonl`**(JSONL,默认保留 1000 条),**跨重启可查**更早历史。`DISABLE_CHAT_LOG=1` 关闭,`CHAT_LOG_FILE`/`CHAT_LOG_MAX` 可调。
- **主动消息触发器**: 每累计 `TRIGGER_THRESHOLD`(默认 10)条**非自己**的消息,agent 理解这批消息,主动(非回复)发出一条观点鲜明/有争议性的广播,然后重置计数 + 冷却。默认 `ENABLE_TRIGGER=0`(主动发言有刷屏风险,需显式开启)。
- **文件分享(sendup.cc, 内容驱动)**: `send_file({content, filename, is_binary?, mime_type?, password?, expire_minutes?})` 工具 —— **不读本地文件**,而是把 agent 在聊天里产生的内容(爬到的长文整理成的 `.md`、截图/图表的 base64、代码/数据)发出去。三步: `api_get_upload_url.php` 拿预签名 → PUT 到 Cloudflare R2 → `api_save_upload.php` 落 metadata 拿分享链接。可设访问密码与有效期(默认 1440 分钟=24h)。最大 50MB(`SENDUP_MAX_BYTES` 调)。⚠ 鱼塘聊天是**广播**(只带目标标记),非真私密 —— 即便设密码,链接分享给谁就谁能下;敏感内容别用。`DISABLE_SENDUP=1` 关闭,`SENDUP_TIMEOUT_MS` 调单次超时。

**@ 提及聊天**: 消息里 `@小黄鱼 …`(或协议 `toUsers` 定向)会触发响应,但**只聊天** —— 纯 LLM 对话、
不触发确定性命令、不调用工具、不做平台/应用查询,上下文独立于命令会话(`chat:` 前缀)。
可用于闲聊、答疑而不打乱命令上下文。`DISABLE_MENTION=1` 关闭。

## 快速开始

```bash
cd agent
cp .env.example .env        # 填 DEEPSEEK_API_KEY 等
npm start                   # 或 node agent.mjs
```

环境变量(详见 `.env.example`):`XE_HOST`/`XE_PORT`、`PROXY_HOST`/`PROXY_PORT`、
`DEEPSEEK_API_KEY`/`DEEPSEEK_MODEL`、`CMD_PREFIX`,以及新增的
`SUBAGENT_DEPTH`/`COMPACTION_TOKEN_BUDGET`/`ENABLE_MEMORY`/`TODO_MAX`/`DISABLE_SKILLS` 等。

## 在鱼塘里使用 (大众版小黄鱼, 登录名「小黄鱼」)

```
/小黄鱼 ping                 → pong 🎣
/小黄鱼 online                → 当前在线用户
/小黄鱼 games                 → 鱼塘游戏列表
/小黄鱼 game 桃源乡           → 某个游戏的详情
/小黄鱼 gold                  → 今日金价
/小黄鱼 explore 北京天气       → 委派子智能体联网调研
/小黄鱼 math 2**10            → 计算
/小黄鱼 create-room 五子棋 2  → 在鱼塘创建一个 2 人五子棋房间,返回房间ID
/小黄鱼 close-room 153449001  → 关闭房间ID=153449001 的房间(注: 鱼塘协议层无房主校验,任意用户可关任意房间)
/小黄鱼 rooms 5                → 列出当前活动房间(总数/按游戏分组/前 5 条); 数据靠订阅全服广播增量维护
/小黄鱼 有什么游戏             → 自由文本, LLM 自动调工具/委派子智能体
/小黄鱼 写个报告说明金价走势    → 加载 report 技能包按流程输出
```

**思考结果输出**: agent 调用工具后,把**工具查询到的结果**以 `💭` 前缀实时发到聊天里,再发正式回答。用 `HIDE_THINKING=1` 关闭,`THINKING_PREFIX` 自定义前缀。

**模型鲁棒性兜底(泄漏工具调用恢复)**: 个别模型偶尔会把工具调用输出成纯文本(`<tool_calls>/<invoke>` XML 或 `{"name",...}` JSON)而不是走函数调用机制。agent 会:
- 识别并**真正执行**文本形式的工具调用,把结果回填给模型继续 —— 请求被完成而不是显示乱码;
- 工具调用已截断/无法恢复时,把泄漏文本**剥除**,绝不让原始工具 XML 出现在聊天里;
- 工具迭代超限后进入"保留工具 + 收尾提示"的收尾阶段(仍可真正调用工具),避免模型被迫用文本"假装"调用;
- 系统提示词明令:需要工具必须走函数调用机制,文本形式的工具调用会被忽略。

**超长回复自动分片(markdown 友好)**: 服务端单条聊天消息上限实测 **200 字符**。agent 把超长回复拆成多条连续消息发送(续段带 `↪` 前缀), 且分片**优先在行边界切** —— `## 标题`、`- 列表项`、段落不会被从中间切断; 单行超长(URL、连续无空格)才在可读标点处切, 不切碎中文词/emoji。系统提示词也要求模型输出**短行/短段**(每要点 1-2 行), 分片后依旧美观。可用 `MSG_MAX_LEN` / `MSG_CHUNK_DELAY_MS` 调整。

**并发模型**: 每用户一个 in-flight 锁(`tryLock`)——**不同用户可并行处理**,同一用户连续指令被跳过;另有全局 `REPLY_COOLDOWN_MS` 防刷。

**领养功能**: 任何人发 `/小黄鱼 领养`,主 agent 拉起一个**独立进程**,登录名为 `<你>的小黄鱼`,只回复你 —— 专属于你的小黄鱼。多人可各领一只。

## 如何扩展成真正的 agent

1. **加智能体**: 在 `lib/agents.mjs` 的 `AGENTS` 表加一项(名字/描述/工具白名单/提示词),`delegate` 和 `/小黄鱼 <名字> …` 自动可用。
2. **加工具**: 在 `lib/tools.mjs` 用 `defineTool({id, description, parameters, run})` 注册,LLM 自动拿到这把钥匙;想按智能体区分就在白名单里加/减。
3. **加技能**: 在 `lib/skills.mjs` 的 `SKILLS` 加一个 `{description, instructions}` 即可。
4. **换模型**: `DEEPSEEK_BASE`/`DEEPSEEK_MODEL` 指向任何 OpenAI 兼容端点即可。

## 测试

```bash
npm test                 # 单元 + 端到端(全部离线, 不连真实鱼塘)
npm run test:e2e         # 只跑端到端
```

## 已知事项

- 鱼塘的 `toUsers` 私聊**实际是广播给所有客户端**(仅带目标标记),并非真私密 —— 别在回复里发敏感信息。持久记忆默认关闭(`ENABLE_MEMORY=0`)。
- 预发管理员/风控会主动封禁新连接 IP:黑名单只拦新登录、不踢已建立会话。一旦断开重连就可能因 IP 被封失败,需要塘主清黑名单或提供稳定出口。
- `replaySkipMs`(默认 2s)内收到的消息视为登录回放会跳过;`replyCooldownMs`(默认 4s)防止刷屏;子智能体嵌套受 `SUBAGENT_DEPTH` 限制防止恶意刷 token。