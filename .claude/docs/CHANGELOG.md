# CHANGELOG

本文件为顶层分层变更日志, 记录跨模块变更。各模块详细变更见对应模块的子文档 (如 [foundation/ws-client.md](./foundation/ws-client.md) §5.1 重写历史)。

> **2026-09-07 更新**: 同步 2026-08-27 → 2026-09-03 期间的 7 次重大提交。

## 摘要

- **当前 git 状态**: 9 个 commit (含 7 次 2026-08-27+ 重大特性提交)
- **项目阶段**: 持续演进 (已重构 + 多特性落地)
- **最近更新**: 2026-09-07

## 历史提交 (按时间倒序)

| Commit | 日期 | 标题 | 影响范围 | 风险 |
|--------|------|------|----------|------|
| [3e6cb26](#3e6cb26--feat-拟人形态触发器-persona--5-个-ws-测试-demo) | 2026-08-28 19:36 | feat: 拟人形态触发器 (persona) + 5 个 WS 测试 demo | persona.mjs + intent.mjs + agent/* | **HIGH** |
| [d474b50](#d474b50--feat-skill-管理扩展-opencode-风格--同期-persona--minimax--docs) | 2026-08-28 17:01 | feat: skill 管理扩展 (opencode 风格) + 同期 persona/minimax/docs | skill-{fetcher,frontmatter,grep,registry}.mjs + skills.mjs | **HIGH** |
| [fbb8025](#fbb8025--feat-generate_image-一站式生成上传--spawn-mainmjs) | 2026-08-28 15:21 | feat: generate_image 一站式生成+上传 + spawn-main.mjs | tools/image.mjs + spawn-main.mjs | MEDIUM |
| [470df85](#470df85--test-unit-agent-拆分为-testunit--编排器--修复-import-路径) | 2026-08-27 17:31 | test: unit-agent 拆分为 test/unit/ 编排器 + 修复 import 路径 | test/* (新增 7 个 unit/*.mjs) | LOW |
| [98b006a](#98b006a--refactor-agentlib-拆分为-foundationbusinessplatform-三层--tools-模块化) | 2026-08-27 16:06 | refactor: agent/lib 拆分为 foundation/business/platform 三层 + tools 模块化 | lib/ 整体重组 | **HIGH** |
| [aa1071b](#aa1071b--feat-probe_pond-工具--跨鱼塘探测模块化--3-个测试) | 2026-08-27 15:09 | feat: probe_pond 工具 + 跨鱼塘探测模块化 + 3 个测试 | lib/pond-probe.mjs + tools.mjs + probe-pond.mjs | MEDIUM |
| [27a5952](#27a5952--feat-鱼塘-api-调研成果落地--server_list-工具--协议文档) | 2026-08-27 14:14 | feat: 鱼塘 API 调研成果落地 —— server_list 工具 + 协议文档 | api/* (4 文档) + lib/xechat-api.mjs | MEDIUM |
| [f1011b3](#f1011b3--chore-initial-import-of-agent--api-from-verify_tmp) | 2026-08-27 12:11 | chore: initial import of agent + api from .verify_tmp | agent/* + api/* | 低 |
| [002b2b5](#002b2b5--initial-commit) | 2026-08-27 10:59 | Initial commit | LICENSE/根结构 | 低 |

---

## 提交详情

### 3e6cb26 — feat: 拟人形态触发器 (persona) + 5 个 WS 测试 demo

- **作者**: LiWeiHao <2026-08-28 19:36>
- **影响范围**: `lib/business/persona.mjs` (NEW, 922 行/45KB) + `lib/business/intent.mjs` (NEW, 4.4KB) + `lib/business/router.mjs` (+意图分类+拟人触发器集成) + `agent/test/ws-*.mjs` (5 NEW)
- **变更统计**: ~1000 insertions
- **内容摘要**:
  - `persona.mjs` (45KB): 拟人触发器 `createPersonaTrigger` + 动态人设 prompt 引擎 `createPersonaEngine` + `humanizeReply` / `_addReplyPrefix` 后处理 + `BASE_PERSONA_PROMPT` (李乐儿种子)
  - `intent.mjs`: 7 类意图分类器 (`builtin`/`explore`/`math`/`room`/`query`/`chat`/`main`) + LRU 缓存 + 兜底 'main'
  - `router.mjs`: 新增第三层 `_classifyAndDispatch` + `handleMention` 接入 persona 决策 (mode=mood/length/emoji/typo/reply)
  - `agent/test/ws-direct-connect.mjs` / `ws-edge-cases.mjs` / `ws-react-test.mjs` / `simulate-stock.mjs` / `check-proxy-ip.mjs` (5 个 WS 测试)
- **风险**: **HIGH** (persona 是核心回复路径, router 集成涉及主循环)

#### 回滚指南 (HIGH 风险)
```bash
git revert 3e6cb26
# 检查: lib/business/persona.mjs 是否删除, router.mjs handleMention 是否回退
# 副作用: 配置 PERSONA_DISABLE / INTENT_DISABLE 等 env vars 不再生效
# 测试: agent/test/ws-react-test.mjs 等 5 个测试需要回滚
```

### d474b50 — feat: skill 管理扩展 (opencode 风格) + 同期 persona / minimax / docs

- **作者**: LiWeiHao <2026-08-28 17:01>
- **影响范围**: `lib/business/skill-{fetcher,frontmatter,grep,registry}.mjs` (4 NEW) + `lib/business/skills.mjs` (新增 `getBuiltinSkills`) + `lib/business/tools/skill-{list,get,install,search}.mjs` (4 NEW, 拆分原 `skill` 单工具) + `lib/platform/minimax-image.mjs` (NEW)
- **变更统计**: ~1500 insertions
- **内容摘要**:
  - skill 系统 opencode 化: 多源合并 (builtin + user_dir + user_url) + frontmatter 解析 + 远程仓库协议 + ripgrep 优先回退 Node fs
  - tools/skill-* 4 拆分: `skill_list` / `skill_get` / `skill_install` / `skill_search` (替代原 `skill` 单工具)
  - Minimax 图像生成网关 (`minimax-image.mjs`)
  - skills.mjs: `getBuiltinSkills()` 给 SkillRegistry, `listSkills/getSkill` 标弃名
- **风险**: **HIGH** (skill 系统是 LLM 工具核心, 4 拆分涉及 schema 变更)

#### 回滚指南 (HIGH 风险)
```bash
git revert d474b50
# 检查: lib/business/skill-{fetcher,frontmatter,grep,registry}.mjs 是否删除
# 副作用: tools/skill-{list,get,install,search}.mjs 不可用, tools/skill.mjs (旧) 不存在
# 测试: skill-system 单元测试需要回滚
```

### fbb8025 — feat: generate_image 一站式生成+上传 + spawn-main.mjs

- **作者**: LiWeiHao <2026-08-28 15:21>
- **影响范围**: `lib/business/tools/image.mjs` (NEW, `generate_image`/`upload_image` 工具) + `spawn-main.mjs` (NEW, 主调度器)
- **变更统计**: ~250 insertions
- **内容摘要**:
  - `image.mjs`: 文生图 (走 Minimax 网关) + 一站式上传到鱼塘 (`upload_image`)
  - `spawn-main.mjs`: 启动主调度器, 管理多个领养实例
- **风险**: MEDIUM (新工具, 旧工具 `send_file` 标记废弃保留 git 历史)

### 470df85 — test: unit-agent 拆分为 test/unit/ 编排器 + 修复 import 路径

- **作者**: LiWeiHao <2026-08-27 17:31>
- **影响范围**: `agent/test/unit-agent.mjs` (重写) + `agent/test/unit/*.mjs` (7 NEW: _fixtures, _state, llm, parse-command, router, scheduler, sessions, tools)
- **变更统计**: ~700 insertions
- **内容摘要**: 单元测试从单文件拆分为 `test/unit/` 子目录, 用 `_fixtures.mjs` 共享 fixtures, 7 个独立 unit 模块 (parse-command / scheduler / sessions / tools / llm / router)
- **风险**: LOW (仅测试结构)

### 98b006a — refactor: agent/lib 拆分为 foundation/business/platform 三层 + tools 模块化

- **作者**: LiWeiHao <2026-08-27 16:06>
- **影响范围**: `lib/` 整体重组 (44 个文件迁移) + `lib/tools.mjs` 拆分 (686 行 → `lib/business/tools/` 16 模块) + `lib/business/subagent.mjs` (NEW, 子智能体委托抽出)
- **变更统计**: 58 files changed, 2172 insertions(+), 942 deletions(-)
- **内容摘要**:
  - lib/ → lib/foundation/ (ws-client, llm, compaction, system, tool-core, tool-call-parse) + lib/business/ (router, sessions, agents, skills, reply, todo, scheduler, chat-log, trigger, memory, subagent) + lib/platform/ (xechat-api, web, python-runner, sendup, minimax-image, pond-probe)
  - `lib/tools.mjs` 686 行 → `lib/business/tools/{state,compute,web,platform,game,delegate,todo,memory,scheduler,chat,probe,image,index,skill-*}mjs` 16 个 + `index.mjs` 组装入口
  - `lib/xechat-api.mjs` → `lib/platform/xechat-api.mjs` (业务无关)
  - `lib/web.mjs` → `lib/platform/web.mjs`
  - 新增 `lib/business/subagent.mjs` (SubagentDelegate 类)
- **风险**: **HIGH** (lib 重组 + tools 大拆分, 涉及所有 import 路径)

#### 回滚指南 (HIGH 风险)
```bash
git revert 98b006a
# 检查:
#   1) lib/foundation/ + lib/business/ + lib/platform/ 是否回退到 lib/
#   2) lib/business/tools/ 是否合并回 lib/tools.mjs
#   3) import 路径是否全改回 lib/...
# 副作用: commit aa1071b/fbb8025 依赖新结构 (pond-probe/image tools), 回滚后这两个 commit 也会坏
# 测试: test/unit/* 全部需要重写 (依赖新 import 路径)
```

### aa1071b — feat: probe_pond 工具 + 跨鱼塘探测模块化 + 3 个测试

- **作者**: LiWeiHao <2026-08-27 15:09>
- **影响范围**: `lib/pond-probe.mjs` (NEW, 探测协议) + `lib/tools.mjs` (`probe_pond` 工具) + `agent/probe-pond.mjs` (CLI) + `agents.mjs` (subagent 工具白名单)
- **变更统计**: ~290 insertions
- **内容摘要**:
  - `pond-probe.mjs`: 跨鱼塘探测协议 (WS LOGIN 后看 USER_STATE 广播)
  - `tools.probe_pond`: 工具封装 + 防自探测护栏 (host == config.host → 拒绝)
  - `agents.mjs`: 把 `probe_pond` 加入 explore 子智能体白名单
- **风险**: MEDIUM (新功能, 不影响主循环)

### 27a5952 — feat: 鱼塘 API 调研成果落地 —— server_list 工具 + 协议文档

- **作者**: LiWeiHao <2026-08-27 14:14>
- **影响范围**: `api/*` (4 个协议文档: ws-protocol.md 254行, game-protocol.md 237行, aux-services.md 166行, http-api.md 58行) + `lib/xechat-api.mjs` (`serverList` API) + `lib/tools.mjs` (`server_list` 工具) + `agent/probe-pond.mjs` (早期版本)
- **变更统计**: 17 files changed, 891 insertions(+), 151 deletions(-)
- **内容摘要**:
  - api/ 目录的 4 个协议文档 (鱼塘 WS / 游戏 DTO / HTTP / 辅助服务)
  - `server_list` 工具 (走 Xechat HTTP API, 列出所有可用服务器)
- **风险**: MEDIUM (新文档 + 新工具, 不影响主路径)

### f1011b3 — chore: initial import of agent + api from .verify_tmp

- **作者**: LiWeiHao <2026-08-27 12:11>
- **影响范围**: `agent/*` + `api/*`
- **变更统计**: 38 files changed, 5897 insertions(+)
- **内容摘要**: 初始导入 (详见原版)

### 002b2b5 — Initial commit

- **作者**: Cilang <2026-08-27 10:59>
- **影响范围**: LICENSE/根结构
- **风险**: 低

---

## 跨提交影响表 (合并相关提交)

| 功能 | 涉及提交 | 备注 |
|---|---|---|
| 拟人化回复 | 3e6cb26 (persona) + router 集成 | 后续可能有微调 |
| Skill 管理 (opencode 化) | d474b50 (skill-* 4 文件) + 27a5952 (server_list 间接) | 早期 `skill` 工具已弃用 |
| lib 三层重组 | 98b006a (主要) + aa1071b (pond-probe 跟着迁移) + fbb8025 (image tools 跟着新增) | 任何回滚 98b006a 的 PR 会导致后续 commit 失同步 |
| 测试结构 | 470df85 (unit 拆分) + 98b006a (跟着迁移 import 路径) | |

## 模块级变更日志占位

各模块详细变更请见对应子文档:

| 模块 | 文档 |
|---|---|
| foundation/ | [ws-client.md](./foundation/ws-client.md) §5.1 (2026-08-28 僵死看门狗重写) |
| business/router | [router.md](./business/router.md) §2.4 (意图分类), §3 (拟人触发器) |
| business/persona | [persona.md](./business/persona.md) §5 (引擎), §6 (后处理) |
| business/aggressive | [aggressive.md](./business/aggressive.md) §6 (Rage Mode 默认值) |
| business/intent | [intent.md](./business/intent.md) (整文, NEW) |
| business/skill-system | [skill-system.md](./business/skill-system.md) (整文, NEW) |
| business/tools | [tools.md](./business/tools.md) §2 (16 模块清单) |
| business/peripheral | [peripheral.md](./business/peripheral.md) §6 (lib/platform/ 重组) |
| config | [env-vars.md](./config/env-vars.md) §25 (新增汇总) |