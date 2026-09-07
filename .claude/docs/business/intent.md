# lib/business/intent.mjs — 意图分类器

[`agent/lib/business/intent.mjs`](../../../agent/lib/business/intent.mjs) 参考 opencode "detectSlashCommand + LLM 决策兜底" 思路, 对**带前缀但未命中 builtin** 的自由文本做一次便宜的 LLM 分类, 把消息路由到 `explore` / `math` / `room` / `query` / `chat` / `main` 等更便宜的子智能体路径。

## 1. 设计目标

- **作用域**: 只对带 `/大黄鱼` 前缀但未命中 builtin 表的文本生效; 无前缀消息完全不受影响
- **降级**: 任何失败/异常一律返回 `'main'`, 走主 agent 兜底
- **缓存**: 进程级 LRU (默认 64 条), 重复消息零成本复用
- **超时**: 默认 10s, 用 `Promise.race` 强制 reject

## 2. 7 类 Intent

```js
INTENT_LABELS = ['builtin', 'explore', 'math', 'room', 'query', 'chat', 'main']
```

| Intent | 含义 | 路由 |
|---|---|---|
| `builtin` | 命中 builtin 命令 (ping/help/todo/记忆/...) | router.mjs 的 builtin 分支 |
| `explore` | 联网搜索/抓网页/查外部信息 | explore 子智能体 |
| `math` | 计算/数据处理/画图/聚合 | math 子智能体 (python-runner) |
| `room` | 涉及游戏房间 (开/关/列表) | room 工具链 |
| `query` | 查鱼塘自身状态 (在线人数/游戏列表) | query 工具链 |
| `chat` | 闲聊/情感/玩笑 | chat 路径 (无工具) |
| `main` | 默认; 多步工具调用/写代码/复杂开放问题 | main agent 兜底 |

> `builtin` 在 classifier 内基本不会被返回 (router 已先做 builtin 匹配), 但保留在标签集里以便 fallback 语义清晰。

## 3. 核心 API

```js
classifyIntent(text, llm, opts = {}) → Promise<string>
```

| 参数 | 类型 | 说明 |
|---|---|---|
| `text` | string | 已去掉前缀的指令文本 (router 把 `sub+arg` 拼回) |
| `llm` | object | `createLlm()` 返回值, 需有 `chat()` |
| `opts.timeoutMs` | number | 默认 10000 |
| `opts.cache` | object | 默认进程级 `_intentCache` (LRU 64) |
| `opts.log` | function | 日志回调 |

**返回值**: 合法 intent 字符串 (`builtin`/`explore`/.../`main`); 失败/异常一律 `'main'`。

## 4. 系统提示词

`INTENT_SYSTEM_PROMPT` 用中文描述 7 类 + 例子, **严格要求只输出标签**:

> 你是大黄鱼 agent 的意图分类器。根据用户输入 (已带 /大黄鱼 前缀, 不含前缀本身), 只输出一个标签。
>
> 可选标签: `builtin` / `explore` / `math` / `room` / `query` / `chat` / `main`
>
> 只输出一个标签, 不要解释、不要标点、不要前后缀。

## 5. 内部流程

```
classifyIntent(text, llm)
   │
   ├─ text < 2 字符? → 返回 'main' (无需分类)
   │
   ├─ cache.get(text) 命中? → 返回缓存
   │
   ├─ Promise.race([
   │     llm.chat(INTENT_SYSTEM_PROMPT, [{role:'user', content: text}]),
   │     setTimeout(reject, 10s)
   │  ])
   │     ├─ 异常/超时 → 缓存 'main' → 返回 'main'
   │     └─ 成功 raw →
   │
   ├─ normalizeIntent(raw):
   │     trim → lowercase → 去前后缀标点 → 抽 "intent: x" 类修饰词 → 仅留 [a-z]
   │     └─ 不在白名单 → 返回 ''
   │
   ├─ intent 为 ''? → 缓存 'main' → 返回 'main'
   │
   └─ 缓存 (text → intent) → 返回 intent
```

## 6. `normalizeIntent(raw)` 边界处理

LLM 偶尔会输出 `"answer: main"` / `"意图: chat"` / `"分类: room"` 等带修饰词的结果。函数依次尝试:

1. `.trim().toLowerCase()`
2. 去前后缀标点 / 星号 / 反引号 (`/^[\s*`"'`]+|[\s*`"'`,。.!;:：)]+$/g`)
3. 匹配 `intent|label|意图|标签|分类|answer|输出|结果:` → 取第一捕获组
4. 仅留 `[a-z]`
5. 不在 `VALID_INTENTS` → 返回 `''` (上层兜底 `'main'`)

## 7. 进程级 LRU

```js
const _intentCache = makeLru(64);
```

- **LRU 实现**: 标准 Map + 命中时 `delete+set` 移到末尾 + 容量满时淘汰头部
- **为什么进程级**: agent 单进程、单 Router, 一个 LRU 足够 (无需 Redis)
- **为什么 64**: 鱼塘场景下常见问题会被反复问; 64 条覆盖一天内高频问题
- **导出名**: `_intentCache as intentCache` (供测试用)

## 8. 坑点

### 8.1 失败兜底必须为 `'main'`

任何异常 / 超时 / 无法识别 raw → 返回 `'main'`, **不要**抛错。这是为了避免 classifier 出错把整个 router 拖垮。

### 8.2 仅作用于带前缀文本

无前缀消息 (闲聊 / `@大黄鱼` 提及) **不走 classifier**, 直接进 agent.mjs 的沉默路径或 chat 处理。

### 8.3 LLM 必须便宜

分类器每次 chat 用 DeepSeek 小模型即可 (deepseek-v3.5-exp 或更便宜)。分类 prompt 用中文+例子是为了让小模型也能准确, 不要换成英文。

### 8.4 不要把缓存改成全局 Map

`_intentCache` 用 LRU 是有意为之。Map 顺序失效会让高频问题永远命中旧结果, 在鱼塘场景下问题答案会随时间变化 (比如 "今天金价")。

### 8.5 调用前确保 `llm.chat` 已初始化

classifier 不负责 LLM 初始化, 调用前必须确认 `createLlm(config)` 已返回有效 client。传 `null` 会抛 `TypeError`。