# 环境变量清单

> **2026-09-07 更新**: 同步 `agent/config.mjs` (Sep 3) — 新增 30+ env vars (skill-system / persona / aggressive / trigger / intent / minimax / chat-log / schedule-persist 等)

按 `agent/config.mjs` 分组列出全部环境变量。优先级: 命令行参数 > 已存在环境变量 > `.env` > 默认值 (见 [README.md](./README.md))。

所有开关遵循统一 bool 规则: `1` / `true` / `yes` → 开, 其余 (含 `0` / 空串) → 关。多数能力用 `DISABLE_X` 反开关: 默认开启, `=1` 才关。

---

## 1. 鱼塘连接

| 变量 | 默认 | 说明 |
|---|---|---|
| XE_HOST | 101.42.19.160 | WS 主机 |
| XE_PORT | 33859 | WS 端口 |
| PROXY_HOST | 127.0.0.1 | 代理主机 |
| PROXY_PORT | 7897 | 代理端口, 0 = 直连 |

## 2. 身份与指令

| 变量 | 默认 | 说明 |
|---|---|---|
| BOT_USERNAME | 大黄鱼 | 登录名 (大众版; 领养实例为 `<领养人>的大黄鱼`) |
| BOT_STATUS | FISHING | 登录状态 (FISHING / ONLINE / BUSY ...) |
| CMD_PREFIX | /大黄鱼 | 触发前缀 (跟登录名派生) |
| OWNER | (空) | 领养人; 非空 → 专属模式, 只回复该用户 |
| OWNER_PREFIX | (空) | 专属触发前缀, 如 `/牛来少年的大黄鱼` |
| DISABLE_ADOPT | 0 | =1 关闭领养 |
| ADOPT_MAX_INSTANCES | 5 | 同时在线的专属子实例上限 |

## 3. LLM (DeepSeek, OpenAI 兼容)

| 变量 | 默认 | 说明 |
|---|---|---|
| DEEPSEEK_API_KEY | (必填) | API Key; 缺失时退化为 Mock 模式并告警 |
| DEEPSEEK_BASE | https://api.deepseek.com | API 端点 |
| DEEPSEEK_MODEL | deepseek-v4-flash | 模型名 |
| LLM_TIMEOUT_MS | 20000 | 单次请求超时 (毫秒) |
| LLM_MAX_TOKENS | 800 | 单次生成上限; 调高让算法层生成完整内容 (输出按 200 字符分片) |
| LLM_TEMPERATURE | 1.0 | 采样温度 |
| LLM_MAX_TOOL_ITERATIONS | 8 | 单轮最多工具调用次数 (agent loop 步数) |
| MOCK_LLM | 0 | =1 不调真实 API, 返回固定回复 (离线自测) |
| MOCK_TOOLCALL | 0 | =1 mock 首轮返回工具调用, 测工具循环/思考输出 |
| MOCK_LONG_REPLY | 0 | =1 mock 超长回复, 测分片发送 |

## 4. Minimax (图像生成网关)

| 变量 | 默认 | 说明 |
|---|---|---|
| MINIMAX_API_KEY | (空) | 留空 → `generate_image` 工具返回明确错误 |
| MINIMAX_BASE | https://api.minimaxi.com | API 端点 |
| MINIMAX_IMAGE_TIMEOUT_MS | 120000 | 图像生成超时 (默认 2 min) |

## 5. 行为

| 变量 | 默认 | 说明 |
|---|---|---|
| HEARTBEAT_MS | 25000 | 心跳间隔 |
| STALE_TIMEOUT_MS | 90000 | 90s 无数据判定僵死, 触发重连 |
| REPLY_COOLDOWN_MS | 4000 | 对同一指令的最低回复间隔 (防刷) |
| REPLAY_SKIP_MS | 2000 | 登录瞬间的消息回放跳过窗口 |
| HISTORY_MAX | 10 | 每个会话保留的最近消息数 |
| MSG_MAX_LEN | 200 | 单条聊天消息字符上限 (服务端实测 201 即丢弃) |
| MSG_CHUNK_DELAY_MS | 600 | 超长回复分片间的发送间隔 (调大避免续片被丢弃) |
| HIDE_THINKING | 0 | =1 则不在聊天里展示思考结果 |
| THINKING_PREFIX | 💭 | 思考结果消息前缀 |

## 6. 重连

