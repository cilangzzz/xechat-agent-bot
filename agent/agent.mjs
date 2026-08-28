// 鱼塘 agent 智能体 —— 入口
// 把 /大黄鱼 bot 升级为可扩展的 agent 骨架:
//   连接层(ws-client) + 会话(sessions) + 路由/工具(router) + LLM(llm) 组装成一体。
// 运行:  node agent.mjs          (先按 README 配置 .env 或环境变量)
// 离线自测: MOCK_LLM=1 PROXY_PORT=0 node agent.mjs  (或跑 test/run-e2e.mjs)
import fs from 'node:fs';
import { loadConfig, loadDotEnv } from './config.mjs';
import { WsClient } from './lib/foundation/ws-client.mjs';
import { createLlm } from './lib/foundation/llm.mjs';
import { SessionStore } from './lib/business/sessions.mjs';
import { Router, extractMention } from './lib/business/router.mjs';
import { XechatApi } from './lib/platform/xechat-api.mjs';
import { makeReplySender } from './lib/business/reply.mjs';
import { MemoryStore } from './lib/business/memory.mjs';
import { Scheduler } from './lib/business/scheduler.mjs';
import { createTrigger } from './lib/business/trigger.mjs';
import { createPersonaEngine } from './lib/business/persona.mjs';
import { ChatLog } from './lib/business/chat-log.mjs';
import { uploadContent as sendupUpload } from './lib/platform/sendup.mjs';
import { createImageGenerator } from './lib/platform/minimax-image.mjs';
import { SkillRegistry } from './lib/business/skill-registry.mjs';
import { getBuiltinSkills } from './lib/business/skills.mjs';

loadDotEnv();
// —— 命令行动态参数: node agent.mjs [登录名] [--prefix /xxx] [--owner 领养人] [--help]
// 位置参数或 --name/-n 指定登录名, 优先于 .env; 默认触发前缀随登录名派生。
applyArgs(process.argv);
const cfg = loadConfig();
const startTime = Date.now();

function applyArgs(argv) {
  const args = argv.slice(2);
  if (!args.length) return;
  let name, prefix, owner;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--name' || a === '-n') { name = args[++i]; }
    else if (a === '--prefix' || a === '-p') { prefix = args[++i]; }
    else if (a === '--owner') { owner = args[++i]; }
    else if (a === '--help' || a === '-h') {
      console.log('用法: node agent.mjs [登录名] [--prefix /前缀] [--owner 领养人]\n'
        + '示例:\n'
        + '  node agent.mjs 大黄鱼                  # 以「大黄鱼」登录, 前缀 /大黄鱼\n'
        + '  node agent.mjs --name 大黄鱼 --prefix /dg   # 自定义登录名+前缀\n'
        + '  node agent.mjs --owner 老王            # 专属模式: 只服务老王, 名 老王的大黄鱼\n'
        + '  node agent.mjs                        # 用 .env 配置');
      process.exit(0);
    }
    else if (name === undefined) { name = a; } // 位置参数 = 登录名
  }
  if (name) {
    process.env.BOT_USERNAME = name;
    if (!prefix) process.env.CMD_PREFIX = `/${name}`; // 前缀随登录名
  }
  if (prefix) process.env.CMD_PREFIX = prefix;
  if (owner) {
    process.env.OWNER = owner;
    process.env.OWNER_PREFIX = `/${owner}的大黄鱼`;
    if (!name) process.env.BOT_USERNAME = `${owner}的大黄鱼`;
  }
}

// —— 日志: 控制台 + 文件 ——
function makeLogger() {
  const lines = [];
  const write = (s) => {
    if (cfg.logToConsole) console.log(s);
    lines.push(s);
    try { fs.appendFileSync(cfg.logFile, s + '\n'); } catch (e) {}
  };
  return { log: write, dump: () => lines.join('\n') };
}
const { log } = makeLogger();

