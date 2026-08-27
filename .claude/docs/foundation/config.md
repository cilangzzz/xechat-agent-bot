# config.mjs — 配置模块

[`agent/config.mjs`](../../../agent/config.mjs) 把 `process.env` 聚合成单一配置对象, 整个 agent 仅在入口 `import` 一次。

## 1. 加载流程

```
node agent.mjs
   │
   ├─ loadDotEnv('.env')         ← 仅当 process.env[k] 未定义时注入
   │     └─ 解析 KEY=VALUE 行, # 开头 / 空行跳过
   │
   └─ loadConfig(process.env)    ← 类型转换 + 默认值 + 分组聚合
         └─ 返回 cfg: { host, port, proxy, llm, ... }
```

调用方 (`agent.mjs`) 通常这样写:

```js
import { loadDotEnv, loadConfig } from './config.mjs';
loadDotEnv();
export const cfg = loadConfig();
```

`loadConfig(env = process.env)` 接受可选 `env` 参数, 主要为测试注入假环境。

## 2. 配置分组

| 分组 | 关键键 | 含义 |
|---|---|---|
| **XE 连接** | `XE_HOST` / `XE_PORT` | 鱼塘 WS 端点, 默认 `101.42.19.160:33859` |
| **代理** | `PROXY_HOST` / `PROXY_PORT` | HTTP CONNECT 代理; `PROXY_PORT=0` 走直连 |
| **身份** | `BOT_USERNAME` / `BOT_STATUS` | 登录名 + 状态 (`FISHING`/`ONLINE`/`BUSY`) |
| **领养** | `OWNER` / `OWNER_PREFIX` | 非空 → 专属实例, 只服务该用户 |
| **指令** | `CMD_PREFIX` | 默认 `/大黄鱼` (跟登录名派生) |
| **@ 提及** | `DISABLE_MENTION` / `MENTION_CHAT_PREFIX` | @聊天独立上下文 |
| **思考输出** | `HIDE_THINKING` / `THINKING_PREFIX` | 工具结果是否带前缀发到聊天 |
| **XE 平台 API** | `XE_API_BASE` / `XE_API_TIMEOUT_MS` | 游戏/排行榜查询 |
| **多智能体** | `SUBAGENT_DEPTH` / `SUBAGENT_ITERATIONS` | delegate 防递归 + 单次步数 |
| **压缩** | `COMPACTION_TOKEN_BUDGET` / `COMPRESS_AT` / `SUMMARY_MAX_LEN` | 结构化摘要触发条件 |
| **待办 / 技能 / 记忆** | `TODO_MAX` / `DISABLE_SKILLS` / `ENABLE_MEMORY` | 默认关的能力开关 |
| **定时任务** | `DISABLE_SCHEDULE` / `SCHEDULE_TICK_MS` / `ENABLE_SCHEDULE_PERSIST` | 落盘可选 |
| **聊天记录** | `ROOM_LOG_MAX` / `DISABLE_CHAT_LOG` / `CHAT_LOG_MAX` | 内存 + JSONL 双层 |
| **文件分享** | `DISABLE_SENDUP` / `SENDUP_TIMEOUT_MS` / `SENDUP_MAX_BYTES` | sendup.cc 三步上传 |
| **主动消息** | `ENABLE_TRIGGER` / `TRIGGER_THRESHOLD` / `TRIGGER_COOLDOWN_MS` | 默认关, 有刷屏风险 |
| **LLM** | `DEEPSEEK_API_KEY` / `DEEPSEEK_BASE` / `DEEPSEEK_MODEL` / `LLM_TIMEOUT_MS` / `LLM_MAX_TOKENS` / `LLM_TEMPERATURE` / `LLM_MAX_TOOL_ITERATIONS` / `MOCK_*` | DeepSeek OpenAI 兼容 |
| **行为** | `HEARTBEAT_MS` / `STALE_TIMEOUT_MS` / `REPLY_COOLDOWN_MS` / `REPLAY_SKIP_MS` / `HISTORY_MAX` / `MSG_MAX_LEN` / `MSG_CHUNK_DELAY_MS` | 通用调参 |
| **重连** | `RECONNECT_REJECTED_MS` / `RECONNECT_NORMAL_MS` | 黑名单 vs 普通断线 |
| **Python / Web / 领养 / 日志** | `PYTHON_CMD` / `DISABLE_WEB` / `DISABLE_ADOPT` / `AGENT_LOG` / `AGENT_QUIET` | 其余可选能力 |

完整分类与默认值见 [`agent/.env.example`](../../../agent/.env.example)。

## 3. 关键陷阱

### 3.1 dotenv 不覆盖已存在的环境变量

```js
if (process.env[k] === undefined) process.env[k] = v;
```

**含义**: shell 已 `export` 的同名变量永远优先于 `.env`。
- CI / systemd 里想"以 .env 为准" → 必须先 `unset` 再启动
- Docker `ENV` 指令在 `CMD` 之前执行, 会被 `.env` 里的同名键"反向覆盖"
- 单元测试用 `process.env.KEY = 'mock'` 注入, 不会被 `.env` 干扰

