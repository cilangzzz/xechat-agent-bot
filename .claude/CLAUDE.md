# 鱼塘 (Xechat) Agent Bot

## 1. 项目速览

- **定位**: 鱼塘 (Xechat) 聊天室的 AI 智能体骨架 —— 由原 `/小黄鱼` bot 升级而来, 参照 opencode 架构
- **核心特征**: 多智能体 (main/explore/math/summarize)、工具调用 (delegate/todo/skill/room/...)、自动重连、结构化上下文压缩、拟人形态触发器
- **技术栈**: Node.js >= 18 ESM (`.mjs`), 零外部依赖, DeepSeek LLM (OpenAI 兼容协议)
- **入口**: [agent/agent.mjs](agent/agent.mjs) · 配置: [agent/config.mjs](agent/config.mjs)
- **触发**: 指令前缀 `/大黄鱼` (登录名派生), 或 `@大黄鱼` 闲聊
- **运行模式**: 大众版默认登录名「大黄鱼」; `OWNER=<领养人>` 启动为专属实例, 仅服务该用户

## 2. 架构图

```
                         ┌──────────────────────────────────────┐
                         │  agent/agent.mjs  (入口 / 主循环)      │
                         │  · 组装 + 每用户并发锁 + 重连循环       │
                         └─────────────────┬────────────────────┘
                                           │
                ┌──────────────────────────┼──────────────────────────┐
                ▼                          ▼                          ▼
        ┌──────────────┐           ┌──────────────┐           ┌──────────────┐
        │ lib/found-   │           │ lib/business/│           │ lib/platform/│
        │ ation/ws-    │           │ router +     │           │ xechat-api / │
        │ client + llm │◄──────────│ sessions +   │           │ sendup / web │
        └──────────────┘           │ tools        │           │ python-runner│
                                   └──────┬───────┘           │ minimax-image│
                                          │                   │ pond-probe   │
                                          ▼                   └──────────────┘
                                ┌───────────────┐
                                │ lib/foundation│
                                │  /llm.mjs     │
                                │  · agentTurn  │
                                └───────────────┘
```

## 3. 模块地图

### 基础层 (lib/foundation/)

| 模块 | 职责 | 文档 |
|---|---|---|
| [config.mjs](agent/config.mjs) | 环境变量加载 + 配置聚合 | [README](.claude/docs/foundation/README.md) |
| [lib/foundation/ws-client.mjs](agent/lib/foundation/ws-client.mjs) | WS 连接 / 心跳 / 僵死看门狗 | [ws-client.md](.claude/docs/foundation/ws-client.md) |
| [lib/foundation/llm.mjs](agent/lib/foundation/llm.mjs) | LLM 客户端 + agent 回合 | [llm.md](.claude/docs/foundation/llm.md) |
| [lib/foundation/tool-core.mjs](agent/lib/foundation/tool-core.mjs) | `defineTool` 工具定义框架 | [tool-core.md](.claude/docs/foundation/tool-core.md) |
| [lib/foundation/tool-call-parse.mjs](agent/lib/foundation/tool-call-parse.mjs) | 泄漏工具调用文本恢复 | [tool-call-parse.md](.claude/docs/foundation/tool-call-parse.md) |
| [lib/foundation/compaction.mjs](agent/lib/foundation/compaction.mjs) | token 预算结构化压缩 | [compaction.md](.claude/docs/foundation/compaction.md) |
| [lib/foundation/system.mjs](agent/lib/foundation/system.mjs) | 系统提示词组合 | [system.md](.claude/docs/foundation/system.md) |

### 业务层 (lib/business/)

