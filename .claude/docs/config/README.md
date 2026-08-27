# 配置层文档

本目录说明 agent 的配置体系: 配置来源与优先级、部署形态、运行模式。完整环境变量清单见 [env-vars.md](./env-vars.md); 底层加载机制与坑点见 [foundation/config.md](../foundation/config.md)。

## 1. 配置层次 (4 层优先级)

`agent/config.mjs` 从 4 个来源取值, 优先级从高到低:

| 优先级 | 来源 | 说明 |
|---|---|---|
| 1 | **命令行参数** (`--name` / `--prefix` / `--owner`) | 由 `agent.mjs` 入口解析, 在 `loadDotEnv()` 之后写入 `process.env`, 总是覆盖 `.env` |
| 2 | **已存在的环境变量** | shell `export` / systemd / Docker `ENV` 注入的同名变量, 永远优先于 `.env` |
| 3 | **`.env` 文件** | `loadDotEnv()` 仅当 `process.env[k] === undefined` 时注入, 不覆盖已存在的变量 |
| 4 | **config.mjs 默认值** | `loadConfig()` 内 `||` / `int(v, dft)` 兜底 |

关键规则:

- **命令行 > 环境变量 > .env > 默认值**, 高优先级存在即生效。
- 命令行参数不解析于 `config.mjs` 本身, 而由 `agent.mjs` 入口实现: `--name` 写 `BOT_USERNAME`, `--prefix` 写 `CMD_PREFIX`, `--owner` 写 `OWNER` 并**派生** `OWNER_PREFIX`。
- `.env` 是"首次启动的种子"而非权威来源: 想强制以 `.env` 为准, 需先 `unset` 同名变量再启动。
- 单元测试直接 `loadConfig({...})` 注入假环境, 不受 `.env` 干扰。

## 2. 部署形态

### 2.1 大众版 (默认)

- `BOT_USERNAME=大黄鱼`, `CMD_PREFIX=/大黄鱼`, `OWNER` 为空。
- 单实例服务房间内所有用户, 谁都能用 `CMD_PREFIX` 触发。

### 2.2 领养 / 专属

- `OWNER=<领养人>` → 专属模式: 只回复该领养人, 其他人消息忽略。
- `OWNER_PREFIX` 由主 agent 自动派生为 `/<领养人>的大黄鱼` (也可手动配)。
- 由主 agent 通过**领养 (adopt) 功能**拉起独立进程时自动注入, 一般不需要手动配置 (见 `.env.example` 领养段)。

## 3. 三种工作模式

### 3.1 真实模式 (生产)

- `DEEPSEEK_API_KEY` 已配置 → 调真实 DeepSeek (OpenAI 兼容) API。
- `PROXY_PORT` 非 0 → 经 `PROXY_HOST:PROXY_PORT` HTTP CONNECT 代理隧道连接鱼塘。

### 3.2 Mock 模式 (离线自测)

- `MOCK_LLM=1` → 不调真实 API, 返回固定回复, 全链路离线可测。
- `MOCK_TOOLCALL=1` → 首轮 mock 返回工具调用, 测工具循环与思考结果输出。
- `MOCK_LONG_REPLY=1` → mock 返回超长回复, 测 200 字符分片。
- `DEEPSEEK_API_KEY` 缺失时自动退化为 Mock 模式并告警。

### 3.3 直连 vs 代理

- `PROXY_PORT=0` → `direct=true`, 直接 TCP 到 `XE_HOST:XE_PORT`。
- `PROXY_PORT>0` → 先与代理建 TCP, 发 `CONNECT host:port`, 收 `200` 后再做 WS 握手。
- 注意: 鱼塘预发会快速封禁新登录 IP, **长期 24×7 挂机建议走稳定代理出口**; 调试/单次连通用直连即可。

## 4. 相关文档

- [env-vars.md](./env-vars.md) — 完整环境变量清单 (按 config.mjs 分组, 含默认值与说明)
- [foundation/config.md](../foundation/config.md) — 加载流程、bool/整型陷阱、CLI 覆盖细节
- [agent/.env.example](../../../agent/.env.example) — 配置模板 (复制为 `.env` 后修改)