| 变量 | 默认 | 说明 |
|---|---|---|
| RECONNECT_REJECTED_MS | 30000 | 登录被拒 (黑名单?) 后等待重试 |
| RECONNECT_NORMAL_MS | 3000 | 普通断线后等待重试 |

## 7. 上下文压缩

| 变量 | 默认 | 说明 |
|---|---|---|
| COMPRESS_AT | 14 | 会话消息数达该值触发压缩 (兼容字段) |
| SUMMARY_MAX_LEN | 400 | 压缩摘要最大字符数 |
| COMPACTION_TOKEN_BUDGET | 3000 | 会话估计 token 达该值触发结构化压缩 |

## 8. 多智能体

| 变量 | 默认 | 说明 |
|---|---|---|
| SUBAGENT_DEPTH | 1 | 子智能体最大嵌套深度 (delegate 工具防递归) |
| SUBAGENT_ITERATIONS | 6 | 子智能体单次最大工具调用步数 |

## 9. 意图识别 (NEW, 2026-08-28)

| 变量 | 默认 | 说明 |
|---|---|---|
| DISABLE_INTENT | 0 | =1 关闭意图识别 (回退到 main agent) |
| INTENT_TIMEOUT_MS | 10000 | 分类 LLM 调用超时 |
| INTENT_CACHE_SIZE | 64 | LRU 缓存容量 (相同文本零成本复用) |

详见 [intent.md](../business/intent.md)。

## 10. 待办

| 变量 | 默认 | 说明 |
|---|---|---|
| TODO_MAX | 20 | 每会话最大待办条数 |

## 11. 记忆

| 变量 | 默认 | 说明 |
|---|---|---|
| ENABLE_MEMORY | 0 | =1 开启向磁盘记录用户事实 (隐私风险, 谨慎) |
| MEMORY_FILE | `data/memory.json` | 持久化路径 |
| MEMORY_MAX_FACTS | 30 | 每用户最多保留事实条数 |

## 12. 定时任务

| 变量 | 默认 | 说明 |
|---|---|---|
| DISABLE_SCHEDULE | 0 | =1 关闭定时任务 |
| SCHEDULE_TICK_MS | 5000 | 到期检查间隔 |
| ENABLE_SCHEDULE_PERSIST | 0 | =1 落盘 schedule.json, 重启恢复 |
| SCHEDULE_FILE | `data/schedule.json` | 持久化路径 |

## 13. 聊天记录 (NEW, 2026-08-27)

| 变量 | 默认 | 说明 |
|---|---|---|
| DISABLE_CHAT_LOG | 0 | =1 关闭落盘 |
| CHAT_LOG_FILE | `data/chat-log.jsonl` | JSONL 路径 |
| CHAT_LOG_MAX | 1000 | 保留上限 (超限裁剪最近) |

## 14. 房间 / 聊天日志

| 变量 | 默认 | 说明 |
|---|---|---|
| ROOM_LOG_MAX | 100 | 房间环形日志上限 |

## 15. 技能包 (NEW, 2026-08-28, opencode 风格)

| 变量 | 默认 | 说明 |
|---|---|---|
| DISABLE_SKILLS | 0 | =1 关闭技能包 (`skill_*` 工具全部禁用) |
| SKILLS_DIR | `data/skills` | 用户/远程 skill 落地目录 |
| SKILLS_URLS | (空) | 启动时自动同步的远程仓库 (逗号分隔) |
| SKILLS_PATHS | (空) | 额外扫描的本地目录 (逗号分隔) |
| SKILLS_MAX_CONTENT_CHARS | 8000 | skill_get 返回的 content 上限 (字符) |
| SKILLS_GREP_LIMIT | 100 | skill_search 最大命中数 |
| SKILLS_GREP_TIMEOUT_MS | 5000 | grep 超时 |

详见 [skill-system.md](../business/skill-system.md)。

## 16. 联网

| 变量 | 默认 | 说明 |
|---|---|---|
| DISABLE_WEB | 0 | =1 关闭联网工具 (`web_search` / `fetch_url` / `gold_price`) |
| WEB_TIMEOUT_MS | 15000 | 单次请求超时 |

## 17. 文件分享 (sendup.cc)

| 变量 | 默认 | 说明 |
|---|---|---|
| DISABLE_SENDUP | 0 | =1 关闭 sendup.cc 文件分享 |
| SENDUP_TIMEOUT_MS | 90000 | 单次上传总超时 (大文件需调高) |
| SENDUP_MAX_BYTES | 52428800 (50MB) | 文件大小上限 |

