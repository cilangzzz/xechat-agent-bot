# `lib/llm.mjs` —— LLM 调用层

> OpenAI 兼容协议 (DeepSeek 默认) 的客户端 + agent 工具循环编排。参照 `opencode session/processor.ts`, 鱼塘 agent 的"大脑"。

## 1. 入口工厂

```js
import { createLlm } from './llm.mjs';

const llm = createLlm({
  apiKey, base, model,
  timeoutMs, maxTokens, temperature,
  maxToolIterations,
  mock, mockToolCall, mockLongReply,
}, log);

llm.chat(systemPrompt, history);          // 单轮纯对话
llm.agentTurn({ systemPrompt, history, tools, onThinking, from, depth }); // 主智能体回合
llm.agentRun({ agentName, systemPrompt, task, tools, onThinking, from, depth }); // 子智能体回合
```

## 2. 三种公开方法

| 方法 | 用途 | 是否带工具 |
|---|---|---|
| `chat(sys, history)` | 单轮纯文本对话 —— 触发器、定时 auto 模式、结构化压缩、主动广播 | 否 (`tools=null`) |
| `agentTurn(ctx)` | 主智能体回合 —— 用户发起的 `/大黄鱼 ...` 或 `@大黄鱼 ...` 处理 | 是 (使用传入的 `tools` 视图) |
| `agentRun(ctx)` | 子智能体回合 —— 由 delegate/explore/math 等指令复用, 独立历史 + 子工具白名单 | 是 (子视图) |

`agentTurn` 与 `agentRun` 都复用同一 `runLoop` 工具循环, 差异:
- **历史入口**: `agentTurn` 沿用用户消息历史; `agentRun` 把 `task` 包成单条 `user` 消息, 上下文隔离
- **depth 默认**: `agentTurn` 默认 `depth=0` (顶层), `agentRun` 默认 `depth=1` (子任务), 防止无限递归
- **返回值**: `agentTurn` 返 `string`, `agentRun` 返 `{ agent, result }`
- **maxIterations 默认**: `agentTurn` 用全局 `maxToolIterations`, `agentRun` 默认更保守的 6

## 3. 工具循环 `runLoop`

```
callOnce → 检查 tool_calls
├─ 有 tool_calls → executeToolCalls → 回填 tool 消息 → 注入 Reflect → 下一轮
└─ 纯文本 → recoverLeakedText 检测泄漏工具调用
   ├─ 识别出完整调用 → 恢复执行 + 回填
   └─ 仅标记/被截断 → 剥掉 (用户看不到乱码)
```

**鲁棒性兜底**:
- **空回复**: 丢弃历史, 只带当前用户消息重试一次; 还失败就返"换个问题试试"
- **网络瞬时错误**: 自动重试一次 (第二次不再捕获)
- **Doom-loop 守护**: 同 `name|args` 指纹连续 3 次相同 → 强制停止, 防止无限循环
- **迭代超限**: 推到收尾阶段, 注入 `system` 提示"够就给最终回答, 不够就如实说", 再给最多 3 轮工具调用机会 —— 让模型真正调用工具收尾, 而非把工具写成文本

## 4. 多步 Reflect

每次工具结果回填后 (留最后一轮), 注入一条 `user` 角色的 `REFLECT_PROMPT`:

> 工具结果已就绪。先静默评估: 1) 当前信息够回答用户的原始问题吗? 2) 不够 → 还缺什么? 3) 多步调研应在 todo_update 记录步骤。**禁止** 拿到一个工具结果就直接总结。

借鉴 `opencode` 的"每步工具结果后由模型自己反思"模式 (prompt-level, 无结构化 Reflect 工具)。

## 5. 截断 / 重试 / Mock

### 输出截断
工具结果过长会污染上下文。`truncateResult` 在 `tool-core.dispatch` 内按工具 `budget` (默认 4000 字) 截断字符串字段, 数组 / 对象内字符串字段同样处理。

### 状态广播
工具执行上下文里有 `status(msg)` 函数 (即 `think`)。长时间操作的工具可以调用 `await think('正在抓详情…')` 向聊天广播 💭 进度。

### Mock 模式 (默认全关)

| 环境变量 | 测什么 |
|---|---|
| `MOCK_LLM=1` | 全部 `callOnce` 走假分支, 返回 `[mock回复] 收到: ...`, 不打真实 API |
| `MOCK_TOOLCALL=1` | 仅在带工具的调用里注入 `room_stats` mock tool_call, 触发工具循环 —— 测 `runLoop` 的恢复/Doom-loop/收尾 |
| `MOCK_LONG_REPLY=1` | 当用户消息含 `TESTLONG` 时返 `LONGREPLY\| + 480 个'长'`, 测 200 字分片回复 |

`mockToolCall` 故意只在 `tools != null` 且尚无 `tool` 消息时触发, 保证纯 `chat` (定时/主动广播) 不被工具循环污染。

## 6. 配置项清单

```js
createLlm({
  apiKey,                 // 默认读 cfg.apiKey (DEEPSEEK_API_KEY); 缺则要求设 MOCK_LLM=1
  base,                   // API base URL, 默认指向 DeepSeek, OpenAI 协议
  model,                  // 模型名 (deepseek-chat / deepseek-reasoner 等)
  timeoutMs,              // 单次 HTTP 超时 (AbortController)
  maxTokens,              // max_tokens (影响输出上限)
  temperature,            // 采样温度
  maxToolIterations,      // runLoop 最大迭代 (默认由调用方传, 主 agent 与子 agent 不同)
  mock,                   // MOCK_LLM
  mockToolCall,           // MOCK_TOOLCALL
  mockLongReply,          // MOCK_LONG_REPLY
}, logFn);
```

## 7. 兼容性

- **协议**: OpenAI Chat Completions (POST `{base}/chat/completions`, `Authorization: Bearer <key>`)
- **换供应商**: 改 `base` + `model` 即可指向任意 OpenAI 兼容端点 (本地 Ollama / LM Studio / 其他云厂商)
- **公开 API 稳定**: `chat` / `agentTurn` / `agentRun` 三个对外方法签名与旧版一致

## 8. 与上下游的关系

```
router / scheduler
    ↓
agentTurn(系统提示词+历史+tools视图)        ←── 主入口
    ↓ runLoop
tool-core.dispatch → 实际工具
    ↓ (工具结果回填)
callOnce(POST /chat/completions) ←── DeepSeek 等
```

依赖: `tool-core.mjs` (通过 `tools` 视图)、`tool-call-parse.mjs` (泄漏文本解析与剥除)。
