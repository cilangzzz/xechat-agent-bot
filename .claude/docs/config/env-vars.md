# 环境变量清单

按 `agent/config.mjs` 分组列出全部环境变量。优先级: 命令行参数 > 已存在环境变量 > `.env` > 默认值 (见 [README.md](./README.md))。

所有开关遵循统一 bool 规则: `1` / `true` / `yes` → 开, 其余 (含 `0` / 空串) → 关。多数能力用 `DISABLE_X` 反开关: 默认开启, `=1` 才关。

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

## 4. 行为

| 变量 | 默认 | 说明 |
|---|---|---|
| HEARTBEAT_MS | 25000 | 心跳间隔 |
| STALE_TIMEOUT_MS | 90000 | 90s 无数据判定僵死, 触发重连 |
| REPLY_COOLDOWN_MS | 4000 | 对同一指令的最低回复间隔 (防刷) |
| REPLAY_SKIP_MS | 2000 | 登录瞬间的消息回放跳过窗口 |
| HISTORY_MAX | 10 | 每个会话保留的最近消息数 |
| MSG_MAX_LEN | 200 | 单条聊天消息字符上限 (服务端实测 201 即丢弃) |
| MSG_CHUNK_DELAY_MS | 600 | 超长回复分片间的发送间隔 (调大避免续片被丢弃) |

## 5. 重连

| 变量 | 默认 | 说明 |
|---|---|---|
| RECONNECT_REJECTED_MS | 30000 | 登录被拒 (黑名单?) 后等待重试 |
| RECONNECT_NORMAL_MS | 3000 | 普通断线后等待重试 |

## 6. 上下文压缩

| 变量 | 默认 | 说明 |
|---|---|---|
| COMPRESS_AT | 14 | 会话消息数达该值触发压缩 (需 > HISTORY_MAX; 兼容字段, 仍保留) |
| SUMMARY_MAX_LEN | 400 | 压缩摘要最大字符数 |
| COMPACTION_TOKEN_BUDGET | 3000 | 会话估计 token 达该值触发结构化压缩 (保留最近预算内消息) |

## 7. 多智能体

| 变量 | 默认 | 说明 |
|---|---|---|
| SUBAGENT_DEPTH | 1 | 子智能体最大嵌套深度 (delegate 工具防递归) |
| SUBAGENT_ITERATIONS | 6 | 子智能体单次最大工具调用步数 |

## 8. 待办

| 变量 | 默认 | 说明 |
|---|---|---|
| TODO_MAX | 20 | 每会话最大待办条数 (todo 工具/指令) |

## 9. 技能

| 变量 | 默认 | 说明 |
|---|---|---|
| DISABLE_SKILLS | 0 | =1 关闭技能包 (report/explain/analyze/translate/story/task) |

## 10. 记忆

| 变量 | 默认 | 说明 |
|---|---|---|
| ENABLE_MEMORY | 0 | =1 开启向磁盘记录用户事实 (聊天室非真私密, 默认关) |
| MEMORY_FILE | data/memory.json | 记忆落盘路径 |
| MEMORY_MAX_FACTS | 30 | 每用户最多保留事实条数 |

## 11. 定时任务

| 变量 | 默认 | 说明 |
|---|---|---|
| DISABLE_SCHEDULE | 0 | =1 关闭定时任务 |
| SCHEDULE_TICK_MS | 5000 | 到期检查间隔 |
| ENABLE_SCHEDULE_PERSIST | 0 | =1 落盘到 data/schedule.json, 重启恢复 |
| SCHEDULE_FILE | data/schedule.json | 定时任务落盘路径 |

## 12. 聊天记录

| 变量 | 默认 | 说明 |
|---|---|---|
| ROOM_LOG_MAX | 100 | 当前会话环形上限, 只记连接后收到的消息 (内存) |
| DISABLE_CHAT_LOG | 0 | =1 关闭聊天记录 JSONL 落盘 |
| CHAT_LOG_FILE | data/chat-log.jsonl | 日志落盘路径 (跨重启可查) |
| CHAT_LOG_MAX | 1000 | 日志保留上限 (超限裁剪最近) |

## 13. 主动消息

| 变量 | 默认 | 说明 |
|---|---|---|
| ENABLE_TRIGGER | 0 | =1 开启: 每累计 N 条 (非自己) 消息 → 主动发一条争议性广播 (默认关, 有刷屏风险) |
| TRIGGER_THRESHOLD | 10 | 每累计 N 条消息触发一次 |
| TRIGGER_COOLDOWN_MS | 300000 | 触发后冷却 (毫秒), 防刷屏 |

## 14. 文件分享

| 变量 | 默认 | 说明 |
|---|---|---|
| DISABLE_SENDUP | 0 | =1 关闭文件分享 (sendup.cc 三步上传) |
| SENDUP_TIMEOUT_MS | 90000 | 单次上传总超时 (大文件需调高) |
| SENDUP_MAX_BYTES | 52428800 | 文件大小上限 (默认 50MB) |

## 15. 联网

| 变量 | 默认 | 说明 |
|---|---|---|
| DISABLE_WEB | 0 | =1 关闭联网工具 (web_search / fetch_url / gold_price, 走代理) |
| WEB_TIMEOUT_MS | 15000 | 联网请求超时 |

## 16. Python

| 变量 | 默认 | 说明 |
|---|---|---|
| PYTHON_CMD | python | Python 可执行文件 |
| PYTHON_TIMEOUT_MS | 15000 | Python 执行超时 |

## 17. 平台 API

| 变量 | 默认 | 说明 |
|---|---|---|
| XE_API_BASE | https://dld.lesscoding.net | Xechat 客户端 API 基址 (实际前缀是 /api/, 非 api-docs 的 /xeManager) |
| XE_API_TIMEOUT_MS | 12000 | 平台 API 请求超时 |

## 18. 思考展示

| 变量 | 默认 | 说明 |
|---|---|---|
| HIDE_THINKING | 0 | =1 关闭思考结果展示 (默认: 调用工具后把带 💭 前缀的「工具查询结果」发到聊天) |
| THINKING_PREFIX | 💭 | 思考结果消息前缀, 与正式回答区分 |

## 19. @ 提及

| 变量 | 默认 | 说明 |
|---|---|---|
| DISABLE_MENTION | 0 | =1 关闭 @ 聊天 (收到 "@机器人 …" 只聊天: 不触发命令/工具/应用查询) |
| MENTION_CHAT_PREFIX | chat: | @ 聊天独立上下文 key 前缀 (与命令上下文隔离) |

## 20. 领养

| 变量 | 默认 | 说明 |
|---|---|---|
| DISABLE_ADOPT | 0 | =1 关闭领养功能 (主 agent 拉起专属实例) |
| NODE_CMD | process.execPath | 拉起子进程用的 Node 可执行文件 |
| AGENT_DIR | agent 目录 | 子进程工作目录 |

## 21. 日志

| 变量 | 默认 | 说明 |
|---|---|---|
| AGENT_LOG | agent/agent.log | 日志文件路径 |
| AGENT_QUIET | 0 | =1 关闭控制台日志输出 |

---

快速参考:

- 复制模板: `cp agent/.env.example agent/.env`, 必填 `DEEPSEEK_API_KEY`。
- 离线自测: `MOCK_LLM=1 npm start`。
- 直连调试: `PROXY_PORT=0`; 长期挂机: 设稳定 `PROXY_HOST` / `PROXY_PORT`。
- 开关类全部可 `DISABLE_X=1` 关闭; 记录类默认路径均在 `agent/data/` 下。
