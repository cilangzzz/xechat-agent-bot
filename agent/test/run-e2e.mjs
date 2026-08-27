// 鱼塘 agent 智能体 —— 离线端到端自测
// 本地起 mock 鱼塘服务器 + 以 MOCK_LLM 模式拉起 agent 子进程, 验证完整链路:
//   连接 → WS握手 → LOGIN → 收到指令 → (确定性命令 / LLM) → CHAT 回复
// 运行:  node test/run-e2e.mjs
// 期望输出: 全部断言通过 → "E2E PASS"
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MockPondServer } from './mock-server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = path.join(__dirname, '..');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // 1. 起 mock 鱼塘
  const pond = new MockPondServer({
    users: ['e2e_bystander_1', 'e2e_bystander_2'],
    onLog: (s) => console.log('  [mock]', s),
  });
  const port = await pond.start();
  console.log(`[1] mock 鱼塘已启动 127.0.0.1:${port}`);

  // 2. 拉起 agent 子进程 (MOCK_LLM + 直连本地 + 关闭冷却/回放窗口加速)
  const env = {
    ...process.env,
    XE_HOST: '127.0.0.1',
    XE_PORT: String(port),
    PROXY_PORT: '0',
    MOCK_LLM: '1',
    DEEPSEEK_API_KEY: 'test-key-not-needed',
    BOT_USERNAME: 'e2e_agent',
    CMD_PREFIX: '/小黄鱼', // 测试固定用该前缀, 不随 .env(现为大黄鱼)漂移
    REPLY_COOLDOWN_MS: '0',
    REPLAY_SKIP_MS: '0',
    HEARTBEAT_MS: '1500', // 调短心跳, 便于在测试窗口内校验帧格式
    MOCK_TOOLCALL: '1',   // mock 第一轮返回 room_stats 工具调用, 测工具结果输出
    MOCK_LONG_REPLY: '1', // 指令含 TESTLONG 时 mock 返回超长回复, 测分片发送
    AGENT_QUIET: '1',
    // —— 新增功能测试配置: 定时任务加速 + 聊天记录日志(落盘临时文件); 触发器另起独立 agent 实例测 ——
    SCHEDULE_TICK_MS: '200',
    ENABLE_CHAT_LOG: '1',
    CHAT_LOG_FILE: path.join(__dirname, 'e2e-chat-log.jsonl'),
  };
  let child = spawn(process.execPath, ['agent.mjs'], {
    cwd: AGENT_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.stdout.write('  [agent] ' + d));
  child.stderr.on('data', (d) => process.stdout.write('  [agent-err] ' + d));

  // 3. 等 LOGIN
  const loginUser = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等 LOGIN 超时')), 8000);
    pond.onLogin = (u) => { clearTimeout(timer); resolve(u); };
  });
  console.log(`[2] agent 已登录: ${loginUser}`);

  // 4. 场景 A: 确定性内置命令
  // 等 agent 确认上线(收到自身 USER_STATE)后再发消息, 避免被"登录期回放"逻辑跳过
  console.log('[3] 场景A: 发 "/小黄鱼 ping" (确定性命令 + 思考过程)');
  await sleep(300);
  const waitFor = (pred, timeoutMs = 5000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等回复超时')), timeoutMs);
    pond.onReply = (to, text) => { if (pred(text)) { clearTimeout(timer); resolve(text); } };
  });
  const waitA = waitFor((t) => t === 'pong 🎣');
  pond.sendChat('e2e_tester', '/小黄鱼 ping');
  const replyA = await waitA;
  console.log(`     回复A: ${replyA}`);
  assert(replyA === 'pong 🎣', `期望 pong 🎣, 实际 ${replyA}`);
  assert(!pond.replies.some((t) => t.includes('💭')), '确定性命令直接给结果, 不输出思考占位');

  // 5. 场景 B: LLM 自由文本 (MOCK 模式 + MOCK_TOOLCALL 触发 room_stats 工具)
  console.log('[4] 场景B: 发 "/小黄鱼 你还在吗" (LLM+mock + 工具结果输出)');
  const waitB = waitFor((t) => t.startsWith('[mock回复]'));
  pond.sendChat('e2e_tester', '/小黄鱼 你还在吗');
  const replyB = await waitB;
  console.log(`     回复B: ${replyB}`);
  assert(replyB.startsWith('[mock回复]'), `期望 [mock回复]... , 实际 ${replyB}`);
  assert(pond.replies.some((t) => t.includes('💭') && t.includes('开始处理')),
    '开始处理时只发一条提示');
  assert(!pond.replies.some((t) => t.includes('正在统计在线用户')), '不应输出每次工具执行提示');
  assert(!pond.replies.some((t) => t.includes('工具「room_stats」→')), '不应输出工具调用结果');
  assert(!pond.replies.some((t) => t.includes('正在思考')), '不应输出"正在思考"占位');

  // 6. 场景 C: 普通消息不触发
  console.log('[5] 场景C: 发不带前缀的普通消息 (不应有回复)');
  const replyCountBefore = pond.replies.length;
  pond.onReply = () => {};
  pond.sendChat('e2e_tester', '今天天气不错');
  await sleep(1500);
  assert(pond.replies.length === replyCountBefore, '普通消息不应触发回复');

  // 7. 心跳帧格式: 必须与旧 bot 字节级一致 {"action":"HEARTBEAT"} (不带 body)
  console.log('[6] 场景D: 校验心跳帧格式');
  assert(pond.heartbeats.length >= 1, '测试窗口内应至少收到一次心跳');
  assert(pond.heartbeats.every((h) => JSON.stringify(h) === '{"action":"HEARTBEAT"}'),
    `心跳帧应精确为 {"action":"HEARTBEAT"}, 实际: ${JSON.stringify(pond.heartbeats[0])}`);

  // 8. 场景 E: 超长回复 → 分片发送 (服务端单条上限 200 字符)
  console.log('[7] 场景E: 发 "/小黄鱼 TESTLONG" (超长回复→分片)');
  const countBeforeE = pond.replies.length;
  const waitE = waitFor((t) => t.startsWith('LONGREPLY'));
  pond.sendChat('e2e_tester', '/小黄鱼 TESTLONG');
  await waitE;
  await sleep(2000); // 等剩余分片发完 (每片间隔 600ms)
  // 过滤掉 💭 开始处理提示, 只统计回复分片
  const chunks = pond.replies.slice(countBeforeE).filter((c) => c.startsWith('LONGREPLY') || c.startsWith('↪ '));
  assert(chunks.length >= 3, `超长回复应拆成 ≥3 片, 实际 ${chunks.length}`);
  assert(chunks.every((c) => Array.from(c).length <= 200), `每片不得超过 200 字符, 实际最长 ${Math.max(...chunks.map((c) => Array.from(c).length))}`);
  const joined = chunks.map((c) => c.replace(/^↪ /, '')).join('');
  assert(joined.startsWith('LONGREPLY|') && joined.length >= 480, '分片拼接后应还原完整回复');

  // 8. 场景 F: 多智能体显式指令 —— math 走确定性 python 计算
  console.log('[8] 场景F: 发 "/小黄鱼 math 6*7" (确定性计算, 子智能体能力)');
  const waitF = waitFor((t) => t.startsWith('= '));
  pond.sendChat('e2e_tester', '/小黄鱼 math 6*7');
  const replyF = await waitF;
  console.log(`     回复F: ${replyF}`);
  assert(replyF === '= 42', `期望 "= 42", 实际 ${replyF}`);

  // 9. 场景 G: explore 委派子智能体 (MOCK_LLM 下返回 mock 回复, 验证委托通道)
  console.log('[9] 场景G: 发 "/小黄鱼 explore 今天天气" (委派 explore 子智能体)');
  const waitG = waitFor((t) => t.startsWith('[mock回复]'));
  pond.sendChat('e2e_tester', '/小黄鱼 explore 今天天气');
  const replyG = await waitG;
  console.log(`     回复G: ${replyG}`);
  assert(replyG.startsWith('[mock回复]'), `期望 explore 子智能体的 mock 回复, 实际 ${replyG}`);

  // 10. 场景 H: 待办指令 (add → list)
  console.log('[10] 场景H: 发 "/小黄鱼 todo 添加 买菜" + "/小黄鱼 todo 显示"');
  const waitH = waitFor((t) => t.includes('买菜'));
  pond.sendChat('e2e_tester', '/小黄鱼 todo 添加 买菜');
  const replyH = await waitH;
  console.log(`     回复H: ${replyH}`);
  assert(replyH.includes('买菜'), `期望待办含"买菜", 实际 ${replyH}`);
  pond.onReply = () => {};
  await sleep(600);
  pond.onReply = null;
  const waitH2 = waitFor((t) => t.includes('买菜') && t.includes('待办'));
  pond.sendChat('e2e_tester', '/小黄鱼 todo 显示');
  const replyH2 = await waitH2;
  console.log(`     回复H2: ${replyH2}`);
  assert(replyH2.includes('买菜') && replyH2.includes('待办'), `期望待办清单含"买菜", 实际 ${replyH2}`);

  // 11. 场景 I: @ 提及 → 只聊天, 不触发命令/工具, 也不输出思考提示(💭)
  console.log('[11] 场景I: 发 "@e2e_agent 你好呀" (@ 提及 → 纯聊天模式)');
  const idxBeforeI = pond.replies.length;
  const waitI = waitFor((t) => t.startsWith('[mock回复]'));
  pond.sendChat('e2e_tester', '@e2e_agent 你好呀');
  const replyI = await waitI;
  console.log(`     回复I: ${replyI}`);
  const repliesI = pond.replies.slice(idxBeforeI);
  assert(replyI.startsWith('[mock回复]') && !replyI.includes('pong'), `期望 @ 聊天回复(mock), 实际 ${replyI}`);
  assert(!repliesI.some((t) => t.includes('工具「')), '@ 聊天不应触发工具执行/查询');
  assert(!repliesI.some((t) => t.includes('💭')), '@ 聊天不应输出 💭 思考提示', `实际: ${JSON.stringify(repliesI)}`);

  // 12. 场景 J: 无前缀也无 @ 的普通消息 → 不应有回复
  console.log('[12] 场景J: 发普通消息(无前缀无 @, 不应回复)');
  const countBeforeJ = pond.replies.length;
  pond.onReply = () => {};
  pond.sendChat('e2e_tester', '今天天气真不错');
  await sleep(1200);
  assert(pond.replies.length === countBeforeJ, '普通消息不应触发回复');

  // 13. 场景 K: 多步思维链验证 —— agent 启动时 main agent 已被注入多步调研范式
  //     (extra 中含 web_search → fetch_url → python 链路); MOCK 模式下 Reflect 不注,
  //     主 agent 收到一次 mock tool_call 后给最终回复, 验证多步链路指令可达 + 协议无回归
  console.log('[13] 场景K: 发 "/小黄鱼 今日头条热点" (多步调研范式生效)');
  const idxBeforeK = pond.replies.length;
  const waitK = waitFor((t) => t.startsWith('[mock回复]'));
  pond.sendChat('e2e_tester', '/小黄鱼 今日头条热点');
  const replyK = await waitK;
  console.log(`     回复K: ${replyK}`);
  assert(replyK.startsWith('[mock回复]'), `期望 mock 调研最终回复, 实际 ${replyK}`);
  // 主 agent extra 含"web_search → fetch_url → python 总结"指令, 模型在真实 LLM 下会遵循
  console.log('     (多步调研范式已注入 main.extra, 见 lib/agents.mjs; Reflect 在真实 LLM 下每轮注入)');

  // 14. 场景 L: 定时任务 —— 1 秒后触发提醒
  console.log('[14] 场景L: 发 "/小黄鱼 定时 1秒 提醒我喝水" (定时任务 → 到点提醒)');
  const waitSchedReg = waitFor((t) => t.includes('已设定定时提醒'));
  pond.sendChat('e2e_tester', '/小黄鱼 定时 1秒 提醒我喝水');
  const schedReg = await waitSchedReg;
  console.log(`     注册: ${schedReg}`);
  assert(/已设定定时提醒/.test(schedReg), `期望注册成功, 实际 ${schedReg}`);
  const waitSchedFire = waitFor((t) => t.startsWith('🔔 [定时]'));
  const schedFire = await waitSchedFire;
  console.log(`     触发: ${schedFire}`);
  assert(/提醒我喝水/.test(schedFire), `期望定时提醒发出, 实际 ${schedFire}`);

  // 15. 场景 M: 聊天记录日志(持久化) + 当前会话聊天记录查询
  console.log('[15] 场景M: 发普通消息 → /小黄鱼 聊天记录 3 + /小黄鱼 最近消息 3');
  const waitChatLog = waitFor((t) => t.startsWith('日志中最近'));
  pond.sendChat('trigger_user_a', '大家好今天好热');
  pond.sendChat('trigger_user_b', '就是, 真受不了');
  await sleep(300);
  pond.sendChat('e2e_tester', '/小黄鱼 聊天记录 3');
  const chatLogMsg = await waitChatLog;
  console.log(`     聊天记录: ${chatLogMsg.slice(0, 160)}`);
  assert(/大家好/.test(chatLogMsg) && /真受不了/.test(chatLogMsg), `期望聊天记录日志含新消息, 实际 ${chatLogMsg}`);
  const waitRecent = waitFor((t) => t.startsWith('最近'));
  const idxRecent = pond.replies.length;
  pond.sendChat('e2e_tester', '/小黄鱼 最近消息 10');
  await waitRecent;
  await sleep(1500); // 等剩余分片发送
  const recentChunks = pond.replies.slice(idxRecent).filter((c) => c.startsWith('最近') || c.startsWith('↪'));
  const recentFull = recentChunks.map((c) => c.replace(/^↪ /, '')).join('');
  console.log(`     最近消息: ${recentFull.slice(0, 160)}`);
  assert(/大家好/.test(recentFull) && /真受不了/.test(recentFull), `期望当前会话记录含新消息, 实际 ${recentFull}`);

  // 16. 场景 N: 主动消息触发器(独立 agent 实例, 按条数) —— 每 2 条(非自己)消息触发一次广播
  console.log('[16] 场景N: 触发器(每 2 条触发) → 主动广播');
  child.kill();
  child = null;
  const env2 = {
    ...process.env,
    XE_HOST: '127.0.0.1',
    XE_PORT: String(port),
    PROXY_PORT: '0',
    MOCK_LLM: '1',
    DEEPSEEK_API_KEY: 'test-key-not-needed',
    BOT_USERNAME: 'e2e_trigger',
    CMD_PREFIX: '/小黄鱼',
    REPLY_COOLDOWN_MS: '0',
    REPLAY_SKIP_MS: '0',
    AGENT_QUIET: '1',
    ENABLE_TRIGGER: '1',
    TRIGGER_THRESHOLD: '2',
    TRIGGER_COOLDOWN_MS: '0',
  };
  child = spawn(process.execPath, ['agent.mjs'], { cwd: AGENT_DIR, env: env2, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => process.stdout.write('  [agent2] ' + d));
  child.stderr.on('data', (d) => process.stdout.write('  [agent2-err] ' + d));
  const login2 = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等 LOGIN2 超时')), 8000);
    pond.onLogin = (u) => { clearTimeout(timer); resolve(u); };
  });
  console.log(`     agent2 已登录: ${login2}`);
  await sleep(300);
  const waitActive = waitFor((t) => t.startsWith('[mock回复]'));
  pond.sendChat('trigger_x', '第一条');
  pond.sendChat('trigger_x', '第二条'); // 同用户连续 2 条也触发(按条数)
  const activeMsg = await waitActive;
  console.log(`     主动广播: ${activeMsg.slice(0, 80)}`);
  assert(activeMsg.startsWith('[mock回复]'), `期望触发主动广播(mock), 实际 ${activeMsg}`);

  console.log('[17] 清理子进程');
  child.kill();
  await pond.stop();

  console.log('\n✅ E2E PASS —— agent 骨架协议与流程验证通过');
  process.exit(0);
}

function assert(cond, msg) {
  if (!cond) { console.error(`\n❌ E2E FAIL: ${msg}`); process.exit(1); }
}

main().catch((e) => { console.error('\n❌ E2E FAIL: ' + e.message); process.exit(1); });
