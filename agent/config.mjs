// 鱼塘 agent 智能体 —— 配置模块
// 全部配置来自环境变量, 不硬编码任何密钥/Token。
// 用法: 复制 .env.example 为 .env 并按需修改, 或直接在 shell 里 export。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 支持从 .env 文件加载 (KEY=VALUE, # 注释), 不覆盖已存在的环境变量
export function loadDotEnv(file = path.join(__dirname, '.env')) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, k, v] = m;
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

const int = (v, dft) => (v === undefined || v === '' ? dft : parseInt(v, 10));
const bool = (v) => v === '1' || v === 'true' || v === 'yes';

export function loadConfig(env = process.env) {
  const proxyPort = int(env.PROXY_PORT, 7897);
  return {
    // —— 鱼塘(Xechat) 连接 ——
    host: env.XE_HOST || '101.42.19.160',
    port: int(env.XE_PORT, 33859),
    // 代理: PROXY_PORT=0 表示直连 (注意: 鱼塘预发会快速封禁新登录 IP, 挂机建议走稳定代理)
    proxy: { host: env.PROXY_HOST || '127.0.0.1', port: proxyPort },
    direct: proxyPort === 0,
    // 登录身份 (默认大黄鱼; 领养后的专属实例登录名为 <领养人>的大黄鱼)
    username: env.BOT_USERNAME || '大黄鱼',
    status: env.BOT_STATUS || 'FISHING', // FISHING / ONLINE / BUSY ...
    uuid: 'web-' + Math.random().toString(36).slice(2),

    // —— 领养/专属模式 (独立进程启动时注入) ——
    owner: env.OWNER || '',               // 非空 → 专属模式: 只回复该领养人
    ownerPrefix: env.OWNER_PREFIX || '',  // 专属触发前缀, 如 /牛来少年的大黄鱼

    // —— 指令 ——
    cmdPrefix: env.CMD_PREFIX || '/大黄鱼',

    // —— @ 提及聊天 (收到 @机器人 的消息也响应, 但只聊天: 不触发命令/工具/应用查询) ——
    mention: {
      enabled: !bool(env.DISABLE_MENTION), // DISABLE_MENTION=1 关闭 @ 聊天
      chatKeyPrefix: env.MENTION_CHAT_PREFIX || 'chat:', // @聊天独立上下文 key 前缀(与命令上下文隔离)
    },

    // —— 思考过程输出到鱼塘聊天 ——
    showThinking: !bool(env.HIDE_THINKING),      // HIDE_THINKING=1 则不在聊天里展示思考结果
    thinkingPrefix: env.THINKING_PREFIX || '💭', // 思考结果消息前缀, 便于与正式回答区分

    // —— Xechat 平台 API (游戏/排行榜/服务器/上传) ——
    api: {
      base: env.XE_API_BASE || 'https://dld.lesscoding.net',
      timeoutMs: int(env.XE_API_TIMEOUT_MS, 12000),
      // —— 鉴权 + 文件上传 (upload_image 工具, 需登录) ——
      username: env.XECHAT_API_USERNAME || '',
      password: env.XECHAT_API_PASSWORD || '',
      authPath: env.XE_API_AUTH_PATH || '/api/user/login',
      uploadPath: env.XE_API_UPLOAD_PATH || '/api/file/upload',
      maxUploadBytes: int(env.XE_API_MAX_UPLOAD_BYTES, 50 * 1024 * 1024),
    },

    // —— 多智能体 (参考 opencode 的 agent 定义: 每 agent 独立提示词+工具白名单) ——
    agents: {
      subagentDepth: int(env.SUBAGENT_DEPTH, 1), // 子智能体最大嵌套深度 (delegate 工具防递归)
      subagentIterations: int(env.SUBAGENT_ITERATIONS, 6), // 子智能体单次最大工具调用步数
    },

    // —— 结构化上下文压缩 (token 预算 + 结构化摘要, 参考 opencode compaction) ——
    compaction: {
      budgetTokens: int(env.COMPACTION_TOKEN_BUDGET, 3000), // 会话估计 token 达该值才触发压缩
    },

    // —— 每会话待办 (todo 工具) ——
    todo: {
      maxItems: int(env.TODO_MAX, 20), // 每会话最大待办条数
    },

    // —— 技能包 (skill_* 工具, 参考 opencode skill) ——
    skills: {
      enabled: !bool(env.DISABLE_SKILLS),          // DISABLE_SKILLS=1 关闭技能包
      dataDir: env.SKILLS_DIR || path.join(__dirname, 'data', 'skills'), // 用户/远程 skill 落地目录
      remoteUrls: (env.SKILLS_URLS || '').split(',').map((s) => s.trim()).filter(Boolean), // 启动时自动同步的远程仓库 (逗号分隔)
      extraPaths: (env.SKILLS_PATHS || '').split(',').map((s) => s.trim()).filter(Boolean), // 额外扫描的本地目录 (逗号分隔)
      maxContentChars: int(env.SKILLS_MAX_CONTENT_CHARS, 8000), // skill_get 返回的 content 上限 (字符)
      grepLimit: int(env.SKILLS_GREP_LIMIT, 100),                // skill_search 最大命中数
      grepTimeoutMs: int(env.SKILLS_GREP_TIMEOUT_MS, 5000),     // grep 超时
    },

    // —— 持久记忆 (remember/recall 工具; 聊天室非真私密, 默认关) ——
    memory: {
      enabled: bool(env.ENABLE_MEMORY), // ENABLE_MEMORY=1 开启向磁盘记录用户事实
      file: env.MEMORY_FILE || path.join(__dirname, 'data', 'memory.json'),
      maxFactsPerUser: int(env.MEMORY_MAX_FACTS, 30), // 每用户最多保留事实条数
    },

    // —— 定时任务 (schedule 工具 / /大黄鱼 定时) ——
    scheduler: {
      enabled: !bool(env.DISABLE_SCHEDULE),   // DISABLE_SCHEDULE=1 关闭定时任务
      tickMs: int(env.SCHEDULE_TICK_MS, 5000), // 到期检查间隔
      persist: bool(env.ENABLE_SCHEDULE_PERSIST), // =1 落盘, 重启恢复
      file: env.SCHEDULE_FILE || path.join(__dirname, 'data', 'schedule.json'),
    },

    // —— 当前会话聊天记录 (recent_messages 工具, 只记连接后收到的, 不回溯历史) ——
    roomLog: {
      maxEntries: int(env.ROOM_LOG_MAX, 100), // 环形上限
    },

    // —— 聊天记录日志 (chat_log 工具 / /大黄鱼 聊天记录; JSONL 持久化, 跨重启可查) ——
    chatLog: {
      enabled: !bool(env.DISABLE_CHAT_LOG),   // DISABLE_CHAT_LOG=1 关闭落盘
      file: env.CHAT_LOG_FILE || path.join(__dirname, 'data', 'chat-log.jsonl'),
      maxEntries: int(env.CHAT_LOG_MAX, 1000), // 保留上限(超限裁剪最近)
    },

    // —— 文件分享 (sendup.cc 三步上传, send_file 工具 / /大黄鱼 发送文件) ——
    sendup: {
      enabled: !bool(env.DISABLE_SENDUP),      // DISABLE_SENDUP=1 关闭文件分享
      timeoutMs: int(env.SENDUP_TIMEOUT_MS, 90000), // 单次上传总超时(大文件需调高)
      maxBytes: int(env.SENDUP_MAX_BYTES, 50 * 1024 * 1024), // 文件大小上限(默认 50MB)
    },

    // —— 多人发言主动消息触发器 (默认关, 有刷屏风险需显式开启) ——
    trigger: {
      enabled: bool(env.ENABLE_TRIGGER),     // ENABLE_TRIGGER=1 开启主动消息
      threshold: int(env.TRIGGER_THRESHOLD, 10),   // 每累计 N 条(非自己)消息触发一次
      cooldownMs: int(env.TRIGGER_COOLDOWN_MS, 300000), // 触发后冷却, 防刷屏
    },

    // —— 拟人形态触发器 (@ 提及聊天: AI 助手腔 vs 鱼塘老网友腔) ——
    persona: {
      enabled: !bool(env.DISABLE_PERSONA),    // DISABLE_PERSONA=1 关掉 (退回 main 默认 prompt)
      defaultMode: env.PERSONA_DEFAULT_MODE === 'human' ? 'human' : 'formal', // 平局时默认
      tieMargin: Number(env.PERSONA_TIE_MARGIN || 0.15), // human/formal 分差 < 此值视为平局
      hourBiasHumanStart: int(env.PERSONA_LATE_HOUR_START, 0),  // 几点起偏 human (默认 0 点)
      hourBiasHumanEnd: int(env.PERSONA_LATE_HOUR_END, 7),      // 几点止偏 human (默认 7 点)
      stickinessSize: int(env.PERSONA_STICKINESS_MAX, 200),     // 黏性 FIFO 上限
    },

    // —— LLM (DeepSeek, OpenAI 兼容) ——
    llm: {
      apiKey: env.DEEPSEEK_API_KEY, // 必填; 缺失时退化为 MOCK_LLM 模式并告警
      base: env.DEEPSEEK_BASE || 'https://api.deepseek.com',
      model: env.DEEPSEEK_MODEL || 'deepseek-v4-flash',
      timeoutMs: int(env.LLM_TIMEOUT_MS, 20000),
      maxTokens: int(env.LLM_MAX_TOKENS, 800),     // 单次生成上限(调高让算法层生成完整内容, 由 sendReply 按200字符分片)
      temperature: Number(env.LLM_TEMPERATURE || 1.0),
      maxToolIterations: int(env.LLM_MAX_TOOL_ITERATIONS, 8), // 单轮最多工具调用次数(agent loop 步数)
      mock: bool(env.MOCK_LLM), // MOCK_LLM=1 → 不调真实 API, 返回固定回复(离线自测用)
      mockToolCall: bool(env.MOCK_TOOLCALL), // MOCK_TOOLCALL=1 → mock 第一轮返回工具调用, 用于测工具循环/思考结果输出
      mockLongReply: bool(env.MOCK_LONG_REPLY), // MOCK_LONG_REPLY=1 → mock 返回超长回复, 用于测分片发送
    },

    // —— 行为 ——
    heartbeatMs: int(env.HEARTBEAT_MS, 25000),       // 心跳间隔
    staleTimeoutMs: int(env.STALE_TIMEOUT_MS, 90000),// 90s 无数据判定僵死重连
    replyCooldownMs: int(env.REPLY_COOLDOWN_MS, 4000),// 对同一指令的最低回复间隔(防刷)
    replaySkipMs: int(env.REPLAY_SKIP_MS, 2000),      // 登录瞬间的消息回放跳过窗口
    historyMax: int(env.HISTORY_MAX, 10),             // 每个会话保留的最近消息数
    msgMaxLen: int(env.MSG_MAX_LEN, 200),             // 单条聊天消息最大字符数(服务端实测上限 200)
    msgChunkDelayMs: int(env.MSG_CHUNK_DELAY_MS, 600),// 超长回复分片间发送间隔(调大避免续片被丢弃)
    reconnect: {
      loginRejectedMs: int(env.RECONNECT_REJECTED_MS, 30000), // 登录被拒(黑名单?)后等待
      normalMs: int(env.RECONNECT_NORMAL_MS, 3000),           // 普通断线后等待
    },

    // —— 上下文压缩 (参考 Claude Code: 旧消息 LLM 摘要 + 保留最近) ——
    context: {
      compressAt: int(env.COMPRESS_AT, 14),        // 会话消息数达到该值触发压缩(需>historyMax)
      summaryMaxLen: int(env.SUMMARY_MAX_LEN, 400),// 摘要最长字符数
    },

    // —— Python 执行 (python 工具) ——
    python: {
      cmd: env.PYTHON_CMD || 'python',
      timeoutMs: int(env.PYTHON_TIMEOUT_MS, 15000),
    },

    // —— MiniMax 图片生成 (generate_image 工具, 文生图/图生图) ——
    // 参考 H:\Documents\software-dev-ai-workflow\0.0-通用skill\docs-minimax-docs\图片生成.md
    minimaxImage: {
      apiKey: env.MINIMAX_API_KEY || '',          // 留空 = 工具不可用 (返回明确错误)
      base:   env.MINIMAX_BASE || 'https://api.minimaxi.com',
      timeoutMs: int(env.MINIMAX_IMAGE_TIMEOUT_MS, 120000),
    },

    // —— 联网 (web_search / fetch_url / gold_price, 走代理) ——
    web: {
      enabled: !bool(env.DISABLE_WEB),  // DISABLE_WEB=1 关闭联网工具
      timeoutMs: int(env.WEB_TIMEOUT_MS, 15000),
    },

    // —— 领养 (主 agent 拉起专属实例) ——
    adopt: {
      enabled: !bool(env.DISABLE_ADOPT),      // DISABLE_ADOPT=1 关闭领养
      maxInstances: int(env.ADOPT_MAX_INSTANCES, 5),  // 同时在线的专属子实例上限 (含本进程已知的 + 在线用户里 *的<鱼种> 模式)
      nodeCmd: env.NODE_CMD || process.execPath,
      agentDir: env.AGENT_DIR || __dirname,
    },

    // —— 日志 ——
    logFile: env.AGENT_LOG || path.join(__dirname, 'agent.log'),
    logToConsole: !bool(env.AGENT_QUIET),
  };
}
