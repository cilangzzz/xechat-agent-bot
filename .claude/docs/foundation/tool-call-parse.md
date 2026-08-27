# `lib/tool-call-parse.mjs` —— 泄漏工具调用文本解析

> 模型鲁棒性兜底: 部分模型偶尔把"工具调用"输出成**纯文本** (XML/JSON) 而不走函数调用机制, 这个模块负责识别、恢复、剥除。

## 1. 问题场景

```
用户: 帮我查今天上海天气
模型: 我帮你查一下。
<tool_calls>
<invoke name="web_search">
<parameter name="query">上海天气</parameter>
</invoke>
</tool_calls>
```

如果不做处理, 这条回复会作为普通聊天发出去 —— 用户看到一坨 XML, 而且工具**根本没真执行**。两种语料来源都会触发:
- Anthropic 风格: `<tool_calls><invoke name="X"><parameter name="k">v</parameter>...</invoke></tool_calls>`
- OpenAI 风格: `{"name":"X","arguments":{...}}` 或 `{"tool":"X","input":{...}}`

## 2. 两个 API

### `extractToolCallFromText(text, knownTools?)`

```js
import { extractToolCallFromText } from './tool-call-parse.mjs';
const r = extractToolCallFromText(modelOutput, knownTools);
// r === null                          → 完全没有工具调用标记 (正常文本)
// r = { markers:true, calls:[] }      → 有标记但解析不出 (被截断/格式坏)
// r = { markers:true, calls:[{name, arguments}, ...] }
//                                    → 可恢复的工具调用数组
```

`knownTools` 集合传入后, 仅保留集合内的工具名 —— 防止用户聊天里恰好提到 `web_search` 触发误判。`null` = 不校验。

### `stripLeakedToolCallText(text)`

把工具调用块从文本里剥掉, 返剩余文本 (可能为空)。同时处理**未闭合** (被截断) 的块。
- 闭合块: `<tool_calls>...</tool_calls>` → 整段移除
- 未闭合: `<tool_calls>...` 截到行尾 → 移除
- 残余开标签 / 残缺 XML: 清掉
- 多余空白合并: `  ` → ` `

**绝不让原始 XML/JSON 出现在聊天回复里。**

## 3. 在 `llm.mjs` 中的三种处理路径

`runLoop` 拿到模型 `content` 但没有 `tool_calls` 时, 调 `recoverLeakedText(content)`:

### (1) 真正执行 —— 识别完整 + 可恢复

```js
const r = extractToolCallFromText(content, knownTools);
// r.calls.length > 0
// 1. 调 stripLeakedToolCallText 拿到"叙述部分", 作为 assistant 文本入栈
// 2. 逐个调 tools.dispatch 执行, 把结果以"合成 assistant(tool_calls) + tool"对回填
// 3. 返 'executed' 让 runLoop 继续下一轮
```

合成 `tool_call_id = "leaked_<k>_<name>"` 是为了满足 OpenAI 兼容 API 的 `tool_call_id` 关联校验。

### (2) 剥除泄漏文本 —— 已截断 / 无法恢复

```js
// r === null          → 完全正常, 原样返回
// r = {calls:[]}      → 有标记但解析不出 (被截断)
//   → log('检测到被截断的工具调用文本, 已剥除')
//   → 返 stripLeakedToolCallText(content) || '（我这边工具输出有点问题, 换个方式再试）'
```

用户**绝不能**看到原始 XML/JSON。这条路径是安全网, 不是主路径。

### (3) 收尾阶段 —— 迭代超限

`runLoop` 跑满 `maxIterations` 后的"收尾 3 轮"里, 仍然先走 `recoverLeakedText`:
- 若模型还在把工具写文本 → 剥掉 + 提示"再试一次"
- 这样**避免**模型在已无工具能力时被逼"用文本假装调用"

附加: 收尾前注入的 `system` 提示明确写"不要再继续调用同类工具重试, 不要把工具调用写成文本"。

## 4. 系统提示词的明令

`lib/system.mjs` 拼装的系统提示词里, 必须包含:

```
调用规则:
- 必须走函数调用机制 (tool_calls), 不要把工具调用写成 XML/JSON 文本
```

把"工具调用必须走函数调用机制"作为强约束写进 prompt, 大幅减少触发泄漏路径的概率。本模块是兜底, 不是常态路径。

## 5. 解析策略细节

### 顺序
1. 先剥 markdown 代码块围栏 (` ```xml ` / ` ```json ` / ` ``` `)
2. 优先识别 Anthropic XML (`<tool_calls>` 或 `<invoke name=...>`)
3. 没识别到再试 OpenAI JSON `{"name":"X","arguments":{...}}`
4. 标记 + 解析, 任一为正则继续

### 参数解析
- XML: `<parameter name="k">v</parameter>` 中 `v` 优先按 JSON 解析 (`[1,2,3]`、`{"a":1}` 等)
- JSON: `m[2]` 直接 `JSON.parse`; 失败则作为空对象
- 失败一律降级为空对象, 不抛错

### 已知工具过滤
```js
if (knownTools) {
  const known = calls.filter((c) => knownTools.has(c.name));
  if (known.length) return { markers:true, calls:known };
  return { markers:true, calls:[] };  // 全是陌生名, 当成截断走剥除路径
}
```

`knownTools` 由 `llm.runLoop` 用当前智能体的 `tools.list()` 构建 —— 子智能体白名单过滤在这里就生效。

## 6. 与 `tool-core` 的关系

```
content (纯文本)
    │
    ▼
extractToolCallFromText  ──→ { name, arguments }
    │
    ▼
tools.dispatch(name, args, ctx)   ←── tool-core.mjs
    │
    ▼
回填 tool 消息, 继续 runLoop
```

解析得到 `{name, args}` 后, 转交 `ToolRegistry.dispatch` 执行 —— 校验/截断/错误回流逻辑都沿用 `tool-core` 那套。本模块**只负责识别与剥除**, 不执行工具。

## 7. 测试要点

- 闭合 XML → 执行 → 不入聊天
- 未闭合 XML (模拟回复被截断) → 剥掉 → 入聊天
- 用户聊天里提到 `web_search` 但不构成调用 → 当正常文本通过 (`knownTools` 过滤)
- JSON 风格调用 → 解析 → 执行
- 套在 markdown 代码块里 → 先剥围栏再识别