| 模块 | 职责 | 文档 |
|---|---|---|
| [agent.mjs](agent/agent.mjs) | 入口 / 主循环 / 消息分发 | [agent.md](.claude/docs/business/agent.md) |
| [lib/business/router.mjs](agent/lib/business/router.mjs) | 命令路由 + 子智能体指令 | [router.md](.claude/docs/business/router.md) |
| [lib/business/sessions.mjs](agent/lib/business/sessions.mjs) | 每用户会话 + 并发锁 | [sessions.md](.claude/docs/business/sessions.md) |
| [lib/business/agents.mjs](agent/lib/business/agents.mjs) | 多智能体定义 (main/explore/math/summarize) | [multi-agent.md](.claude/docs/business/multi-agent.md) |
| [lib/business/tools.mjs](agent/lib/business/tools.mjs) + [lib/business/tools/](agent/lib/business/tools/) | 工具注册表 + 16 个工具子模块 | [tools.md](.claude/docs/business/tools.md) |
| [lib/business/reply.mjs](agent/lib/business/reply.mjs) | 200 字符分片回复 | [reply.md](.claude/docs/business/reply.md) |
| [lib/business/skills.mjs](agent/lib/business/skills.mjs) + skill-* | 技能包 + opencode 风格管理 (fetch/frontmatter/grep/registry) | [skills.md](.claude/docs/business/skills.md) + [skill-system.md](.claude/docs/business/skill-system.md) |
| [lib/business/memory.mjs](agent/lib/business/memory.mjs) | 持久用户事实 (默认关) | [peripheral.md](.claude/docs/business/peripheral.md) |
| [lib/business/todo.mjs](agent/lib/business/todo.mjs) | 每会话待办 | [peripheral.md](.claude/docs/business/peripheral.md) |
| [lib/business/scheduler.mjs](agent/lib/business/scheduler.mjs) | 定时任务 | [peripheral.md](.claude/docs/business/peripheral.md) |
| [lib/business/chat-log.mjs](agent/lib/business/chat-log.mjs) | 聊天日志 (JSONL 持久化) | [peripheral.md](.claude/docs/business/peripheral.md) |
| [lib/business/trigger.mjs](agent/lib/business/trigger.mjs) | 主动消息触发器 (默认关) | [peripheral.md](.claude/docs/business/peripheral.md) |
| [lib/business/persona.mjs](agent/lib/business/persona.mjs) | 拟人形态触发器 (@ 提及切换 AI 助手/李乐儿人设) | [persona.md](.claude/docs/business/persona.md) |
| [lib/business/intent.mjs](agent/lib/business/intent.mjs) | 意图识别 (闲聊 vs 任务) | [intent.md](.claude/docs/business/intent.md) |
| [lib/business/aggressive.mjs](agent/lib/business/aggressive.mjs) | 攻击性 / 防骚扰过滤 | [aggressive.md](.claude/docs/business/aggressive.md) |
| [lib/business/subagent.mjs](agent/lib/business/subagent.mjs) | 子智能体派发 | [peripheral.md](.claude/docs/business/peripheral.md) |

### 平台层 (lib/platform/) — 鱼塘平台对接 / 外部服务

| 模块 | 职责 | 文档 |
|---|---|---|
| [lib/platform/xechat-api.mjs](agent/lib/platform/xechat-api.mjs) | 鱼塘平台 API 客户端 (Manager HTTP) | [peripheral.md](.claude/docs/business/peripheral.md) |
| [lib/platform/web.mjs](agent/lib/platform/web.mjs) | 联网搜索 / 抓 URL / 金价 | [peripheral.md](.claude/docs/business/peripheral.md) |
| [lib/platform/python-runner.mjs](agent/lib/platform/python-runner.mjs) | Python 执行器 (沙箱) | [peripheral.md](.claude/docs/business/peripheral.md) |
| [lib/platform/sendup.mjs](agent/lib/platform/sendup.mjs) | sendup.cc 文件分享 | [peripheral.md](.claude/docs/business/peripheral.md) |
| [lib/platform/minimax-image.mjs](agent/lib/platform/minimax-image.mjs) | Minimax 图像生成 | [peripheral.md](.claude/docs/business/peripheral.md) |
| [lib/platform/pond-probe.mjs](agent/lib/platform/pond-probe.mjs) | 跨鱼塘探测 | [peripheral.md](.claude/docs/business/peripheral.md) |

