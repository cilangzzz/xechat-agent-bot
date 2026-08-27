# 鱼塘 (Xechat) Agent Bot

## 1. 项目速览

- **定位**: 鱼塘 (Xechat) 聊天室的 AI 智能体骨架 —— 由原 `/小黄鱼` bot 升级而来, 参照 opencode 架构
- **核心特征**: 多智能体 (main/explore/math/summarize)、工具调用 (delegate/todo/skill/room/...)、自动重连、结构化上下文压缩
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
        │  lib/ws-     │           │  lib/router  │           │  lib/scheduler│
        │  client.mjs  │           │   .mjs       │           │  .mjs        │
        │  WS 连接层    │◄──────────│  路由 + 命令   │           │  定时任务    │
        └──────┬───────┘           └──────┬───────┘           └──────────────┘
               │                          │
               │                  ┌───────┴────────┐
               │                  ▼                ▼
               │          ┌──────────────┐  ┌──────────────┐
               │          │ lib/sessions │  │  lib/tools   │
               │          │   .mjs       │  │  .mjs        │
               │          │  会话+压缩    │  │  工具注册表   │
               │          └──────┬───────┘  └──────┬───────┘
               │                 │                 │
               └─────────────────┼─────────────────┘
                                 ▼
                     ┌───────────────────────┐
                     │   lib/llm.mjs         │
                     │   · agentTurn /       │
                     │     agentRun          │
                     │   · DeepSeek API      │
                     └───────────────────────┘
```

## 3. 模块地图

### 基础层 (连接 / LLM / 工具底座)

| 模块 | 职责 | 文档 |
|---|---|---|
| [config.mjs](agent/config.mjs) | 环境变量加载 + 配置聚合 | [README](.claude/docs/foundation/README.md) |
| [lib/ws-client.mjs](agent/lib/ws-client.mjs) | WS 连接 / 心跳 / 僵死看门狗 | [README](.claude/docs/foundation/README.md) |
| [lib/llm.mjs](agent/lib/llm.mjs) | LLM 客户端 + agent 回合 | [README](.claude/docs/foundation/README.md) |
| [lib/tool-core.mjs](agent/lib/tool-core.mjs) | `defineTool` 工具定义框架 | [README](.claude/docs/foundation/README.md) |
| [lib/tool-call-parse.mjs](agent/lib/tool-call-parse.mjs) | 泄漏工具调用文本恢复 | [README](.claude/docs/foundation/README.md) |
| [lib/compaction.mjs](agent/lib/compaction.mjs) | token 预算结构化压缩 | [README](.claude/docs/foundation/README.md) |
| [lib/system.mjs](agent/lib/system.mjs) | 系统提示词组合 | [README](.claude/docs/foundation/README.md) |

### 业务层 (入口 / 路由 / 会话 / 工具)

| 模块 | 职责 | 文档 |
|---|---|---|
| [agent.mjs](agent/agent.mjs) | 入口 / 主循环 / 消息分发 | [README](.claude/docs/business/README.md) |
| [lib/router.mjs](agent/lib/router.mjs) | 命令路由 + 子智能体指令 | [README](.claude/docs/business/README.md) |
| [lib/sessions.mjs](agent/lib/sessions.mjs) | 每用户会话 + 并发锁 | [README](.claude/docs/business/README.md) |
| [lib/agents.mjs](agent/lib/agents.mjs) | 多智能体定义 (main/explore/math/summarize) | [README](.claude/docs/business/README.md) |
| [lib/tools.mjs](agent/lib/tools.mjs) | 工具注册表 | [README](.claude/docs/business/README.md) |
| [lib/reply.mjs](agent/lib/reply.mjs) | 200 字符分片回复 | [README](.claude/docs/business/README.md) |
| [lib/skills.mjs](agent/lib/skills.mjs) | 技能包 (report/explain/analyze/...) | [README](.claude/docs/business/README.md) |
| [lib/memory.mjs](agent/lib/memory.mjs) | 持久用户事实 (默认关) | [README](.claude/docs/business/README.md) |
| [lib/todo.mjs](agent/lib/todo.mjs) | 每会话待办 | [README](.claude/docs/business/README.md) |
| [lib/scheduler.mjs](agent/lib/scheduler.mjs) | 定时任务 | [README](.claude/docs/business/README.md) |
| [lib/chat-log.mjs](agent/lib/chat-log.mjs) | 聊天日志 (JSONL 持久化) | [README](.claude/docs/business/README.md) |
| [lib/trigger.mjs](agent/lib/trigger.mjs) | 主动消息触发器 (默认关) | [README](.claude/docs/business/README.md) |
| [lib/web.mjs](agent/lib/web.mjs) | 联网搜索 / 抓 URL / 金价 | [README](.claude/docs/business/README.md) |
| [lib/python-runner.mjs](agent/lib/python-runner.mjs) | Python 执行器 (沙箱) | [README](.claude/docs/business/README.md) |
| [lib/sendup.mjs](agent/lib/sendup.mjs) | sendup.cc 文件分享 | [README](.claude/docs/business/README.md) |
| [lib/xechat-api.mjs](agent/lib/xechat-api.mjs) | 鱼塘平台 API 客户端 | [README](.claude/docs/business/README.md) |

### 参考层

| 资源 | 说明 | 文档 |
|---|---|---|
| [api/api-docs.json](api/api-docs.json) | Xechat Manager API OpenAPI (70 端点) | [README](.claude/docs/api/README.md) |
| `.env.example` | 配置模板 | [README](.claude/docs/config/README.md) |

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

- 基础层模块详解: [.claude/docs/foundation/README.md](.claude/docs/foundation/README.md)
- 业务层模块详解: [.claude/docs/business/README.md](.claude/docs/business/README.md)
- 配置 / 环境变量: [.claude/docs/config/README.md](.claude/docs/config/README.md)
- 鱼塘平台 API: [.claude/docs/api/README.md](.claude/docs/api/README.md)
- 测试说明: [.claude/docs/testing/README.md](.claude/docs/testing/README.md)
- 项目根 README: [README.md](README.md) · agent 子目录: [agent/README.md](agent/README.md)
- 构建进度: [.claude/docs/_progress.md](.claude/docs/_progress.md)

## 6. 核心约定

- **触发前缀**: `CMD_PREFIX` 默认 `/大黄鱼` (跟登录名派生), 领养实例为 `/<领养人>的大黄鱼`
- **回复分片**: 服务端单条聊天上限 200 字符 (`MSG_MAX_LEN`), `lib/reply.mjs` 自动按行边界优先切分
- **并发**: per-user `tryLock` —— 不同用户并行处理, 同一用户后续消息跳过; 全局 `REPLY_COOLDOWN_MS` 防刷
- **重连**: 登录被拒 30s (`RECONNECT_REJECTED_MS`) / 普通断线 3s (`RECONNECT_NORMAL_MS`)
- **私有通信**: 鱼塘 `toUsers` 实际是广播 (仅带目标标记), **不发敏感信息**, 持久记忆默认关闭

## 7. 文档分层说明

- **CLAUDE.md** (本文件): 主索引, 始终加载 —— 项目速览 / 架构 / 模块地图 / 约定
- **docs/{foundation,business,config,api,testing}/README.md**: 分类概览, 按需加载 —— 每层模块详细说明
- **docs/CHANGELOG.md**: 变更日志, 对照代码变更时查阅
- 子文件 (`api-*.md`, `data-model.md`, `pitfalls.md` 等): 深度参考, 具体任务时再读