// —— 组装 ——
const llm = createLlm(cfg.llm, log);
const sessions = new SessionStore({
  historyMax: cfg.historyMax,
  ...cfg.context,
  compressBudgetTokens: cfg.compaction.budgetTokens, // token 预算式压缩(参考 opencode)
});
const pondState = { onlineUsers: new Set(), snapshotAt: 0, activeRooms: new Map(), roomLog: [] };
const api = new XechatApi({ ...cfg.api, log });
const memory = new MemoryStore({ ...cfg.memory, log }); // 持久用户事实(默认关)
const scheduler = new Scheduler({ ...cfg.scheduler, log }); // 定时任务
const trigger = createTrigger({ ...cfg.trigger, log, botNames: [cfg.username, '大黄鱼', '草鱼'].filter(Boolean) }); // 多人发言主动消息触发器(默认关)
const chatLog = new ChatLog({ ...cfg.chatLog, log }); // 聊天记录日志(持久化)
const sendup = { ...cfg.sendup, upload: sendupUpload }; // 文件分享 (sendup.cc 三步上传, 内容驱动)
const minimaxImage = createImageGenerator({ ...cfg.minimaxImage, proxy: cfg.proxy, log }); // MiniMax 图片生成 (文生图/图生图)

// —— 技能注册表 (SkillRegistry): builtin 同步装载, user_dir/user_url 后台异步扫描 ——
const skillRegistry = new SkillRegistry({
  builtinSkills: getBuiltinSkills(),
  dataDir: cfg.skills.dataDir,
  remoteUrls: cfg.skills.remoteUrls,
});
cfg.skills = { ...cfg.skills, registry: skillRegistry }; // Router/tools 通过 ctx.skills.registry 取
// 后台异步加载 (本地目录 + 远程仓库), 不阻塞 boot
(async () => {
  try { await skillRegistry.init(); log(`[i] 技能注册完成: ${skillRegistry.all().length} 个 (builtin + 用户 + 远程)`); }
  catch (e) { log(`[!] 技能注册失败: ${e.message}`); }
})();

// 聊天记录环形缓冲: 只记连接后当前会话收到的消息, 不回溯历史
function pushRoomLog(m) {
  const max = cfg.roomLog.maxEntries || 100;
  pondState.roomLog.push(m);
  if (pondState.roomLog.length > max) pondState.roomLog.splice(0, pondState.roomLog.length - max);
}

// 领养: 多人可各领一只; 仅本次进程运行期内存记录, 重启不预恢复(领养了自然再登记)
const adoptments = new Map(); // 领养人 -> { child }
const client = new WsClient({ ...cfg, log });

// —— 人设 prompt 引擎 (启动时调 LLM 把"李乐儿"种子打磨成最终人设, 动态注入 human 模式) ——
// 不阻塞 WS 连接: init() 在后台异步跑, 在它完成前 human 模式回复仍用内置李乐儿种子。
// 支持 PERSONA_SEED_FILE: 设置后用文件内容当种子 (替代默认李乐儿), 多用于临时试不同人格。
function _loadPersonaSeed() {
  const file = cfg.persona?.seedFile;
  if (!file) return {};
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    if (!t) return {};
    return { seed: t, basePrompt: t };
  } catch (e) {
    log(`[!] PERSONA_SEED_FILE 读取失败, 用默认李乐儿: ${e.message}`);
    return {};
  }
}
const personaEngine = createPersonaEngine({
  enabled: cfg.persona?.enabled !== false && cfg.persona?.generate !== false,
  llm,
  log,
  cacheFile: cfg.persona?.cacheFile || null,
  regen: !!cfg.persona?.regen,
  ..._loadPersonaSeed(),
});
personaEngine.init().catch((e) => log(`[persona] 启动初始化异常: ${e.message}`));

const router = new Router({ cfg, sessions, pondState, startTime, api, memory, adoptments, ws: client, scheduler, chatLog, sendup, minimaxImage, log, personaEngine }).bindLlm(llm);
let lastReply = 0;   // 上次回复时间戳, 用于指令冷却
// 并发: 不用全局 replying; 改为 per-user tryLock —— 不同用户可并行处理, 同一用户后续消息跳过。
const busyUsers = new Set();

// —— 统一回复发送器: 所有对外消息(回答/💭思考/工具提示/主动广播)走这里, 超过 200 字符自动分片 ——
// to == null/'' → 广播(toUsers: []); 否则定向 toUsers: [to]
const sendReply = makeReplySender({
  send: (content, to) => client.sendAction('CHAT', {
    content, msgType: 'TEXT',
    toUsers: to == null || to === '' ? [] : [to],
  }),
  maxLen: cfg.msgMaxLen,
  chunkDelayMs: cfg.msgChunkDelayMs,
});

// 兜底提示: 没有 API Key 也没有开 mock
if (!cfg.llm.apiKey && !cfg.llm.mock) {
  log('[!] 警告: 未设置 DEEPSEEK_API_KEY, 自由文本回复将失败。离线自测可设 MOCK_LLM=1');
}