### 启动脚本 (agent/spawn-*.mjs)

| 脚本 | 用途 |
|---|---|
| [spawn-main.mjs](agent/spawn-main.mjs) | 主调度器 (启动领养实例池) |
| [spawn-fish.mjs](agent/spawn-fish.mjs) | 大众版单实例启动 |
| [spawn-dedicated.mjs](agent/spawn-dedicated.mjs) | 领养版单实例启动 |
| [spawn-jiboda.mjs](agent/spawn-jiboda.mjs) | 实例: 鸡脖打 |
| [spawn-stock-jiucai.mjs](agent/spawn-stock-jiucai.mjs) | 实例: 股票韭菜 |
| [spawn-strawberry-cake.mjs](agent/spawn-strawberry-cake.mjs) | 实例: 草莓蛋糕 |

### 参考层

| 资源 | 说明 | 文档 |
|---|---|---|
| [api/manager-api-docs.json](api/manager-api-docs.json) | Xechat Manager API OpenAPI (70 端点) | [README](.claude/docs/api/README.md) |
| [api/ws-protocol.md](api/ws-protocol.md) | WebSocket 聊天协议参考 (agent 核心协议) | [api/README.md](api/README.md) |
| [api/game-protocol.md](api/game-protocol.md) | 游戏房间 / 各游戏 DTO 协议 | [api/README.md](api/README.md) |
| [api/http-api.md](api/http-api.md) / [api/aux-services.md](api/aux-services.md) | 聊天服务器 HTTP 端点 / 辅助服务 | [api/README.md](api/README.md) |
| [agent/.env.example](agent/.env.example) | 配置模板 | [README](.claude/docs/config/README.md) |

## 4. 快速命令

```bash
cd agent
cp .env.example .env       # 填 DEEPSEEK_API_KEY 等
npm start                  # 启动 (node agent.mjs)
npm test                   # 单元 + 端到端 (全部离线)
npm run test:e2e           # 只跑端到端
MOCK_LLM=1 npm start       # 离线自测 (不调真实 LLM)
```

## 5. 文档导航

- 基础层模块详解: [foundation/README.md](.claude/docs/foundation/README.md)
- 业务层模块详解: [business/README.md](.claude/docs/business/README.md)
- 配置 / 环境变量: [config/README.md](.claude/docs/config/README.md)
- 鱼塘平台 API: [api/README.md](.claude/docs/api/README.md)
- 测试说明: [testing/README.md](.claude/docs/testing/README.md)
- 顶层变更日志: [CHANGELOG.md](.claude/docs/CHANGELOG.md)
- 构建进度: [_progress.md](.claude/docs/_progress.md)
- 项目根 README: [README.md](README.md) · agent 子目录: [agent/README.md](agent/README.md)

## 6. 核心约定

- **触发前缀**: `CMD_PREFIX` 默认 `/大黄鱼` (跟登录名派生), 领养实例为 `/<领养人>的大黄鱼`
- **回复分片**: 服务端单条聊天上限 200 字符 (`MSG_MAX_LEN`), `lib/business/reply.mjs` 自动按行边界优先切分
- **并发**: per-user `tryLock` —— 不同用户并行处理, 同一用户后续消息跳过; 全局 `REPLY_COOLDOWN_MS` 防刷
- **重连**: 登录被拒 30s (`RECONNECT_REJECTED_MS`) / 普通断线 3s (`RECONNECT_NORMAL_MS`)
- **私有通信**: 鱼塘 `toUsers` 实际是广播 (仅带目标标记), **不发敏感信息**, 持久记忆默认关闭

## 7. 文档分层说明

- **CLAUDE.md** (本文件): 主索引, 始终加载 —— 项目速览 / 架构 / 模块地图 / 约定
- **docs/{foundation,business,config,api,testing}/README.md**: 分类概览, 按需加载
- **docs/CHANGELOG.md**: 变更日志, 对照代码变更时查阅
- 子文件 (`api-*.md`, `data-model.md`, `pitfalls.md` 等): 深度参考, 具体任务时再读