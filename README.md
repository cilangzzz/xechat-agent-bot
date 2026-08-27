# 鱼塘 (Xechat) API 集成工作区

本目录用于 **鱼塘(Xechat)平台的 API 对接与 agent 智能体开发**（临时验证/开发用，未纳入 git）。

```
.verify_tmp/
├── api/        # 鱼塘 API 集成: 管理后台接口文档 + 注册/冒烟测试脚本与数据
├── agent/      # 鱼塘 agent 智能体骨架 (由 /小黄鱼 bot 升级, 可离线自测)
├── xechat-bot/ # 当前线上运行中的 /小黄鱼 bot (会实时回复鱼塘消息, 勿删勿停)
└── _misc/      # 与本项目无关的临时遗留 (O2OA/jira 等), 确认无用后可删
```

## api/ 内容

| 文件 | 说明 |
|---|---|
| `api-docs.json` | Xechat Manager API (xeManager) OpenAPI 文档 —— 70 个端点：游戏管理、用户/角色/菜单、排行榜、文件、部署历史等 |
| `register_batch.py` | lesscoding.net 注册接口批量测试脚本（多线程注册测试用户） |
| `register_1000.jsonl` / `register_100k.jsonl` | 批量注册结果（用户名 + token 等） |
| `smoke_test.jsonl` | 冒烟测试结果 |

## agent/ 内容

鱼塘聊天室里的 AI 智能体骨架 —— 触发指令 `/小黄鱼`，支持多用户会话、工具调用、自动重连。
详见 [agent/README.md](agent/README.md)。