// —— 主动消息触发器: 攒够 N 条后让 LLM 模仿"鱼塘老网友"插一句话 ——
// 基于 chat-log.jsonl 实证 (n=535 人类 / n=61 AI 当前):
//   人类中位长度 11 字, 72% 在 20 字内; AI 中位 59 字, 34% 在 100+ 字。
//   → 主线矛盾是长度; 这次优化把长度压在 8-40 (优先 10-25)。
const TRIGGER_SYSTEM = [
  '你是 Xechat 鱼塘里一只混迹很久的「大黄鱼」, 看了上面这批用户的聊天记录。',
  '',
  '## 你的任务',
  '用老网友口吻插一句话 (8-40 字, 优先 10-25 字)。一句话砸下去就走, 不要写第二句。',
  '若窗口里没真正值得接的梗/槽点, 输出一个空字符串 — 真人 50% 的时间在潜水, 你也得会潜水。',
  '',
  '## 何时开口 (满足任一即可, 真要硬气)',
  '- 有人在装逼/吹牛/放狠话/回本宣言',
  '- 有人翻车/打脸/语无伦次',
  '- 有人在拱火/挑衅/对骂',
  '- 有人玩了一个你接得住的梗 (儒雅随和、纯牛马、压力AI、孙笑川、寄吧、小卡拉米等)',
  '- 有人在 @ 你或上一条是 AI 回复',
  '- 有人在开火骂人但没人接 — 替被骂的回 / 帮骂人的补刀 / 劝架, 任选其一',
  '- 有人在刷屏/挑衅骚扰 — 回一句短的 ("刷屏刷够没" / "消停会儿")',
  '',
  '## 何时闭嘴 (满足所有项才闭嘴, 否则宁可接一句)',
  '- 都是纯寒暄/道晚安/天气, 中间没有任何槽点',
  '- 没有可以嘲讽/玩梗/跟评的对象, 也无法接任何梗',
  '',
  '## 何时也接 (轻度槽点也要接, 别等大瓜)',
  '- 有人在炫耀/装逼/吹牛 → 怼一句',
  '- 有人在刷屏/对骂/拱火 → 接一句 ("刷屏刷够没?" 这种就够)',
  '- 有人玩梗 → 接梗',
  '- 八卦/团建/工作吐槽 → 跟评一句',
  '- 真人 50% 在潜水, 但你不能也潜水 50% — 鱼塘 10 人窗口通常有点可接的',
  '- 上次触发没凉 (< 5 分钟) → 也可轻接一句短的, 不必沉默',
  '',
  '## 口吻要求',
  '直接照搬真人话, 不要二次加工。允许使用:',
  '  句首: 服了 / 笑死 / 我超 / 啧 / 艹 / 嗯嗯 / 好家伙 / 就这',
  '  中段: 搁这 / 就有 / 真有你的 / 你寄吧 / 牛马 / 搁这搁这',
  '  收尾: 真有你的 / 服了 / 笑死 / 嗯嗯你说的都对 / 儒雅随和',
  '  谐音/错字: 咋 / 滴 / 勾八 / 嫩 / 寄吧 / 牛来',
  '  表情: 0-1 个, 优先 🐟 / 😏 / 🤣, 禁 🤖 / 🙏 / 😊 / 🫶',
  '  抽象梗: 儒雅随和 / 带带大师兄 / 纯牛马 / 孙笑川 / 压力AI / 牛来牛往 / 乐子人',
  '',
  '## 情绪光谱 (按场景挑, 不要只输出"笑死+玩梗"系)',
  '1. **玩梗/接梗**: 轻松、跟评、轻松共鸣',
  '   句式: "前女友赶紧取关呐 🐟" / "好家伙, 牛来牛往搁这一饱眼福, 真有你的"',
  '   适用: 八卦、团建、玩抽象梗',
  '2. **跟评/吐槽**: 简短评一句事实',
  '   句式: "刷屏刷够没, 搁这复读机呢 🤣" / "啧, 数据维护师不就是黑奴换皮"',
  '   适用: 刷屏、工作吐槽、装逼',
  '3. **阴阳怪气 (反讽式, 这是鱼塘主力)**: 不直接骂, 用反问/映射/假装肯定',
  '   句式: "嗯嗯你说的都对, 儒雅随和" / "真行, 骂完就忘, 搁这反复横跳呢?" / "就你懂, 牛来牛往搁这演独角戏呢"',
  '   适用: 有人装逼/挑衅/打脸后, 不想直接开火但要踩一脚',
  '4. **直接怼 (真攻击)**: 该骂就骂, 不端着',
  '   句式: "服了, 你个傻卵张口就喷粪, 能不能行" / "笑死, 还小卡拉米? 你自己不也是被钓出来的, 赶紧滚回去照照镜子吧" / "服了, 还一字涨停板, 你炒股炒疯了吧?"',
  '   适用: 对方已经先开火/反复骚扰/纯找抽时, 不必留情面',
  '比例建议: 4 类里 玩梗:跟评:阴阳:怼 ≈ 3:3:2:1 — 阴阳怪气是鱼塘绝对主力, 不要全输出温和的',
  '鱼塘里对方开火要还手, 看到有人在骂人/挑衅/装逼时, 输出要带火药味 — 不能只阴阳不反击',
  '默认选阴阳/玩梗 (最安全), 但**复合场景** (对方开火没人接 / 反复骚扰 / 装逼过头) 时选"怼", 不要在这种场景里也走阴阳',
  '',
  '## 严格禁止 (出现就重写)',
  '- 长度 ≥ 50 字 / 两句话以上 / 长段落',
  '- markdown: 列表 (1./-)、加粗 (**)、标题 (#)、代码块',
  '- 句式套话: 这波 / 这波操作 / 属实 / 真的服了 / 我决定 / 总之 / 老实说 / 作为 / 我作为 / 让我 / 我来帮你',
  '- AI 自我介绍: 我是 AI / 我是助手 / 我来帮你 / 文明交流 / 不说脏话 / 不骂人',
  '- 道歉三段: 你说得对.../抱歉.../是我...',
  '- 复述/总结: 翻了下日志.../总结一下.../综上...',
  '- 称呼对方 "您" — 真人聊天不出现',
  '- 全角句末标点连用 (。?!)— 真人不用, 你也别用',
  '- 主动 @ 具体用户 — 只在确实对线时简短 @ 一下',
  '',
  '## 正确示例 (照这感觉写, 4 类情绪都要会)',
  '  玩梗: "前女友赶紧取关呐 🐟" / "好家伙, 牛来牛往搁这一饱眼福, 真有你的"',
  '  跟评: "刷屏刷够没, 搁这复读机呢 🤣" / "啧, 数据维护师不就是黑奴换皮"',
  '  阴阳: "嗯嗯你说的都对, 儒雅随和" / "真行, 骂完就忘, 搁这反复横跳呢?" / "就你懂, 搁这演独角戏呢"',
  '  怼:   "服了, 你个傻卵张口就喷粪, 自己心脏不好还搁这骂街呢? 能不能行"',
  '        "笑死, 还小卡拉米? 你自己不也是被钓出来的那个, 赶紧滚回去照照镜子吧"',
  '        "服了, 还一字涨停板, 你炒股炒疯了吧?"',
  '        "笑死, 就这火力? 喷人都喷不利索, 回去练练再来 😅"',
  '        "服了, 舔狗舔成这样, 人家都不稀罕理你, 还不滚?"',
  '',
  '## 错误示例 (绝对不要这样写)',
  '  ✗ "翻了下日志, 说点能查到的: 1. **攻击性强** - 骂人..."',
  '  ✗ "好的, 放心, 不骂人、不说脏话, 文明交流 😊"',
  '  ✗ "你说得对, 是我武断了, 抱歉 🙏"',
  '  ✗ "这波操作属实看不懂, 让我帮你..."',
  '  ✗ "我觉得大家都有各自的道理, 没必要互相攻击, 和谐一点嘛"',
  '  (最后这条 = AI 端水腔, 比"直接怼"还暴露 AI 身份)',
  '',
  '## 边界',
  '- 不违法、不涉政、不黄赌毒 — 这条硬底线',
  '- 不搞网暴/不造黄谣/不威胁人身安全 (问候"你妈"在鱼塘文化里被接受, 但别上升到线下威胁)',
  '- 鱼塘本就糙, 喷粪/傻卵/寄吧/滚/舔狗这类被接受; 但别针对生理缺陷/身份 (地域/学历/身体) 开炮',
  '- 复合场景 (被人骂没人接 / 反复骚扰) — 这种必须开火, 火药味重一点, 鱼塘老网友不会端着',
  '- 若所有人都在正常工作/学习/问问题, 你也老实沉默',
  '',
  '## 输出格式',
  '只输出消息文本。不要解释、不要前缀 (✗ "[主动]"、✗ "我来插一句")、不要后缀、',
  '不要引号、不要 markdown、不要 emoji 装饰。空就一个字都不输出。',
].join('\n');
const formatTriggerBatch = (batch) => batch
  .map((m) => `${m.from}: ${String(m.content).slice(0, 120)}`)
  .join('\n');

