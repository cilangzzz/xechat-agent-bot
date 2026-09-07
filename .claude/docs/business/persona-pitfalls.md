# lib/business/persona.mjs — 坑点 (Pitfalls)

> 本文件是 [persona.md](./persona.md) §9 的展开。完整列举拟人触发器的已知坑点和调试建议。

## 1. 启动慢

`createPersonaEngine.init()` 调一次 LLM (10-30s), 启动期间 `getPrompt()` 返回空 → Router 自动 fallback 到李乐儿种子 (`BASE_PERSONA_PROMPT`)。

如果想跳过启动调 LLM:
- `PERSONA_REGEN=0` + 删除 `log/persona.json` 后**第一次启动会重生成**
- 复用已有 `log/persona.json` 则秒级

## 2. 落盘 prompt 必须包含关键事实

人设 prompt 落盘到 `log/persona.json`, 下次启动复用。如果手工修改, 必须保留:

| 必保留项 | 原因 |
|---|---|
| 姓名 / 年龄 / 家乡 / 性格 | 核心事实, LLM 后续生成都基于此 |
| 行为节奏 (50% ≤8 字等) | 失去这条 LLM 输出会全部变成长文 |
| 严禁段 (不要暴露 AI) | 失去这条 LLM 会写出 "我是 AI 助手" |
| 短回复指北 (≤6 字范本) | 失去这条 LLM 输出全是冗长 |

LLM 生成时也会被 `PERSONA_GENERATOR_SYSTEM` 强制要求不删这些。

## 3. 短回复指北不要扩展

`BASE_PERSONA_PROMPT` 里 "短回复指北" 列了 ≤6 字的真实回复模板, LLM 生成时**严禁**扩展成 "old wise guy" 娓娓道来的口吻。

如果发现 LLM 输出都是长文, 检查:
- `BASE_PERSONA_PROMPT` 是不是被人改过
- `log/persona.json` 是否被手工 edit 过 (覆盖了"短回复指北")
- 是不是 `lengthBudget === 'verbose'` 被强制了

## 4. `humanizeReply` 替换可能误伤

`FAMILY_SLUR_HOMOPHONES` 用 substring 匹配, 例子:

| 输入 | 输出 | 原因 |
|---|---|---|
| "你🐴呢" | "你[已过滤]呢" (或直接删) | substring 命中 "🐴" |
| "你妈" | "你[已过滤]" | substring 命中 "妈" |
| "马马虎虎" | (不变) | 单词, 没命中 FAMILY_SLUR |
| "nima" | "[已过滤]" | 拼音命中 |

测试时注意边界。如果你发现误伤 (例如把褒义词也过滤了), 提 PR 加白名单。

## 5. `_addReplyPrefix` 已有前置不重加

```js
// 已有: "啧 你🐴呢"  → 不加 (已有 "啧")
// 已有: "哎 我超"    → 不加 (已有 "哎")
// 已有: "呵 滚远点"  → 不加 (已有 "呵")
// 裸回: "你🐴呢"     → 加 "啧 你🐴呢" (随机)
// 裸回: "哈哈哈"     → 加 "嗯 哈哈哈" (随机)
```

| 情况 | 行为 |
|---|---|
| 0-6 字 + 无前置 | 加 (随机: 啧/哎/嗯嗯/呵/好家伙/我超) |
| 7+ 字 | 不加 |
| 已有前置 (啧/哎/嗯/哈/呵/我超/好家伙/我去/切/哈喽) | 不加 |
| `PERSONA_NO_PREFIX=1` | 整个函数变 no-op |

**不要在 prompt 里教 LLM 自己加前置**, 它会重复 (变成 "啧 啧 你🐴呢")。

## 6. `tieMargin = 0.15` 边缘不强制

如果 human 分和 formal 分相差 < 0.15, 退回 `defaultMode` (`MODE_FORMAL` 默认)。

这是有意为之 — 边缘情况不要冒险, 走稳的助手腔。如果想强制其中一种, 调高/调低 `tieMargin` (0 = 强制决出胜负; 1 = 永远 fallback)。

## 7. 与 trigger.mjs 不要双重启用

trigger.mjs 是**主动插话** (没有人 @ 我, 我主动发), persona.mjs 是**被 @ 时回复**。

| 配置 | 行为 |
|---|---|
| 都开 | bot 既主动插话又被 @ 时回复 |
| 同一聊天窗口同时触发 | 会重复刷屏 (例如, 别人刚说完话, trigger 主动发; 同时 @ 我, persona 回复) |

**建议**:
- 领养版 (单一用户) → 开 persona, 关 trigger
- 大众版 (多人) → 开 trigger, persona 可选

详见 [trigger 文档](#) (在 peripheral.md 里)。

## 8. 启动期 race condition

如果 router 在 `createPersonaEngine.init()` 完成前就开始处理 mention, `getPrompt()` 会返回 null → Router fallback 到 `getHumanSystemPrompt()` (内置种子)。

这是有意为之的**有意设计**, 不是 bug。启动期间的 mention 会:
- 走 human 分支 (mode='human')
- 用李乐儿种子 prompt (虽然 LLM 没打磨过, 但基本可用)

如果想完全等 init 完成, 在 agent.mjs 里 `await engine.init()` 再 `new Router(...)`。

## 9. 复读机升级模板依赖 `repeatCount`

`_buildChatSystemPrompt` 的复读机升级模板来自 `decision.repeatCount`:

- `repeatCount >= 3` → 加重怼模板 ("别装禅, 直接怼")
- `repeatCount >= 5` → 严重复读模板 ("上来就怼, 用最猛的词")

**必须** 从外部传 `repeatCount` (router.handleMention 从 `aggressive.mjs` 的 `tracker.record(from, content)` 取)。

如果忘了传 → 复读机升级模板不生效, LLM 不知道是第几次复读。

## 10. 日志噪音

每次 mention 都打 `[persona]` 日志, 群里活越频繁日志越多。如果不想看:

```js
// config.mjs 或 logger 里
if (!log.includes('[persona]')) log(line);  // 过滤
```

或者把 logger 改为 DEBUG 级别可选输出。

## 11. 调试建议

```bash
# 查看本轮评分详情
node -e "
import('./agent/lib/business/persona.mjs').then(m => {
  const r = m.scoreMessage('在吗');
  console.log(JSON.stringify(r, null, 2));
});
"

# 查看强制 human 模式
node -e "
import('./agent/lib/business/persona.mjs').then(m => {
  const t = m.createPersonaTrigger({});
  console.log(t.analyze('咋了', 'test-user'));
});
"
```