## 18. Xechat 平台 HTTP API

| 变量 | 默认 | 说明 |
|---|---|---|
| XE_API_BASE | https://dld.lesscoding.net | API 根 URL |
| XE_API_TIMEOUT_MS | 12000 | 单次请求超时 |
| XECHAT_API_USERNAME | (空) | Manager 鉴权用户名 |
| XECHAT_API_PASSWORD | (空) | Manager 鉴权密码 |
| XE_API_AUTH_PATH | /api/user/login | 鉴权端点 |
| XE_API_UPLOAD_PATH | /api/file/upload | 文件上传端点 |
| XE_API_MAX_UPLOAD_BYTES | 52428800 (50MB) | 上传文件大小上限 |

## 19. Python 沙箱

| 变量 | 默认 | 说明 |
|---|---|---|
| PYTHON_CMD | python | Python 解释器 |
| PYTHON_TIMEOUT_MS | 15000 | 单次执行超时 |

## 20. @ 提及聊天

| 变量 | 默认 | 说明 |
|---|---|---|
| DISABLE_MENTION | 0 | =1 关闭 @ 聊天 (`handleMention` 直接返回空串) |
| MENTION_CHAT_PREFIX | chat: | @ 聊天独立上下文 key 前缀 (与命令上下文隔离) |

## 21. 主动消息触发器 (NEW, 2026-08-28)

| 变量 | 默认 | 说明 |
|---|---|---|
| ENABLE_TRIGGER | 0 | =1 开启主动消息 (多人对话中主动插话) |
| TRIGGER_THRESHOLD | 10 | 每累计 N 条 (非自己) 消息触发一次 |
| TRIGGER_COOLDOWN_MS | 300000 | 触发后冷却 (防刷屏, 默认 5 min) |

## 22. Rage Mode / 攻击性 (NEW, 2026-08-28)

| 变量 | 默认 | 说明 |
|---|---|---|
| DISABLE_AGGRESSIVE | 0 | =1 关掉 (退回被动模式) |
| AGGRESSIVE_DURATION_MS | 480000 | 窗口长度 (默认 8 min) |
| AGGRESSIVE_COOLDOWN_MS | 12000 | 单次攻击后冷却 (默认 12s) |
| AGGRESSIVE_MAX_ATTACKS | 15 | 单轮窗口攻击上限 |
| AGGRESSIVE_ATTACK_RATE | 0.55 | 每条非 @ 消息的攻击概率 (0-1) |

详见 [aggressive.md](../business/aggressive.md)。

## 23. 拟人触发器 (NEW, 2026-08-28)

| 变量 | 默认 | 说明 |
|---|---|---|
| DISABLE_PERSONA | 0 | =1 关掉 (退回 main 默认 prompt) |
| PERSONA_DEFAULT_MODE | formal | 平局时默认 (formal / human) |
| PERSONA_TIE_MARGIN | 0.15 | human/formal 分差 < 此值视为平局 |
| PERSONA_LATE_HOUR_START | 0 | 几点起偏 human (默认 0 点) |
| PERSONA_LATE_HOUR_END | 7 | 几点止偏 human (默认 7 点) |
| PERSONA_STICKINESS_MAX | 200 | 黏性 FIFO 上限 |
| PERSONA_KIND | (空) | `casual`/`sarcastic`/`cold` (影响 prompt 风格) |
| PERSONA_NO_FAMILY_FILTER | 0 | =1 跳过 FAMILY_SLUR_HOMOPHONES 过滤 (几波大模式) |
| PERSONA_FORCE_HUMAN | 0 | =1 强制走 human 模式 (忽略评分) |
| PERSONA_NO_PREFIX | 0 | =1 不加 "啧/哎" 前置 |
| PERSONA_NO_GENERATE | 0 | =1 不调 LLM, 用内置李乐儿模板 |
| PERSONA_REGEN | | =1 启动强制重生成 (忽略缓存) |
| PERSONA_CACHE_FILE | `log/persona.json` | 生成结果落盘 (下次启动复用) |
| PERSONA_SEED_FILE | (空) | 自定义种子文件 (不走李乐儿) |

详见 [persona.md](../business/persona.md)。

## 24. 日志

| 变量 | 默认 | 说明 |
|---|---|---|
| AGENT_LOG | `agent.log` | 日志文件路径 |
| AGENT_QUIET | 0 | =1 不输出到 console |
| AGENT_DIR | `agent/` | 工作目录 |