### 3.2 bool 转换规则 (`bool = (v) => v === '1' || v === 'true' || v === 'yes'`)

- ✅ `ENABLE_MEMORY=1` → true
- ✅ `ENABLE_MEMORY=true` → true
- ❌ `ENABLE_MEMORY=` (空串) → **false**
- ❌ `ENABLE_MEMORY=0` → **false** (与直觉相反, 因为 `=== '1'` 不匹配)
- ❌ `ENABLE_MEMORY=yes` 实际为 true
- 多数开关用 `!bool(env.DISABLE_X)` 模式: 默认开启, `DISABLE_X=1` 才关

### 3.3 `PROXY_PORT=0` 直连

```js
const proxyPort = int(env.PROXY_PORT, 7897);
return { ..., direct: proxyPort === 0 };
```

`WsClient.runOnce` 看到 `direct=true` 时跳过 HTTP CONNECT 隧道, 直接 TCP 到 `host:port`。
**鱼塘预发会快速封禁新登录 IP, 挂机必须走稳定代理** —— 调试/单次连通用直连, 24×7 部署必须 `PROXY_PORT=<稳定代理端口>`。

### 3.4 整型陷阱

`int(v, dft)` 用 `parseInt(v, 10)`:
- `MSG_MAX_LEN=abc` → `NaN` → `NaN < 200` 为 false, 但分片逻辑可能崩; 启动时会打印但不会拒绝
- 空串 → 走默认值 `dft` ✅
- 浮点 `HEARTBEAT_MS=25.5` → `parseInt` 取 25, 静默截断

### 3.5 必填项缺失

- `DEEPSEEK_API_KEY` 缺失不会抛错, 而是退化为 `MOCK_LLM` 模式并在日志里告警
- 想"强制缺 key 即拒绝"需要自行在入口检查

## 4. 命令行参数覆盖

`config.mjs` **不解析**命令行参数。覆盖策略在 `agent.mjs` 里实现 (示例):

```js
// 解析 node agent.mjs --name=test --prefix=/test --owner=alice
const argv = process.argv.slice(2);
for (const a of argv) {
  const m = a.match(/^--(name|prefix|owner)=(.+)$/);
  if (!m) continue;
  const [, k, v] = m;
  if (k === 'name') process.env.BOT_USERNAME = v;
  if (k === 'prefix') process.env.CMD_PREFIX = v;
  if (k === 'owner') { process.env.OWNER = v; process.env.OWNER_PREFIX = `/${v}的${process.env.BOT_USERNAME || '大黄鱼'}`; }
}
```

**注意点**:
- 命令行覆盖在 `loadDotEnv()` **之后**执行, 所以总是优先于 `.env`
- `--owner=alice` 会**派生** `OWNER_PREFIX=/alice的大黄鱼`, 不要单独传 `--prefix`, 否则会被覆盖 (除非传在 `--owner` 之后)
- 该逻辑仅在主入口生效, **单元测试**直接调 `loadConfig({...})` 注入

## 5. .env 变量分类清单

完整分类与默认值见 [`agent/.env.example`](../../../agent/.env.example)。分组索引:

- 鱼塘连接 + 身份: `XE_HOST` `XE_PORT` `PROXY_HOST` `PROXY_PORT` `BOT_USERNAME` `BOT_STATUS` `OWNER` `OWNER_PREFIX` `CMD_PREFIX`
- 上下文与输出: `DISABLE_MENTION` `MENTION_CHAT_PREFIX` `HIDE_THINKING` `THINKING_PREFIX`
- 平台 API / 多智能体 / 压缩: `XE_API_BASE` `XE_API_TIMEOUT_MS` `SUBAGENT_DEPTH` `SUBAGENT_ITERATIONS` `COMPACTION_TOKEN_BUDGET` `COMPRESS_AT` `SUMMARY_MAX_LEN`
- 工具开关: `TODO_MAX` `DISABLE_SKILLS` `ENABLE_MEMORY` `MEMORY_FILE` `MEMORY_MAX_FACTS`
- 定时 / 聊天记录 / 文件分享 / 主动消息: 详见 `.env.example` 第 75–93 行
- LLM: `DEEPSEEK_API_KEY` `DEEPSEEK_BASE` `DEEPSEEK_MODEL` `LLM_TIMEOUT_MS` `LLM_MAX_TOKENS` `LLM_TEMPERATURE` `LLM_MAX_TOOL_ITERATIONS` `MOCK_LLM` `MOCK_TOOLCALL` `MOCK_LONG_REPLY`
- 行为调参 + 重连: `HEARTBEAT_MS` `STALE_TIMEOUT_MS` `REPLY_COOLDOWN_MS` `REPLAY_SKIP_MS` `HISTORY_MAX` `MSG_MAX_LEN` `MSG_CHUNK_DELAY_MS` `RECONNECT_REJECTED_MS` `RECONNECT_NORMAL_MS`
- Python / Web / 领养 / 日志: `PYTHON_CMD` `PYTHON_TIMEOUT_MS` `DISABLE_WEB` `WEB_TIMEOUT_MS` `DISABLE_ADOPT` `AGENT_LOG` `AGENT_QUIET`