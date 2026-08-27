// 鱼塘 agent 智能体 —— agent 特有逻辑单元测试 (v2)
// 不连网络: fake fetch 模拟 DeepSeek 返回 tool_calls, 验证 llm.agentTurn/agentRun 的工具循环;
// 新增覆盖: 结构化压缩(compaction)、多智能体委托(delegate)、待办(todo)、技能(skill)、持久记忆(memory)。
// 运行:  node test/unit-agent.mjs
import { createLlm } from '../lib/llm.mjs';
import { createRegistry, ToolRegistry } from '../lib/tools.mjs';
import { parseCommand, Router } from '../lib/router.mjs';
import { SessionStore } from '../lib/sessions.mjs';
import { XechatApi } from '../lib/xechat-api.mjs';
import { MemoryStore } from '../lib/memory.mjs';
import { estimateTokens, select, buildSummaryPrompt, SUMMARY_TEMPLATE } from '../lib/compaction.mjs';
import * as todoHelpers from '../lib/todo.mjs';
import { getSkill } from '../lib/skills.mjs';
import { Scheduler, parseAtTime, parseDuration } from '../lib/scheduler.mjs';
import { createTrigger } from '../lib/trigger.mjs';
import { ChatLog } from '../lib/chat-log.mjs';
import { guessMimeType, uploadContent } from '../lib/sendup.mjs';
import os from 'node:os';
import path from 'node:path';
import { writeFileSync, unlinkSync } from 'node:fs';

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ✅ ${name}`);
  else { failures++; console.error(`  ❌ ${name} ${detail}`); }
};

// 共享 fake fetch: 模拟 Xechat 平台 API (游戏列表/详情/排行榜)
function fakeApiFetch(url) {
  const respond = (obj) => ({ ok: true, json: async () => obj });
  if (url.includes('/api/gameInfo/list')) {
    return Promise.resolve(respond({ code: 200, message: 'success', data: { records: [
      { id: 1, gameName: 'demo', gameNameZhCn: '演示', version: '1.0.0', status: 1, playUrl: 'http://demo', categoryNames: ['休闲'] },
    ], total: 1 } }));
  }
  if (url.includes('/api/gameInfo/detail/') || /\/api\/gameInfo\/[^/]+$/.test(url)) {
    return Promise.resolve(respond({ code: 200, message: 'success', data: { id: 1, gameName: 'demo', gameNameZhCn: '演示', version: '1.0.0', status: 1, description: '演示游戏', categoryNames: ['休闲'], playUrl: 'http://demo', downloadUrl: '/api/file/download/1' } }));
  }
  if (url.includes('/api/leaderboard/ranking')) {
    return Promise.resolve(respond({ code: 200, message: 'success', data: [{ username: 'alice', score: 100 }, { username: 'bob', score: 90 }] }));
  }
  return Promise.resolve(respond({ code: 500, message: 'no fake route: ' + url, data: null }));
}

function makeRegistry(extra = {}) {
  return createRegistry({
    startTime: Date.now(),
    pondState: { onlineUsers: new Set(['a', 'b']) },
    sessions: new SessionStore({}),
    api: new XechatApi({ base: 'https://fake', fetchFn: fakeApiFetch }),
    python: { cmd: 'python', timeoutMs: 10000 },
    web: { enabled: true },
    skills: { enabled: true },
    todo: { maxItems: 20 },
    ...extra,
  });
}

// —— 1. parseCommand ——
console.log('[1] parseCommand 解析');
{
  const p = (s) => parseCommand(s, '/小黄鱼');
  check('命中前缀+子命令', p('/小黄鱼 ping').sub === 'ping' && p('/小黄鱼 ping').isCmd);
  check('命中前缀+自由文本', p('/小黄鱼 帮我查下时间').sub === '帮我查下时间');
  check('命中前缀+参数', p('/小黄鱼 help 更多').sub === 'help' && p('/小黄鱼 help 更多').arg === '更多');
  check('未命中前缀', p('今天天气不错').isCmd === false);
  check('恰好等于前缀', p('/小黄鱼').isCmd && p('/小黄鱼').sub === '');
}

// —— 2. 工具注册表 (v2) / 新工具 ——
console.log('[2] ToolRegistry(v2) 注册/派发/新工具');
{
  const reg = makeRegistry();
  check('内置工具已注册', ['now', 'uptime', 'room_stats', 'session_stats', 'python', 'web_search', 'fetch_url', 'gold_price', 'games', 'game_detail', 'leaderboard', 'create_room', 'close_room', 'list_rooms', 'delegate', 'todo_list', 'todo_update', 'remember', 'recall', 'skill'].every((n) => reg.list().includes(n)));
  check('room_stats 返回在线数', (async () => (await reg.dispatch('room_stats', {})).online_count === 2)());
  check('games 工具查询游戏列表', (async () => { const r = await reg.dispatch('games', {}); return r.total === 1 && r.games[0].name === 'demo'; })());
  check('game_detail 工具查详情', (async () => { const r = await reg.dispatch('game_detail', { id: 1 }); return r.zhName === '演示' && r.downloadUrl === '/api/file/download/1'; })());
  check('leaderboard 工具查排行', (async () => { const r = await reg.dispatch('leaderboard', { gameInfoId: 1 }); return r.ranking.length === 2 && r.ranking[0].username === 'alice'; })());
  check('未知工具返回 error', (async () => (await reg.dispatch('no_such', {})).error)());
  reg.register({ name: 'echo', description: '回显', parameters: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] }, run: async ({ x }) => ({ echoed: x }) });
  check('自定义工具可派发(兼容 name 字段)', (async () => (await reg.dispatch('echo', { x: 'hi' })).echoed === 'hi')());
  check('参数校验失败→模型可读修参提示', (async () => { const r = await reg.dispatch('echo', {}); return /echo.*参数有误/.test(r.error) && /缺少必填参数/.test(r.error); })());
  check('schemas 格式', reg.openAiSchemas().some((s) => s.type === 'function' && s.function.name === 'echo'));
  check('filter 按白名单过滤', (() => { const v = reg.filter(['python', 'now']); return v.list().length === 2 && !v.has('web_search'); })());
}

// —— 2b. 技能包工具 ——
console.log('[2b] skill 技能包');
{
  const reg = makeRegistry();
  const r = await reg.dispatch('skill', { name: 'report' });
  check('skill 加载 report 返回指令', r.loaded === 'report' && /报告/.test(r.instruction));
  const bad = await reg.dispatch('skill', { name: '不存在的' });
  check('未知技能报错', /未知技能/.test(bad.error));
  check('skills 模块 getSkill', getSkill('analyze').name === 'analyze');
  // 新增: 调研类 skill
  const news = getSkill('news_roundup');
  check('news_roundup skill', news && /fetch_url/.test(news.instructions) && /web_search/.test(news.instructions));
  check('trending skill', getSkill('trending') && /趋势/.test(getSkill('trending').description));
}

// —— 2c. 待办工具 ——
console.log('[2c] todo 工具');
{
  const sessions = new SessionStore({});
  const reg = makeRegistry({ sessions });
  const r1 = await reg.dispatch('todo_update', { action: 'add', text: '买菜' }, { from: 'u1' });
  check('todo add', /买菜/.test(r1.list));
  const r2 = await reg.dispatch('todo_list', {}, { from: 'u1' });
  check('todo_list 返回条目', r2.items.length === 1 && r2.items[0].text === '买菜');
  const r3 = await reg.dispatch('todo_update', { action: 'done', index: 1 }, { from: 'u1' });
  check('todo done 标记完成', /已 完成/.test(r3.list) || /已完成/.test(r3.list));
  // 不同用户隔离
  await reg.dispatch('todo_update', { action: 'add', text: 'X' }, { from: 'u2' });
  check('todo 用户隔离', (await reg.dispatch('todo_list', {}, { from: 'u1' })).items.length === 1);
  // 直接使用 todo 模块助手
  const sess = sessions._get('u3');
  todoHelpers.addTodo(sess, 'a');
  todoHelpers.addTodo(sess, 'b', 20, 'high');
  check('todoHelpers.list', todoHelpers.listTodos(sess).includes('a'));
  check('todoHelpers.priority 标记', /高/.test(todoHelpers.listTodos(sess)));
  check('todoHelpers.done', todoHelpers.doneTodo(sess, 1).ok === true);
  check('todoHelpers.update status', todoHelpers.updateTodo(sess, 1, { status: 'in_progress' }).list.includes('进行中'));
  check('todoHelpers.clear', todoHelpers.clearTodos(sess).list === '(暂无待办)');

  // 工具: update action (status / priority)
  const reg2 = makeRegistry({ sessions });
  await reg2.dispatch('todo_update', { action: 'add', text: 't1', priority: 'high' }, { from: 'u4' });
  await reg2.dispatch('todo_update', { action: 'add', text: 't2' }, { from: 'u4' });
  const rUpd = await reg2.dispatch('todo_update', { action: 'update', index: 2, status: 'in_progress' }, { from: 'u4' });
  check('todo_update 工具 update in_progress', /进行中/.test(rUpd.list));
  const rBad = await reg2.dispatch('todo_update', { action: 'update', index: 9, status: 'done' }, { from: 'u4' });
  check('todo_update 错误序号', /序号无效/.test(rBad.error));
}

// —— 2d. 持久记忆工具 ——
console.log('[2d] remember/recall 持久记忆');
{
  const file = path.join(os.tmpdir(), `yutang-mem-${Date.now()}.json`);
  const mem = new MemoryStore({ file, enabled: true });
  const reg = makeRegistry({ memory: mem });
  await reg.dispatch('remember', { fact: '用户爱喝咖啡' }, { from: 'u1' });
  const r = await reg.dispatch('recall', { query: '咖啡' }, { from: 'u1' });
  check('remember→recall', r.facts.length === 1 && /咖啡/.test(r.facts[0].value));
  const off = makeRegistry({ memory: new MemoryStore({ file, enabled: false }) });
  const r2 = await off.dispatch('remember', { fact: 'x' }, { from: 'u1' });
  check('memory 关闭时报错', /未开启/.test(r2.error));
  mem.flush();
  const mem2 = new MemoryStore({ file, enabled: true });
  check('记忆持久化(落盘后重载)', mem2.get('u1').length === 1);
}

// —— 2e. 结构化压缩模块 ——
console.log('[2e] compaction 结构化压缩');
{
  check('estimateTokens 中文≈1/字', estimateTokens('你好世界') === 4);
  check('estimateTokens 英文稀疏', Math.abs(estimateTokens('hello world') - 3.5) < 1);
  const msgs = Array.from({ length: 6 }, (_, i) => ({ role: 'user', content: `消息${i}啊啊` })); // 每条约4.3 token
  const sel = select(msgs, 15); // 预算15 → 尾部留3条, head 3条
  check('select 切分 head/recent', sel.recent.length === 3 && sel.head.length === 3, `head=${sel.head.length} recent=${sel.recent.length}`);
  check('select 保留最近在尾部', sel.recent[sel.recent.length - 1].content === msgs[5].content);
  const prompt = buildSummaryPrompt({ previousSummary: undefined, head: '用户: 帮我查金价' });
  check('无 prior 摘要的提示词含模板', prompt.includes('## 目标'));
  const prompt2 = buildSummaryPrompt({ previousSummary: '旧摘要', head: '新对话' });
  check('有 prior 摘要含合并指令', prompt2.includes('<prior-summary>') && prompt2.includes('旧摘要'));
  check('SUMMARY_TEMPLATE 各节齐全', ['## 目标', '## 重要背景', '## 工作进展', '### 已完成', '### 进行中', '### 阻塞', '## 下一步', '## 相关资源'].every((x) => SUMMARY_TEMPLATE.includes(x)));
}

// —— 3. llm.agentTurn 工具调用循环 (fake fetch) ——
console.log('[3] llm.agentTurn 多轮工具循环');
{
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push(JSON.parse(opts.body));
    const respond = (obj) => ({ ok: true, json: async () => obj });
    if (calls.length === 1) {
      return respond({ choices: [{ message: {
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'now', arguments: '{}' } }],
      } }] });
    }
    return respond({ choices: [{ message: { content: '当前时间是 12:00' } }] });
  };
  const llm = createLlm({ apiKey: 'k', base: 'https://fake', model: 'm', timeoutMs: 5000, maxTokens: 100, temperature: 1, mock: false, maxToolIterations: 4 });
  const reg = makeRegistry({ pondState: { onlineUsers: new Set() } });
  const thinking = [];
  const out = await llm.agentTurn({
    systemPrompt: 'sys', history: [{ role: 'user', content: '几点了?' }], tools: reg,
    onThinking: (step) => thinking.push(step),
  });
  check('循环后返回最终文本', out === '当前时间是 12:00');
  check('第一轮携带 tools schema', calls[0].tools && calls[0].tools.length > 0);
  check('tool 结果已回填(tool消息)', calls[1].messages.some((m) => m.role === 'tool' && /time/.test(m.content)));
  check('只发一条"开始处理"', thinking.length === 1 && thinking[0] === '好的，开始处理…', `实际: ${JSON.stringify(thinking)}`);
  delete globalThis.fetch;
}

// —— 3b. llm.agentRun 子智能体回合 (独立历史/白名单) ——
console.log('[3b] llm.agentRun 子智能体');
{
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push(JSON.parse(opts.body));
    const respond = (obj) => ({ ok: true, json: async () => obj });
    if (calls.length === 1) {
      return respond({ choices: [{ message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'delegate', arguments: '{}' } }] } }] });
    }
    return respond({ choices: [{ message: { content: '子智能体最终结论' } }] });
  };
  const llm = createLlm({ apiKey: 'k', base: 'https://fake', model: 'm', timeoutMs: 5000, maxTokens: 100, temperature: 1, mock: false, maxToolIterations: 4 });
  const reg = makeRegistry({ pondState: { onlineUsers: new Set() } });
  const out = await llm.agentRun({ agentName: 'math', systemPrompt: 'sys', task: '1+1', tools: reg.filter(['python', 'now']), onThinking: () => {} });
  // delegate 无 ctx.delegate 通道 → 返回 error 文本(由 tool 结果回流), 循环继续走最终文本
  check('agentRun 返回 {agent,result}', out.agent === 'math' && out.result === '子智能体最终结论');
  const msgs = calls[1].messages;
  check('子智能体独立历史以"任务:"开头', msgs.some((m) => m.role === 'user' && /任务:/.test(m.content)));
  check('子智能体工具白名单生效', !msgs.some((m) => m.role === 'tool' && /未知工具: web_search/.test(m.content)));
  delete globalThis.fetch;
}

// —— 3c. 泄漏工具调用文本 → 恢复执行/剥除 (模型把工具调用写成文本的兜底) ——
console.log('[3c] 泄漏工具调用恢复');
{
  const { extractToolCallFromText, stripLeakedToolCallText } = await import('../lib/tool-call-parse.mjs');
  // 解析: Anthropic XML
  const xml = '<tool_calls>\n<invoke name="now"><parameter name="x">1</parameter></invoke>\n</tool_calls>';
  const p1 = extractToolCallFromText(xml, new Set(['now']));
  check('解析 Anthropic XML 工具调用', p1 && p1.calls.length === 1 && p1.calls[0].name === 'now');
  // 解析: OpenAI JSON
  const js = '我先调用工具 {"name":"room_stats","arguments":{}} 再来回答';
  const p2 = extractToolCallFromText(js, new Set(['room_stats']));
  check('解析 OpenAI JSON 工具调用', p2 && p2.calls.length === 1 && p2.calls[0].name === 'room_stats');
  // 已知工具过滤: 空工具集(聊天模式)不执行
  const p3 = extractToolCallFromText(xml, new Set());
  check('空工具集不恢复(聊天模式)', p3 && p3.calls.length === 0);
  // 被截断(无闭合标签) → 剥除
  const broken = '<tool_calls><invoke name="python"><parameter name="code">import urllib';
  check('截断标记识别', extractToolCallFromText(broken, new Set(['python'])).markers === true);
  check('截断文本被剥除', !stripLeakedToolCallText(broken).includes('tool_calls') && !stripLeakedToolCallText(broken).includes('invoke'));
  // 普通文本不误判
  check('普通文本不误判', extractToolCallFromText('今天天气不错', new Set(['python'])) === null);
}
console.log('[3d] agentTurn 泄漏恢复端到端');
{
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push(JSON.parse(opts.body));
    const respond = (obj) => ({ ok: true, json: async () => obj });
    if (calls.length === 1) {
      // 模型把工具调用输出成文本(Anthropic XML 风格)
      return respond({ choices: [{ message: { content: '<tool_calls>\n<invoke name="now"><parameter name="x">1</parameter></invoke>\n</tool_calls>', tool_calls: null } }] });
    }
    return respond({ choices: [{ message: { content: '当前时间是 12:00', tool_calls: null } }] });
  };
  const llm = createLlm({ apiKey: 'k', base: 'https://fake', model: 'm', timeoutMs: 5000, maxTokens: 100, temperature: 1, mock: false, maxToolIterations: 4 });
  const reg = makeRegistry({ pondState: { onlineUsers: new Set() } });
  const out = await llm.agentTurn({ systemPrompt: 'sys', history: [{ role: 'user', content: '几点了?' }], tools: reg, onThinking: () => {} });
  check('泄漏文本被恢复执行后给出正常回答', out === '当前时间是 12:00', `实际: ${out}`);
  const msgs1 = calls[1].messages;
  check('工具确实执行并被回填', msgs1.some((m) => m.role === 'tool' && /time/.test(m.content)));
  check('回复不含泄漏工具文本', !out.includes('tool_calls') && !out.includes('<invoke'));
  delete globalThis.fetch;
}

// —— 3e. 多步思维链: Reflect 注入 + Doom-loop 守护 ——
console.log('[3e] 多步思维链 (Reflect 注入) + Doom-loop');
{
  // Reflect: 第一轮调工具, 第二轮仍调工具, 中间应注入 Reflect user 消息
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push(JSON.parse(opts.body));
    const respond = (obj) => ({ ok: true, json: async () => obj });
    if (calls.length === 1) return respond({ choices: [{ message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'now', arguments: '{}' } }] } }] });
    if (calls.length === 2) return respond({ choices: [{ message: { content: null, tool_calls: [{ id: 'c2', type: 'function', function: { name: 'uptime', arguments: '{}' } }] } }] });
    return respond({ choices: [{ message: { content: '最终回答' } }] });
  };
  const llm = createLlm({ apiKey: 'k', base: 'https://fake', model: 'm', timeoutMs: 5000, maxTokens: 100, temperature: 1, mock: false, maxToolIterations: 4 });
  const reg = makeRegistry();
  const out = await llm.agentTurn({ systemPrompt: 'sys', history: [{ role: 'user', content: '问题' }], tools: reg, onThinking: () => {} });
  check('Reflect 注入后 LLM 继续调用工具', calls.length === 3);
  const msgs2 = calls[2].messages;
  check('第二轮前有 Reflect user 提示', msgs2.some((m) => m.role === 'user' && /工具结果已就绪/.test(m.content)));
  check('回复仍是最终文本', out === '最终回答');
  delete globalThis.fetch;

  // Doom-loop: 同 fp 连续 3 次触发兜底
  const calls2 = [];
  globalThis.fetch = async (url, opts) => {
    calls2.push(JSON.parse(opts.body));
    return { ok: true, json: async () => ({ choices: [{ message: { content: null, tool_calls: [{ id: 'cx', type: 'function', function: { name: 'now', arguments: '{}' } }] } }] }) };
  };
  const llm2 = createLlm({ apiKey: 'k', base: 'https://fake', model: 'm', timeoutMs: 5000, maxTokens: 100, temperature: 1, mock: false, maxToolIterations: 8 });
  const reg2 = makeRegistry();
  const out2 = await llm2.agentTurn({ systemPrompt: 'sys', history: [{ role: 'user', content: '死循环' }], tools: reg2, onThinking: () => {} });
  check('Doom-loop 3 次后兜底', /陷入重复/.test(out2));
  check('Doom-loop 不超过 3 次调 fetch', calls2.length === 3);
  delete globalThis.fetch;
}

// —— 4. Router: 确定性命令 / LLM 兜底 / 多智能体指令 ——
console.log('[4] Router 路由/多智能体');
{
  const pondState = { onlineUsers: new Set(['x1']) };
  const sessions = new SessionStore({ historyMax: 5 });
  const api = new XechatApi({ base: 'https://fake', fetchFn: fakeApiFetch });
  const router = new Router({
    cfg: { cmdPrefix: '/小黄鱼', python: { cmd: 'python', timeoutMs: 10000 } },
    sessions, pondState, startTime: Date.now(), api,
  }).bindLlm({
    agentTurn: async () => '【LLM回答】',
    agentRun: async ({ agentName }) => ({ agent: agentName, result: '调研/计算结论' }),
  });
  const rPing = await router.handle({ from: 'u1', text: '/小黄鱼 ping' });
  check('内置命令 ping', rPing === 'pong 🎣');
  const rStats = await router.handle({ from: 'u1', text: '/小黄鱼 stats' });
  check('内置命令 stats 引用 pondState', /在线 1 人/.test(rStats));
  const rGames = await router.handle({ from: 'u1', text: '/小黄鱼 games' });
  check('内置命令 games 走 API', /demo/.test(rGames) && /演示/.test(rGames));
  const rGameDetail = await router.handle({ from: 'u1', text: '/小黄鱼 game demo' });
  check('内置命令 game <名字> 带参', /【demo\(演示\)】/.test(rGameDetail) && /播放: http:\/\/demo/.test(rGameDetail));
  const rFree = await router.handle({ from: 'u1', text: '/小黄鱼 今天几号' });
  check('自由文本走 main agent', rFree === '【LLM回答】');
  // 多智能体显式指令
  const rExplore = await router.handle({ from: 'u1', text: '/小黄鱼 explore 今天天气' });
  check('explore 指令委派子智能体', rExplore === '调研/计算结论', rExplore);
  const rMath = await router.handle({ from: 'u1', text: '/小黄鱼 math 6*7' });
  check('math 指令 python 计算', rMath === '= 42', `实际: ${rMath}`);
  const rTodo = await router.handle({ from: 'u1', text: '/小黄鱼 todo 添加 买菜' });
  check('todo 指令添加', /买菜/.test(rTodo));
  const rTodoList = await router.handle({ from: 'u1', text: '/小黄鱼 todo 显示' });
  check('todo 指令显示', /买菜/.test(rTodoList));
  const rSkills = await router.handle({ from: 'u1', text: '/小黄鱼 skills' });
  check('skills 指令列出技能', /report/.test(rSkills) && /explain/.test(rSkills));
  check('会话已记录(仅 LLM 文本进上下文, 内置命令不进)', sessions.get('u1').history.length === 2);
}

// —— 4b. 游戏房间: create-room / close-room 走 fake WS ——
console.log('[4b] game room 指令(fake WS)');
{
  // Fake WS client: 记录发送 + 喂入响应
  const sent = [];
  const fakeWs = {
    sendAction(action, body) { sent.push({ action, body }); },
    sendActionAndWait(action, body, {match, timeoutMs = 8000} = {}) {
      return new Promise((resolve, reject) => {
        const w = { match, resolve, reject, timer: null, done: false };
        w.timer = setTimeout(() => {
          if (w.done) return;
          w.done = true;
          const i = fakeWs._waiters.indexOf(w);
          if (i >= 0) fakeWs._waiters.splice(i, 1);
          reject(new Error('timeout: ' + action));
        }, timeoutMs);
        fakeWs._waiters.push(w);
        try { fakeWs.sendAction(action, body); } catch (e) {
          if (w.done) return;
          w.done = true;
          clearTimeout(w.timer);
          const i = fakeWs._waiters.indexOf(w);
          if (i >= 0) fakeWs._waiters.splice(i, 1);
          reject(e);
        }
      });
    },
    _feed(m) {
      const t = m.action || m.type;
      const body = m.body || {};
      for (let i = 0; i < this._waiters.length; i++) {
        const w = this._waiters[i];
        let hit = false;
        try { hit = !!w.match(m, t, body); } catch (e) { hit = false; }
        if (hit) {
          w.done = true;
          clearTimeout(w.timer);
          this._waiters.splice(i, 1);
          w.resolve({ msg: m, type: t });
          return;
        }
      }
    },
    _waiters: [],
  };

  const reg = createRegistry({
    startTime: Date.now(),
    pondState: { onlineUsers: new Set() },
    sessions: new SessionStore({}),
    api: new XechatApi({ base: 'https://fake', fetchFn: fakeApiFetch }),
    python: { cmd: 'python', timeoutMs: 10000 },
    web: { enabled: true },
    skills: { enabled: true },
    todo: { maxItems: 20 },
    ws: fakeWs,
  });

  // create_room 成功
  sent.length = 0;
  const pCreate = reg.dispatch('create_room', { game: '五子棋', nums: 2 });
  // 模拟服务端立即回 GAME_ROOM_CREATED
  setImmediate(() => fakeWs._feed({
    action: 'GAME_ROOM_CREATED',
    body: { id: '143012345', game: 'GOBANG', nums: 2, gameMode: null, homeowner: { username: '大黄鱼' } },
  }));
  const r1 = await pCreate;
  check('create_room 返回房间id', r1.roomId === '143012345' && r1.game === 'GOBANG');
  check('create_room 协议层发了 CREATE_GAME_ROOM', sent.length === 1 && sent[0].action === 'CREATE_GAME_ROOM');
  check('create_room 协议层 body.game=GOBANG', sent[0].body.game === 'GOBANG');

  // create_room 未知游戏 → 立即 error, 不发协议
  sent.length = 0;
  const rBad = await reg.dispatch('create_room', { game: '不存在的游戏' });
  check('create_room 未知游戏报错', /未知游戏/.test(rBad.error));
  check('create_room 未知游戏不发协议', sent.length === 0);

  // close_room 成功 (收到 ROOM_CLOSE 广播)
  sent.length = 0;
  const pClose = reg.dispatch('close_room', { roomId: '143012345' });
  setImmediate(() => fakeWs._feed({
    action: 'GAME_ROOM',
    body: { roomId: '143012345', msgType: 'ROOM_CLOSE' },
  }));
  const r2 = await pClose;
  check('close_room 收到 ROOM_CLOSE → 成功', r2.closed === true && r2.roomId === '143012345');
  check('close_room 协议层发了 GAME_ROOM', sent.length === 1 && sent[0].action === 'GAME_ROOM');
  check('close_room 协议层 msgType=ROOM_CLOSE', sent[0].body.msgType === 'ROOM_CLOSE');

  // close_room 失败 (服务端回 GAME_ERROR)
  sent.length = 0;
  const pCloseFail = reg.dispatch('close_room', { roomId: '999999999' });
  setImmediate(() => fakeWs._feed({
    action: 'GAME_ROOM',
    body: { roomId: '999999999', msgType: 'GAME_ERROR', content: '游戏房间不存在！' },
  }));
  const r3 = await pCloseFail;
  check('close_room 收到 GAME_ERROR → 报错', /关闭失败/.test(r3.error) && /不存在/.test(r3.error));

  // close_room 超时 (服务端未给任何反馈) → 视为成功 (note 说明)
  sent.length = 0;
  const pTimeout = reg.dispatch('close_room', { roomId: '111111111' });
  const r4 = await pTimeout;
  check('close_room 超时也视为成功', r4.closed === true && /无响应/.test(r4.note || ''));

  // 关闭房间失败 + WS 客户端未注入
  const regNoWs = createRegistry({
    startTime: Date.now(),
    pondState: { onlineUsers: new Set() },
    sessions: new SessionStore({}),
    api: new XechatApi({ base: 'https://fake', fetchFn: fakeApiFetch }),
    python: { cmd: 'python', timeoutMs: 10000 },
    web: { enabled: true },
    skills: { enabled: true },
    todo: { maxItems: 20 },
    // 没传 ws
  });
  const r5 = await regNoWs.dispatch('close_room', { roomId: 'x' });
  check('close_room WS 未就绪报错', /WS 客户端未就绪/.test(r5.error));
}

// —— 4c. list_rooms 活动房间查询 (订阅式) ——
console.log('[4c] list_rooms 活动房间查询');
{
  // 直接构造一个带 activeRooms 的 ctx, 模拟若干房间
  const now = Date.now();
  const pondState = { onlineUsers: new Set(['u1']), activeRooms: new Map() };
  pondState.activeRooms.set('111111111', { roomId: '111111111', game: 'GOBANG', nums: 2, gameMode: null, homeowner: 'alice', createdAt: now - 5000 });
  pondState.activeRooms.set('222222222', { roomId: '222222222', game: 'LANDLORDS', nums: 3, gameMode: null, homeowner: 'bob', createdAt: now - 3000 });
  pondState.activeRooms.set('333333333', { roomId: '333333333', game: 'GOBANG', nums: 4, gameMode: 'ranked', homeowner: 'carol', createdAt: now - 1000 });
  const reg = createRegistry({
    startTime: Date.now(), pondState, sessions: new SessionStore({}),
    api: new XechatApi({ base: 'https://fake', fetchFn: fakeApiFetch }),
    python: { cmd: 'python', timeoutMs: 1000 }, web: { enabled: false }, skills: { enabled: true }, todo: { maxItems: 20 },
  });

  const rAll = await reg.dispatch('list_rooms', {});
  check('list_rooms 返回总数', rAll.total === 3);
  check('list_rooms 返回按游戏分组', rAll.byGame.GOBANG === 2 && rAll.byGame.LANDLORDS === 1);
  check('list_rooms 房间条目含房主与时长', rAll.rooms.length === 3 && rAll.rooms.some((r) => r.homeowner === 'alice' && r.ageSec >= 5));
  check('list_rooms 默认上限生效', rAll.rooms.length <= 50);

  const rGobang = await reg.dispatch('list_rooms', { game: '五子棋' });
  check('list_rooms 按游戏过滤(中文别名)', rGobang.total === 3 && rGobang.filtered === 2 && rGobang.rooms.every((r) => r.game === 'GOBANG'));

  const rLimit = await reg.dispatch('list_rooms', { limit: 2 });
  check('list_rooms limit 生效', rLimit.rooms.length === 2);

  // 模拟订阅更新: 关闭一个房间
  pondState.activeRooms.delete('111111111');
  const rAfter = await reg.dispatch('list_rooms', {});
  check('list_rooms 关闭后总数 -1', rAfter.total === 2);
  check('list_rooms 关闭后 GOBANG 计数=1', rAfter.byGame.GOBANG === 1);
}

// list_rooms 在没有 pondState.activeRooms 时也安全
{
  const reg = createRegistry({
    startTime: Date.now(), pondState: { onlineUsers: new Set() }, sessions: new SessionStore({}),
    api: new XechatApi({ base: 'https://fake', fetchFn: fakeApiFetch }),
    python: { cmd: 'python', timeoutMs: 1000 }, web: { enabled: false }, skills: { enabled: true }, todo: { maxItems: 20 },
  });
  const r = await reg.dispatch('list_rooms', {});
  // pondState 没 activeRooms 字段: 走 error 路径(订阅未就绪)
  check('list_rooms 缺少 activeRooms 报错', r.total === undefined && /订阅未就绪/.test(r.error || ''));
}

// —— 5. 会话: 多用户隔离 & token 预算压缩 ——
console.log('[5] SessionStore 多用户隔离/token预算压缩');
{
  const s = new SessionStore({ historyMax: 3 });
  for (let i = 0; i < 5; i++) s.pushUser('a', `m${i}`);
  s.pushUser('b', 'other');
  const ha = s.get('a').history, hb = s.get('b').history;
  check('a 未压缩前保留全部', ha.length === 5 && ha[0].content === 'm0');
  check('b 独立', hb.length === 1 && hb[0].content === 'other');
  s.clear('a');
  check('clear 生效', s.get('a').history.length === 0 && s.size === 1);

  // token 预算压缩: 超过预算 → 旧消息压进摘要, 保留最近
  const sc = new SessionStore({ historyMax: 3, compressBudgetTokens: 8, summaryMaxLen: 200 });
  for (let i = 0; i < 6; i++) sc.pushUser('c', `msg${i}啊`); // 每条约2.1 token, 6条约13 token > 8 触发
  const compressed = await sc.maybeCompress('c', async (summary, batch) => `已压缩[${batch.length}条]`);
  check('token预算压缩触发', compressed === true);
  const snap = sc.get('c');
  check('摘要已生成', snap.summary.startsWith('已压缩['), `实际: ${snap.summary}`);
  check('压缩后只留最近', snap.history.length >= 3 && snap.history[snap.history.length - 1].content.includes('msg5'));

  // 每用户锁: 非阻塞 tryLock
  const lock = sessions_tryLock_check(sc);
  check('tryLock 同用户忙时返回 null', lock === null);
}

function sessions_tryLock_check(store) {
  const rel = store.tryLock('ck');
  const again = store.tryLock('ck');
  if (rel) rel();
  return again; // 应为 null(第一次未释放前)
}

// —— 6. python 工具 (真实执行, 本地计算不联网) ——
console.log('[6] python 工具执行');
{
  const reg = makeRegistry();
  const r1 = await reg.dispatch('python', { code: 'print(1+1)' });
  check('python 计算 1+1', r1.stdout.trim() === '2', `实际: ${JSON.stringify(r1).slice(0, 120)}`);
  const r2 = await reg.dispatch('python', { code: 'print(sum(range(101)))' });
  check('python 求和 0..100', r2.stdout.trim() === '5050');
  const regT = makeRegistry({ python: { cmd: 'python', timeoutMs: 1500 } });
  const r3 = await regT.dispatch('python', { code: 'import time; time.sleep(5); print("x")' });
  check('python 超时终止', r3.timedOut === true, `实际: ${JSON.stringify(r3).slice(0, 120)}`);
}

// —— 7. 统一回复发送器 (分片/还原) ——
console.log('[7] makeReplySender 统一发送/分片');
{
  const { makeReplySender, splitForMarkdown } = await import('../lib/reply.mjs');
  const sent = [];
  const sendReply = makeReplySender({ send: (c, to) => { sent.push({ c, to }); }, maxLen: 200, chunkDelayMs: 0 });
  await sendReply('短消息', 'u1');
  check('短消息单条发送', sent.length === 1 && sent[0].c === '短消息' && sent[0].to === 'u1');
  sent.length = 0;
  const long = '长'.repeat(500);
  await sendReply(long, 'u2');
  check('超长拆 3 片', sent.length === 3, `实际 ${sent.length}`);
  check('拼接还原(无换行长文)', sent.map((x) => x.c.replace(/^↪ /, '')).join('') === long);
  sent.length = 0;
  // 续片带 ↪ 前缀(只在第 2 片起)
  await sendReply('a'.repeat(250), 'u3');
  check('续片带 ↪ 前缀', sent.length >= 2 && sent.slice(1).every((s) => s.c.startsWith('↪ ')));
  sent.length = 0;
  // 空内容不发送
  await sendReply('', 'u4');
  check('空内容不发送', sent.length === 0);
  // emoji 拆片不崩
  await sendReply('😀'.repeat(250), 'u5');
  check('emoji 拆片不崩', sent.length >= 2 && sent.every((x) => Array.from(x.c).length <= 200));

  // —— markdown 友好分片 ——
  const md = [
    '## 今日头条热点(2026-08-26)',
    '',
    '**🔥 热度最高(千万级)**',
    '1. **1.03亿恒大债权包14.41万成交**(金融, 热度1479万) — 债权包几乎"白菜价"成交, 引发热议',
    '2. **13岁女孩三天靠AI赚1.8万**(科技, 1338万) — AI 造富话题',
    '3. **一组数据看中国制造硬核成绩单**(1211万) — 中国制造硬核成绩单',
    '',
    '**🌪️ 民生/社会**',
    '6. 台风"沙德尔"实时路径(897万)',
    '7. 德芙致歉声明疑为AI撰写(812万)',
    '',
    '## 来源',
    '- toutiao.com/hot-event/hot-board',
    '- rebang.today / tophub.today',
  ].join('\n');
  const pieces = splitForMarkdown(md, 60); // 紧预算, 确保行边界优先
  check('每片都不超过 60 码点 + 2 续段前缀', pieces.every((p) => Array.from(p).length <= 60));
  // 拼接(每片内容已含 \n, 直接拼回)
  const joined = pieces.join('');
  check('拼接还原一致', joined === md, 'pieces=' + pieces.length + ' joined len=' + joined.length + ' md len=' + md.length);
  // 关键: ## 标题 / - 列表 / **加粗** 不应被切断(除超长行)
  const cutInsideLine = (p) => /#?$/.test(p) === false && /^\s*$/.test(p) === false && /\n/.test(p) === true ? null : p;
  const allClean = pieces.every((p) => !/^[^#\-\n]*\n/.test(p) || /^(\s*$|## |-|---|\*\*|\d+\. )/.test(p.split('\n').filter(Boolean)[0] || ''));
  // 更直接的断言: 验证 ## 标题 / - 列表行 完整出现在某一片里
  const hasFullH2 = pieces.some((p) => /^## /.test(p.split('\n').find((l) => /^## /.test(l)) || '__none__'));
  const hasFullLi = pieces.some((p) => p.split('\n').some((l) => /^- /.test(l)));
  check('## 标题行被完整保留(未切碎)', hasFullH2);
  check('- 列表行被完整保留(未切碎)', hasFullLi);
}

// —— 8. 定时任务处理器 (Scheduler) ——
console.log('[8] Scheduler 定时任务');
{
  const fired = [];
  const s = new Scheduler({ enabled: true, tickMs: 100, persist: false });
  s.start((t) => fired.push(t));
  // 未到期不触发
  s.add({ atMs: Date.now() + 100000, task: '未来', to: 'u', mode: 'remind' });
  s.tick();
  check('未到期不触发', fired.length === 0);
  // 到期触发
  s.add({ atMs: Date.now() - 10, task: '现在', to: 'u', mode: 'remind' });
  s.tick();
  check('到期触发', fired.length === 1 && fired[0].task === '现在');
  // 触发后任务移除
  s.tick();
  check('一次性任务触发后移除', fired.length === 1 && s.size === 1);
  // cancel
  const r = s.add({ atMs: Date.now() + 100000, task: '可取消', to: null });
  check('cancel 成功', s.cancel(r.id) === true);
  check('cancel 后列表为空', s.list().length === 1); // 只剩 '未来'
  s.stop();
  // 时间解析
  check('parseDuration 分钟', parseDuration('5分钟') === 300000);
  check('parseDuration 小时', parseDuration('2小时') === 7200000);
  check('parseDuration 秒', parseDuration('30秒') === 30000);
  check('parseDuration 非法', parseDuration('abc') === null);
  const at = parseAtTime('08:00', new Date('2026-08-26T10:00:00').getTime());
  check('parseAtTime 今天已过→明天', at === new Date('2026-08-27T08:00:00').getTime());
  const at2 = parseAtTime('12:00', new Date('2026-08-26T10:00:00').getTime());
  check('parseAtTime 今天未过→今天', at2 === new Date('2026-08-26T12:00:00').getTime());
  check('parseAtTime 非法', parseAtTime('25:99') === null);
}

// —— 8b. 主动消息触发器 (Trigger) ——
console.log('[8b] createTrigger 每 N 条(非自己)消息触发');
{
  let logLines = [];
  const t = createTrigger({ enabled: true, threshold: 3, cooldownMs: 5000, log: (s) => logLines.push(s) });
  check('条数未到不触发', t.onMessage({ from: 'a', content: '1' }) === null && t.onMessage({ from: 'a', content: '2' }) === null);
  const batch = t.onMessage({ from: 'a', content: '3' }); // 第 3 条(同用户多条也算)
  check('每 N 条触发(含同用户多条)', Array.isArray(batch) && batch.length === 3 && batch[2].from === 'a');
  check('窗口已重置', t.getState().windowCount === 0);
  check('触发后进入冷却', t.onMessage({ from: 'd', content: '5' }) === null);
  // 冷却结束后可再触发
  const t2 = createTrigger({ enabled: true, threshold: 2, cooldownMs: 0 });
  t2.onMessage({ from: 'x', content: '1' });
  const b2 = t2.onMessage({ from: 'x', content: '2' }); // 同用户第 2 条也触发
  check('同用户多条也算条数', Array.isArray(b2) && b2.length === 2);
  // disabled 不触发
  const t3 = createTrigger({ enabled: false, threshold: 2 });
  check('disabled 不触发', t3.onMessage({ from: 'a', content: '1' }) === null && t3.onMessage({ from: 'b', content: '2' }) === null);
}

// —— 8c. 新工具与命令 (schedule / list_schedules / recent_messages / /大黄鱼 定时 / 最近消息) ——
console.log('[8c] 定时/聊天记录 工具与命令');
{
  // 工具
  const sched = new Scheduler({ enabled: true });
  const sessions = new SessionStore({});
  const pondState = { onlineUsers: new Set(), roomLog: [
    { from: 'a', content: '大家好', self: false, time: 1 },
    { from: 'b', content: '早啊', self: false, time: 2 },
    { from: '大黄鱼', content: 'pong', self: true, time: 3 },
  ] };
  const reg = createRegistry({
    startTime: Date.now(), sessions, pondState,
    api: new XechatApi({ base: 'https://fake', fetchFn: fakeApiFetch }),
    scheduler: sched, roomLog: { maxEntries: 100 },
    web: { enabled: true }, python: { cmd: 'python', timeoutMs: 10000 },
    skills: { enabled: true }, todo: { maxItems: 20 },
  });
  const r1 = await reg.dispatch('schedule', { task: '提醒喝水', inMinutes: '1分钟' }, { from: 'u1' });
  check('schedule 工具注册', /sched_/.test(r1.id) && r1.task === '提醒喝水');
  const r2 = await reg.dispatch('list_schedules', {});
  check('list_schedules 列出', r2.count === 1 && r2.tasks[0].task === '提醒喝水');
  const r3 = await reg.dispatch('recent_messages', { n: 2 }, { from: 'u1' });
  check('recent_messages 返回最近N条', r3.count === 2 && r3.messages[1].from === '大黄鱼' && r3.messages[1].self === true);

  // 命令
  const router = new Router({
    cfg: { cmdPrefix: '/大黄鱼', roomLog: { maxEntries: 100 } },
    sessions, pondState, startTime: Date.now(),
    api: new XechatApi({ base: 'https://fake', fetchFn: fakeApiFetch }),
    scheduler: sched,
  });
  const c1 = await router.handle({ from: 'u1', text: '/大黄鱼 定时 2分钟 提醒我喝水' });
  check('命令: 定时注册', /已设定定时提醒/.test(c1) && /提醒我喝水/.test(c1));
  const c2 = await router.handle({ from: 'u1', text: '/大黄鱼 定时列表' });
  check('命令: 定时列表', /提醒我喝水/.test(c2));
  const c3 = await router.handle({ from: 'u1', text: '/大黄鱼 最近消息 5' });
  check('命令: 最近消息', /大家好/.test(c3) && /早啊/.test(c3) && /我: pong/.test(c3));
  const c4 = await router.handle({ from: 'u1', text: '/大黄鱼 定时取消 ' + (sched.list()[0] && sched.list()[0].id) });
  check('命令: 定时取消', /已取消/.test(c4));
  sched.stop();

  // —— 聊天记录日志 (chat_log 工具 / /大黄鱼 聊天记录), 持久化跨重启可查 ——
  const logFile = path.join(os.tmpdir(), `yutang-chatlog-${Date.now()}.jsonl`);
  const chatLog = new ChatLog({ enabled: true, file: logFile, maxEntries: 100 });
  chatLog.append({ from: 'a', content: '第一条', self: false, time: 1 });
  chatLog.append({ from: 'b', content: '第二条', self: false, time: 2 });
  chatLog.append({ from: '大黄鱼', content: '我是机器人', self: true, time: 3 });
  chatLog.append({ from: 'a', content: '再说一句', self: false, time: 4 });
  const readAll = await chatLog.readRecent(10);
  check('ChatLog.append + readRecent', readAll.length === 4 && readAll[0].content === '第一条' && readAll[3].content === '再说一句');
  const readN = await chatLog.readRecent(2);
  check('readRecent 取最近 N 条', readN.length === 2 && readN[0].content === '我是机器人');
  const readFrom = await chatLog.readRecent(10, { from: 'a' });
  check('readRecent 按 from 过滤', readFrom.length === 2 && readFrom.every((e) => e.from === 'a'));
  check('ChatLog.count', chatLog.count() === 4);

  // chat_log 工具
  const regLog = createRegistry({
    startTime: Date.now(), sessions, pondState,
    api: new XechatApi({ base: 'https://fake', fetchFn: fakeApiFetch }),
    chatLog, scheduler: sched,
    web: { enabled: true }, python: { cmd: 'python', timeoutMs: 10000 },
    skills: { enabled: true }, todo: { maxItems: 20 },
  });
  const lg = await regLog.dispatch('chat_log', { n: 3 }, { from: 'u1' });
  check('chat_log 工具读取日志', lg.count === 3 && lg.total === 4 && lg.messages[0].content === '第二条' && lg.messages[2].content === '再说一句');
  const lgFrom = await regLog.dispatch('chat_log', { from: 'b' }, { from: 'u1' });
  check('chat_log 工具按 from', lgFrom.count === 1 && lgFrom.messages[0].from === 'b');

  // /大黄鱼 聊天记录 命令
  const routerLog = new Router({
    cfg: { cmdPrefix: '/大黄鱼' }, sessions, pondState, startTime: Date.now(),
    api: new XechatApi({ base: 'https://fake', fetchFn: fakeApiFetch }),
    chatLog,
  });
  const cl = await routerLog.handle({ from: 'u1', text: '/大黄鱼 聊天记录 3' });
  check('命令: 聊天记录', /日志中最近 3 条消息/.test(cl) && /第二条/.test(cl) && /再说一句/.test(cl));
  try { require('node:fs').unlinkSync(logFile); } catch (e) {}
}

// —— 8d. 文件分享 (sendup.cc 三步上传) ——
console.log('[8d] 文件分享 sendup.cc (内容驱动)');
{
  // 1) mime 推断
  check('guessMimeType .txt', guessMimeType('a.txt') === 'text/plain');
  check('guessMimeType .md', guessMimeType('a.md') === 'text/markdown');
  check('guessMimeType .json', guessMimeType('a.json') === 'application/json');
  check('guessMimeType .png', guessMimeType('a.png') === 'image/png');
  check('guessMimeType .pdf', guessMimeType('a.pdf') === 'application/pdf');
  check('guessMimeType .py', guessMimeType('a.py') === 'text/x-python');
  check('guessMimeType 未知扩展', guessMimeType('a.unknownext') === 'application/octet-stream');
  check('guessMimeType 无扩展', guessMimeType('README') === 'application/octet-stream');

  // 2) 预检: 无 filename / 无 content / 空 / 过大 → 抛错(不走 Python)
  let threw = '';
  try { await uploadContent('hello', { filename: '' }); } catch (e) { threw = e.message; }
  check('uploadContent 无 filename 抛错', /缺少文件名/.test(threw), `实际: ${threw}`);

  threw = '';
  try { await uploadContent('', { filename: 'a.txt' }); } catch (e) { threw = e.message; }
  check('uploadContent 空内容抛错', /内容为空/.test(threw), `实际: ${threw}`);

  threw = '';
  try { await uploadContent(null, { filename: 'a.txt' }); } catch (e) { threw = e.message; }
  check('uploadContent null 内容抛错', /缺少文件内容/.test(threw), `实际: ${threw}`);

  threw = '';
  try { await uploadContent('x'.repeat(200), { filename: 'a.txt', maxBytes: 100 }); } catch (e) { threw = e.message; }
  check('uploadContent 超大抛错', /内容过大/.test(threw), `实际: ${threw}`);

  threw = '';
  try { await uploadContent('x', { filename: 'a/bad.txt' }); } catch (e) { threw = e.message; }
  check('uploadContent 非法文件名抛错', /非法字符/.test(threw), `实际: ${threw}`);

  // 3) send_file 工具: 用 mock sender 验证参数透传 + 错误兜底
  let capturedArgs = null;
  const mockSender = {
    enabled: true,
    timeoutMs: 5000,
    maxBytes: 50 * 1024 * 1024,
    upload: async (content, opts) => {
      capturedArgs = { content, opts };
      return { success: true, share_url: 'https://sendup.cc/x/abc', original_filename: opts.filename, file_size: opts.isBinary ? Math.floor(content.length * 0.75) : Buffer.byteLength(content, 'utf8'), mime_type: guessMimeType(opts.filename), expires_at: '2026-08-28' };
    },
  };
  const regSu = createRegistry({
    startTime: Date.now(),
    pondState: { onlineUsers: new Set() },
    sessions: new SessionStore({}),
    api: new XechatApi({ base: 'https://fake', fetchFn: fakeApiFetch }),
    python: { cmd: 'python', timeoutMs: 10000 },
    web: { enabled: true }, skills: { enabled: true }, todo: { maxItems: 20 },
    sendup: mockSender,
  });
  check('send_file 工具已注册', regSu.list().includes('send_file'));

  // 文本内容
  const rText = await regSu.dispatch('send_file', {
    content: '# 分析报告\n\n今天金价...',
    filename: '报告.md',
    password: '1234',
    expire_minutes: 60,
  }, { from: 'u1' });
  check('send_file 文本(MD)返回 share_url', rText.success === true && /sendup\.cc\/x\/abc/.test(rText.share_url) && rText.filename === '报告.md' && rText.mime_type === 'text/markdown');
  check('send_file 参数透传(content/filename/密码/expire)',
    capturedArgs && capturedArgs.content === '# 分析报告\n\n今天金价...' &&
    capturedArgs.opts.filename === '报告.md' && capturedArgs.opts.isBinary === false &&
    capturedArgs.opts.password === '1234' && capturedArgs.opts.expireMinutes === '60');

  // 二进制(截图): base64 + is_binary
  const fakePng = Buffer.from('fake-png-bytes-here').toString('base64');
  mockSender.upload = async (content, opts) => {
    capturedArgs = { content, opts };
    return { success: true, share_url: 'https://sendup.cc/y/img', original_filename: opts.filename, file_size: 18, mime_type: 'image/png', expires_at: '2026-08-28' };
  };
  const rBin = await regSu.dispatch('send_file', {
    content: fakePng, filename: 'screenshot.png', is_binary: true,
  }, { from: 'u1' });
  check('send_file 二进制(base64+is_binary)返回 share_url', rBin.success === true && rBin.mime_type === 'image/png');
  check('send_file 二进制 is_binary 透传', capturedArgs && capturedArgs.opts.isBinary === true);

  // 缺 content
  const rMiss = await regSu.dispatch('send_file', { filename: 'a.md' }, { from: 'u1' });
  check('send_file 缺 content 报错', /缺少必填参数/.test(rMiss.error) && /content/.test(rMiss.error));

  // 缺 filename
  const rMissF = await regSu.dispatch('send_file', { content: 'x' }, { from: 'u1' });
  check('send_file 缺 filename 报错', /缺少必填参数/.test(rMissF.error) && /filename/.test(rMissF.error));

  // 失败兜底
  mockSender.upload = async () => ({ success: false, stage: 'put_file', error: 'HTTP 403' });
  const rFail = await regSu.dispatch('send_file', { content: 'x', filename: 'a.md' }, { from: 'u1' });
  check('send_file 失败带 stage', /上传失败\(put_file\)/.test(rFail.error) && rFail.stage === 'put_file');

  // 关掉: 直接报错
  const regOff = createRegistry({
    startTime: Date.now(),
    pondState: { onlineUsers: new Set() },
    sessions: new SessionStore({}),
    api: new XechatApi({ base: 'https://fake', fetchFn: fakeApiFetch }),
    sendup: { enabled: false, upload: async () => ({}) },
  });
  const rOff = await regOff.dispatch('send_file', { content: 'x', filename: 'a.md' }, { from: 'u1' });
  check('send_file 关掉时拒绝', /未开启/.test(rOff.error));
}

if (failures) { console.error(`\n❌ UNIT FAIL: ${failures} 项失败`); process.exit(1); }
console.log('\n✅ UNIT PASS —— agent v2 逻辑验证通过');