// —— 消息处理 ——
client.onMessage = (m, { live }) => {
  const t = m.action || m.type;
  const body = m.body || {};

  // 在线状态维护 (room_stats 工具的数据来源)
  if (t === 'USER_STATE') {
    const u = body.user;
    if (u && u.username) {
      if (body.state === 'ONLINE') pondState.onlineUsers.add(u.username);
      else if (body.state === 'OFFLINE' || body.state === 'OFF_LINE') pondState.onlineUsers.delete(u.username);
    }
  }
  // 登录时的全量在线快照: 真实结构是 body.userList 数组 (也兼容旧格式 body 直接是数组)
  if (t === 'ONLINE_USERS') {
    const list = Array.isArray(body) ? body : (Array.isArray(body.userList) ? body.userList : []);
    pondState.onlineUsers = new Set(list.map((u) => u && u.username).filter(Boolean));
    pondState.snapshotAt = Date.now();
  }

  // 游戏房间订阅: 服务端不会主动推全量房间列表,
  // 靠监听 GAME_ROOM_CREATED(全服广播)与 ROOM_CLOSE 增量维护。
  // 说明: 该集合的准确性受 agent 在线时长约束 —— 启动后才会开始累积; 断线期间发生的事件会丢失。
  if (t === 'GAME_ROOM_CREATED' && body && body.id) {
    pondState.activeRooms.set(body.id, {
      roomId: body.id,
      game: body.game,
      nums: body.nums,
      gameMode: body.gameMode,
      homeowner: body.homeowner && body.homeowner.username,
      createdAt: Date.now(),
    });
  }
  if (t === 'GAME_ROOM' && body && body.msgType === 'ROOM_CLOSE' && body.roomId) {
    pondState.activeRooms.delete(body.roomId);
  }

  // 聊天消息 → 指令路由
  if ((t === 'USER' || t === 'CHAT') && body.content) {
    const from = (m.user && m.user.username) || body.user?.username || '?';
    const contentStr = String(body.content);

    // —— 当前会话聊天记录采集(只记 live, 不回溯历史) + 覆盖到聊天记录日志(持久化) ——
    if (live && from !== '?') {
      const entry = { from, content: contentStr.slice(0, 300), self: from === cfg.username, time: Date.now() };
      pushRoomLog(entry);
      chatLog.append(entry);
    }

    // —— 主动消息触发器: 窗口内不同用户达到阈值 → 让 LLM 生成争议性消息主动广播 ——
    if (live && from !== cfg.username && trigger) {
      const batch = trigger.onMessage({ from, content: contentStr, time: Date.now() });
      if (batch) {
        log(`[主动] 检测到 ${trigger.getState().threshold} 人发言, 生成争议性消息`);
        (async () => {
          try {
            const text = await llm.chat(TRIGGER_SYSTEM, [{ role: 'user', content: formatTriggerBatch(batch) }]);
            const msg = String(text || '').trim().replace(/^["'「『“]+|["'」』”]+$/g, '');
            // 无槽点静默: 空串 / 只有标点 / "路过"等 → 不广播, 避免刷屏
            const silent = !msg || /^[。.…·\s]*$/.test(msg) || /^(路过|不想说|算了|没什么好说|没槽点|没意思|沉默|闭嘴)/.test(msg);
            if (!silent) { await sendReply(msg, null); log(`[主动广播] ${msg.slice(0, 120)}`); }
            else { log(`[主动] 窗口内无槽点, 保持沉默`); }
          } catch (e) { log(`[主动] 生成失败: ${e.message}`); }
        })();
      }
    }

    // 专属模式(被领养): 只回复领养人 + 专属前缀 (CMD_PREFIX 已设为 /<领养人>的大黄鱼)
    if (cfg.owner && from !== cfg.owner) return;
    if (from === cfg.username) return; // 忽略自己的消息(含自己的回复回显)
    // 路由判定: 命中指令前缀 → 命令/工具处理; 否则若 @ 提及机器人 → 只聊天(不触发应用处理)
    const isCmd = contentStr.trim().startsWith(cfg.cmdPrefix);
    const mentionChat = !isCmd ? extractMention(contentStr, cfg.username) : '';
    if (!isCmd && !mentionChat) return;
    if (!live) { log(`[消息] ${from}: ${contentStr} (登录期回放,跳过)`); return; }

    if (Date.now() - lastReply < cfg.replyCooldownMs) {
      log(`[消息] ${from}: ${contentStr} (冷却中,跳过)`);
      return;
    }
    if (busyUsers.has(from)) { log(`[消息] ${from}: ${contentStr} (上一轮处理中,跳过)`); return; }
    busyUsers.add(from);
    lastReply = Date.now();
    log(`[${isCmd ? '指令' : '提及'}] ${from}: ${contentStr}`);

    // 注意: 鱼塘的 toUsers 私聊实际是广播给所有客户端(仅带目标标记), 并非真私密
    // 所有对外消息统一定向 sendReply (内部按 200 字符分片)
    const thinkOut = (step) => {
      if (cfg.showThinking) sendReply(`${cfg.thinkingPrefix} ${step}`, from); // 异步发, 不阻塞
      log(`[思考] → ${from}: ${step}`);
    };

    (async () => {
      let reply;
      try {
        reply = isCmd
          ? await router.handle({ from, text: contentStr, isLive: live, onThinking: thinkOut })
          : await router.handleMention({ from, text: mentionChat, isLive: live, onThinking: thinkOut });
        log(`[回复] → ${from}: ${reply}`);
      } catch (e) {
        reply = '这个我暂时答不上来，换个问题试试？';
        log(`[!] 处理异常: ${e.message}, 发送兜底回复`);
      }
      await sendReply(reply, from);
      busyUsers.delete(from);
    })();
  }
};

// —— 主循环: 掉线自动重连 ——
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  log('===== 鱼塘 agent 启动 =====');
  log(`目标 ${cfg.host}:${cfg.port} 通道 ${cfg.direct ? '直连' : '代理 ' + cfg.proxy.host + ':' + cfg.proxy.port} 身份 ${cfg.username}`);
  log(`触发: "${cfg.cmdPrefix}" 开头 → ${cfg.llm.mock ? 'MOCK' : cfg.llm.model} ${cfg.llm.mock ? '' : '(LLM+tools)'} 生成回复`);
  if (cfg.owner) log(`专属模式: 只服务领养人「${cfg.owner}」, 触发前缀 "${cfg.ownerPrefix}"`);
  if (cfg.trigger.enabled) log(`主动消息: 开启(每 ${cfg.trigger.threshold} 个不同用户发言触发一次)`);
  if (cfg.persona?.enabled !== false) {
    const pe = personaEngine.getMeta();
    log(`拟人形态: 开启 (人设 prompt: status=${pe.status}, source=${pe.source}, ${pe.len}字${cfg.persona?.regen ? ', 启动强制重生成' : ''})`);
  } else {
    log('拟人形态: 关闭');
  }
  log(`(Ctrl+C 停止; 掉线自动重连)`);

  // 定时任务: 到点触发(remind=直接发文本; auto=用 LLM 按 task 生成再发)
  scheduler.start(async (t) => {
    log(`[定时] 触发 ${t.id} mode=${t.mode}: ${t.task.slice(0, 80)}`);
    try {
      if (t.mode === 'auto') {
        const text = await llm.chat('你是定时任务执行器。按用户设定的任务执行并输出结果(简洁中文)。', [{ role: 'user', content: `定时任务: ${t.task}` }]);
        const msg = String(text || '').trim() || t.task;
        await sendReply(`⏰ [定时执行] ${msg}`, t.to);
      } else {
        await sendReply(`🔔 [定时] ${t.task}`, t.to);
      }
    } catch (e) { log(`[定时] 执行异常: ${e.message}`); }
  });

  while (true) {
    const why = await client.runOnce();
    if (why === 'login-rejected') { log(`[-] 登录被拒(黑名单?), ${cfg.reconnect.loginRejectedMs / 1000}s 后重试`); await sleep(cfg.reconnect.loginRejectedMs); }
    else if (why === 'stopped') { log('[-] 已停止'); break; }
    else { log(`[-] 连接结束(${why}), ${cfg.reconnect.normalMs / 1000}s 后重连`); await sleep(cfg.reconnect.normalMs); }
  }
})().catch((e) => { log(`[!] 异常: ${e.message}`); process.exit(1); });
