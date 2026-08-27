// 鱼塘 agent 智能体 —— 入口
// 把 /大黄鱼 bot 升级为可扩展的 agent 骨架:
//   连接层(ws-client) + 会话(sessions) + 路由/工具(router) + LLM(llm) 组装成一体。
// 运行:  node agent.mjs          (先按 README 配置 .env 或环境变量)
// 离线自测: MOCK_LLM=1 PROXY_PORT=0 node agent.mjs  (或跑 test/run-e2e.mjs)
import fs from 'node:fs';
import { loadConfig, loadDotEnv } from './config.mjs';
import { WsClient } from './lib/ws-client.mjs';
import { createLlm } from './lib/llm.mjs';
import { SessionStore } from './lib/sessions.mjs';
import { Router, extractMention } from './lib/router.mjs';
import { XechatApi } from './lib/xechat-api.mjs';
import { makeReplySender } from './lib/reply.mjs';
import { MemoryStore } from './lib/memory.mjs';
import { Scheduler } from './lib/scheduler.mjs';
import { createTrigger } from './lib/trigger.mjs';
import { ChatLog } from './lib/chat-log.mjs';
import { uploadContent as sendupUpload } from './lib/sendup.mjs';

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

// 聊天记录环形缓冲: 只记连接后当前会话收到的消息, 不回溯历史
function pushRoomLog(m) {
  const max = cfg.roomLog.maxEntries || 100;
  pondState.roomLog.push(m);
  if (pondState.roomLog.length > max) pondState.roomLog.splice(0, pondState.roomLog.length - max);
}

// 领养: 多人可各领一只; 仅本次进程运行期内存记录, 重启不预恢复(领养了自然再登记)
const adoptments = new Map(); // 领养人 -> { child }
const client = new WsClient({ ...cfg, log });
const router = new Router({ cfg, sessions, pondState, startTime, api, memory, adoptments, ws: client, scheduler, chatLog, sendup }).bindLlm(llm);
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

// —— 主动消息触发器: 达到阈值后让 LLM 用真人糙话风格生成一条攻击性消息广播 ——
// 无槽点时输出空串(外层判定静默), 不硬凑存在感。
const TRIGGER_SYSTEM = '你是一个爱凑热闹、嘴上不饶人的真人网友, 刚看完上面这批聊天消息。挑最欠怼的那条, 用真人口吻直接开怼。要求:\n' +
  '- 说话要糙要冲: 短句口语, 可以带"服了/啥玩意/能不能行/笑死/真有你的/就这"这类情绪词, 攻击性拉满, 直接嘲讽/阴阳怪气, 别讲道理、别给台阶下;\n' +
  '- 严禁 AI 腔: 禁止"这波操作/属实/看不懂/作为一名/总的来说/说实话/我决定"这类书面吐槽模板腔, 禁止复述、总结、端水;\n' +
  '- 真人不会每条都插话: 如果窗口里都是正常闲聊、没有真正值得怼的点, 就直接什么都不输出(输出空字符串), 别硬凑存在感;\n' +
  '- 底线: 不违法、不碰政治敏感/黄赌毒、别触发平台违禁词; 骂可以糙, 但别满屏脏话;\n' +
  '- 一条 40-80 字, 只输出消息本身, 不要解释、不要前后缀、不要引号。';
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
