# 鱼塘 (Xechat) Agent Bot

鱼塘 (Xechat) 聊天室的 AI 智能体骨架 —— 由原 `/小黄鱼` bot 升级而来, 参照 opencode 架构实现多智能体 + 工具调用 + 自动重连。

- **触发**: 指令前缀 `/小黄鱼` (跟登录名派生), 领养实例为 `/<领养人>的小黄鱼`; 也可 `@小黄鱼` 闲聊
- **技术栈**: Node.js >= 18 ESM (`.mjs`), 零外部依赖, DeepSeek LLM (OpenAI 兼容协议)

## 文档导航

| 读者 | 入口 |
|---|---|
| 🤖 **AI 助手** | **从 [`.claude/CLAUDE.md`](.claude/CLAUDE.md) 开始** —— 项目主索引 (架构 / 模块地图 / 约定) |
| 👤 **开发者** | 先看本 README, 再深入 [`agent/README.md`](agent/README.md) 了解 agent 实现 |
| 📚 **全部文档** | [`.claude/docs/`](.claude/docs/) 分层目录 (foundation / business / config / api / testing / CHANGELOG) |

## 目录结构

```
xechat-agent-bot/
├── README.md                  # 本文件
├── LICENSE                    # MIT
├── agent/                     # 鱼塘 agent 智能体 (核心代码)
│   ├── agent.mjs              #   入口 + 主循环
│   ├── config.mjs             #   配置加载
│   ├── .env.example           #   环境变量模板
│   ├── lib/                   #   19 个 lib 模块 (ws-client / llm / router / tools / ...)
│   └── test/                  #   单元 + 端到端 + 真实环境验证
├── api/                       # 鱼塘平台 API 参考 (OpenAPI 3.0.1, 70 端点)
│   └── manager-api-docs.json  #   OpenAPI 原始文档 (标题 "Xechat Manager API")
└── .claude/                   # LLM 友好文档体系 (本项目分层文档)
    ├── CLAUDE.md              #   主索引 (始终加载到上下文)
    └── docs/                  #   分类文档 (按需加载)
        ├── foundation/        #     基础模块 (config/ws-client/llm/tool-core/...)
        ├── business/          #     业务模块 (agent/router/tools/multi-agent/...)
        ├── config/            #     配置 / 环境变量参考
        ├── api/               #     鱼塘平台 API 摘要
        ├── testing/           #     测试说明
        ├── CHANGELOG.md       #     顶层变更日志
        └── _progress.md       #     文档构建进度
```

## 快速开始

```bash
cd agent
cp .env.example .env          # 填入 DEEPSEEK_API_KEY 等
npm start                     # 启动 (node agent.mjs)
npm test                      # 单元 + 端到端 (全部离线)
MOCK_LLM=1 npm start          # 离线自测 (不调真实 LLM)
```

## 已知约束

- 鱼塘 `toUsers` 私聊**实际是广播**给所有客户端 (仅带目标标记), 并非真私密 —— 别在回复里发敏感信息。持久记忆默认关闭 (`ENABLE_MEMORY=0`)。
- 鱼塘预发会快速封禁新登录 IP, 挂机建议走稳定代理出口 (`PROXY_PORT` ≠ 0)。
- `close_room` / `close-room` 在鱼塘协议层**无房主/成员校验**, 任意用户可关闭任意房间 (M-2 已知缺陷)。

详见 [`agent/README.md`](agent/README.md) 与 [`.claude/docs/business/pitfalls.md`](.claude/docs/business/pitfalls.md)。