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

## 2026-08-28 —— 拟人形态 (persona) 触发器 v2: 李乐儿 + 启动动态生成人格

**范围**: `agent/lib/business/persona.mjs` (新增 `createPersonaEngine` + 内置李乐儿人设) + `router.mjs` / `config.mjs` / `agent.mjs` / `test/unit/persona.mjs`

**变更**:
- 拟人 prompt 从"鱼塘老网友"改为完整的**李乐儿人设**(姓名/小名/性别/年龄/职业/家乡云南昭通/现居北京/北大本科/性格/说话风格/背景/互动规则/示例对话/输出守门)
- **新增 `createPersonaEngine`**: 启动时异步调一次 LLM, 把李乐儿模板当种子打磨成最终人设 prompt, 落盘 `log/persona.json`, 之后 human 模式回复全部注入这份动态 prompt; 失败/未就绪自动退回内置模板
- 新增 `/大黄鱼 persona 生成` (手动重生成) ; `/大黄鱼 persona` 现在显示引擎状态 (status/source/长度/生成时间/上次错误)

**配置**: `PERSONA_NO_GENERATE` / `PERSONA_REGEN` / `PERSONA_CACHE_FILE` (叠加已有 `DISABLE_PERSONA` 等)

**风险**: 低。默认开启; 关闭 `DISABLE_PERSONA=1` 重启。启动生成是 fire-and-forget, 失败不影响连接与聊天 (退回种子)。不影响 trigger.mjs 主动插话。

## 2026-08-28 —— 拟人形态 (persona) 触发器

**范围**: `agent/lib/business/persona.mjs` (新增) + `router.mjs` / `config.mjs` / `agent.mjs` / `test/unit/persona.mjs` (新增)

**能力**: `@ 提及` 聊天新增"拟人形态"——根据 4 路信号 (文本特征 / 时间偏好 / 用户黏性 / 房间氛围) 自动在 `AI 助手腔`(formal) 与 `鱼塘老网友腔`(human) 之间切换回复人设。配套 `/大黄鱼 persona` 内置命令 (查询 / 测试 / 重置) 与 `[persona]` 调试日志。

**配置**: `DISABLE_PERSONA` / `PERSONA_DEFAULT_MODE` / `PERSONA_TIE_MARGIN` / `PERSONA_LATE_HOUR_START|END` / `PERSONA_STICKINESS_MAX`

**风险**: 低。默认开启 (与 main 默认行为叠加); 关闭只需 `DISABLE_PERSONA=1` 重启。不影响主动消息触发器 (trigger.mjs) 与领养/专属模式。

## 风险评估说明

- 项目处于"初始导入"阶段, 单一一次性 commit
- 后续每个 PR/feature 应按模块在对应 `.claude/docs/{module}/CHANGELOG.md` 追加
- 顶层 CHANGELOG 仅记录跨模块变更
- 回滚建议: 当前仅两个 commit, 如需整体回退可使用 `git revert` 或 `git reset` (注意 revert 对单次导入 commit 是安全的)
