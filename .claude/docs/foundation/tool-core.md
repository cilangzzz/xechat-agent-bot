# `lib/tool-core.mjs` —— 工具定义框架 + 注册表

> 工具定义的"语法"和执行原语。参照 `opencode tool/tool.ts + session/tools.ts`。**纯框架**, 不含具体工具实现 —— 业务工具 (web_search / todo_update / delegate 等) 写在 [lib/tools.mjs](../business/tools.md) 里。

## 1. `defineTool()` —— 工具定义规范

```js
import { defineTool } from './tool-core.mjs';

const myTool = defineTool({
  id: 'web_search',                           // 工具唯一名 (兼容 name 字段)
  description: '搜索关键词, 返 top-5 摘要',     // 给 LLM 看的描述
  parameters: {                                // OpenAI function schema 风格
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索关键词' },
      limit: { type: 'integer', description: '最多 N 条' },
    },
    required: ['query'],
  },
  budget: 4000,                                // 字符串输出最大字符数, 超出截断
  run: async (args, ctx) => {                  // 工具实现
    const { query, limit = 5 } = args;
    const { status, depth, from } = ctx;
    status(`正在搜索 ${query}…`);
    return { hits: [...] };
  },
});
```

字段说明:
- `id` / `name`: 二选一, 缺一会抛错; `id` 优先
- `description`: 进 system prompt / OpenAI function 描述, 写清"何时用、输入输出是什么"
- `parameters`: 标准 JSON Schema 子集 (`type` + `properties` + `required`), 同步给 LLM
- `budget`: 字符串字段最大长度, 防止工具回填污染上下文 (默认 4000)
- `run(args, ctx)`: 工具体, `ctx` 含 `status` (广播)、`from` / `depth` (来源/递归深度) 等共享上下文

## 2. 参数校验 `validateArgs()`

极简实现: **必填字段 + 原始类型** (`string` / `number` / `integer` / `boolean` / `array`), 失败返错误数组。

```js
validateArgs({ required:['query'], properties:{ query:{type:'string'} } }, {})
// → ['缺少必填参数「query」']
```

校验失败时 `dispatch` 不会抛, 而是把错误以 `{error: '工具「X」参数有误: 缺少必填参数「query」。请修正参数后重试。'}` 回流给 LLM —— 这是借鉴 `opencode InvalidArgumentsError` 的"模型可读修参提示", 让下一轮模型能自行修正参数。

## 3. 输出截断 `truncateResult()`

- 字符串: 超过 `budget` 切到 `budget` 字符 + `...[输出过长已截断]` 标记
- 数组: 每个元素若是字符串, 各自截断
- 对象: 每个字段若是字符串, 各自截断 (其他类型保留)

不在这里做"安全截断按 token"的精细操作 —— 目标是"别让一个工具的回填把上下文撑爆"。

## 4. `ToolRegistry` —— 注册表

```js
const reg = new ToolRegistry({ status: think, from });
reg.register(myTool);
reg.register(anotherTool);
```

### `dispatch(name, args, extra)`

真正执行入口:

```js
reg.dispatch('web_search', { query: '鱼塘' }, { depth: 0 });
// 成功 → { hits: [...] } (字符串已截断)
// 参数错 → { error: '工具「web_search」参数有误: 缺少必填参数「query」...' }
// 抛错   → { error: 'fetch failed' } (catch 后包成对象)
// 未知工具 → { error: '未知工具: xxx' }
```

返回统一是对象 (`{ok, content}` 或 `{ok:false, error}` 风格)。LLM 拿到的是 `error` 字符串, 模型能据此"知错就改"。

### `filter(ids)`

按 id 集合产子视图 (浅共享底层定义), 用于**多智能体工具可见性**:

```js
const mainTools = reg.filter(['web_search','todo_update','delegate','room_stats']);
const subTools  = reg.filter(['web_search','python_run']);  // 子智能体只能搜索+python
```

子视图是新的 `ToolRegistry`, 但实际工具定义 (`run` 函数) 仍指向底层 —— 节省内存, 同步生效。

### `openAiSchemas()`

把当前注册表转成 OpenAI function calling 所需的 `[{type:'function', function:{name,description,parameters}}]`, 直接喂给 LLM。

### `describe()`

纯文本 `- id: description` 列表, 用于**系统提示词里展示工具清单**。

### `list()` / `has(name)`

`list()` 返所有 id; `has(name)` 判断是否存在 —— `llm.mjs` 用 `list()` 构建 `knownTools` 集合, 配合 `tool-call-parse.mjs` 区分"真工具调用"与"用户聊天里恰好提到工具名"。

## 5. 与 `tools.mjs` 的关系

| 维度 | `tool-core.mjs` | `tools.mjs` |
|---|---|---|
| 类型 | 框架 (无具体业务) | 注册表实例化 |
| 内容 | `defineTool` / `validateArgs` / `truncateResult` / `ToolRegistry` 类 | 注册 `web_search` / `todo_update` / `delegate` / `python_run` / `room_*` / ... |
| 谁依赖 | 被 `tools.mjs` 和 `llm.mjs` 都依赖 | 被 `router / scheduler / agentTurn / agentRun` 调用 |

简单说: **`tool-core` 是"语法"**, **`tools` 是"用这套语法写出来的工具集"**。

## 6. 在系统提示词里如何展示

```js
const sysPrompt = `
你是「大黄鱼」, 鱼塘聊天室的 AI 助手。

# 可用工具
${reg.describe()}

调用规则:
- 必须走函数调用机制 (tool_calls), 不要把工具调用写成 XML/JSON 文本
- 拿到工具结果先反思 (够不够? 缺什么?), 别一个结果就总结
`;
```

`describe()` 返纯文本, 直接插到 system prompt。完整提示词模板在 [lib/system.mjs](../foundation/system.md) 拼装。

## 7. 验证

```js
reg.has('web_search');             // true
reg.dispatch('不存在', {});          // { error: '未知工具: 不存在' }
validateArgs({required:['q'], properties:{q:{type:'integer'}}}, {q:'x'});
// → ['参数「q」应为整数']
```
