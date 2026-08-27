# CHANGELOG

本文件为顶层分层变更日志，仅记录跨模块变更。各模块详细变更请查看对应模块的 CHANGELOG 占位文件。

## 摘要

- 当前 git 状态: 2 个 commit (initial import of agent + api from .verify_tmp; Initial commit)
- 项目阶段: 初始导入 (Initial Import)
- 生成时间: 2026-08-27

## 历史提交 (按时间倒序)

| Commit | 作者 | 日期 | 标题 | 影响范围 | 风险 | 回滚方式 |
|--------|------|------|------|----------|------|----------|
| f1011b3 | LiWeiHao | 2026-08-27 12:11:27 +0800 | chore: initial import of agent + api from .verify_tmp | agent/* + api/* | 低 (初始导入) | git revert f1011b3 |
| 002b2b5 | Cilang | 2026-08-27 10:59:55 +0800 | Initial commit | LICENSE/根结构 | 低 (占位) | git revert 002b2b5 |

## 提交详情

### f1011b3 — chore: initial import of agent + api from .verify_tmp

- 作者: LiWeiHao <2026-08-27 12:11:27 +0800>
- 影响范围: agent/* + api/*
- 变更统计: 38 files changed, 5897 insertions(+)
- 内容摘要:
  - agent/: 核心智能体实现 (agent.mjs, config.mjs) 与 lib/ 模块 (agents, chat-log, compaction, llm, memory, python-runner, reply, router, scheduler, sendup, sessions, skills, system, todo, tool-call-parse, tool-core, tools, trigger, web, ws-client, xechat-api)
  - agent/test/: e2e 测试与单元测试 (mock-server, run-e2e, unit-agent, verify-close-room, verify-list-rooms)
  - agent/spawn-dedicated.mjs, agent/spawn-fish.mjs: 进程启动脚本
  - agent/.env.example, agent/README.md, agent/package.json
  - api/api-docs.json: API 文档 (后于 docs 提交改名 `manager-api-docs.json`)
  - 根级: README.md, .gitignore
- 风险: 低 (初始导入)

### 002b2b5 — Initial commit

- 作者: Cilang <2026-08-27 10:59:55 +0800>
- 影响范围: LICENSE/根结构
- 变更统计: 2 files changed, 164 insertions(+)
- 内容摘要:
  - LICENSE: 许可证文件
  - .gitignore: 根级忽略规则
- 风险: 低 (占位)

## 各模块变更日志占位

```
### foundation/CHANGELOG.md 待补充
### business/CHANGELOG.md 待补充
### config/CHANGELOG.md 待补充
### api/CHANGELOG.md 待补充
### testing/CHANGELOG.md 待补充
```

## 变更分类指引

- 根级: 跨模块、根配置文件、许可证、CI/CD 等全局变更
- agent/: 智能体运行时、路由、工具、会话、记忆等
- api/: API 定义与文档

## 风险评估说明

- 项目处于"初始导入"阶段, 单一一次性 commit
- 后续每个 PR/feature 应按模块在对应 `.claude/docs/{module}/CHANGELOG.md` 追加
- 顶层 CHANGELOG 仅记录跨模块变更
- 回滚建议: 当前仅两个 commit, 如需整体回退可使用 `git revert` 或 `git reset` (注意 revert 对单次导入 commit 是安全的)
