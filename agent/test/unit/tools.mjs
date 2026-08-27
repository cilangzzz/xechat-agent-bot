// agent 测试 —— 工具注册表 / 技能 / 待办 / 记忆 / 压缩 / 定时·聊天记录 / 上传
// 覆盖 lib/business/tools/ 全部工具类测试 + compaction / sendup 相关模块
import { createRegistry, ToolRegistry } from '../../lib/business/tools/index.mjs';
import { SessionStore } from '../../lib/business/sessions.mjs';
import { XechatApi } from '../../lib/platform/xechat-api.mjs';
import { MemoryStore } from '../../lib/business/memory.mjs';
import { estimateTokens, select, buildSummaryPrompt, SUMMARY_TEMPLATE } from '../../lib/foundation/compaction.mjs';
import * as todoHelpers from '../../lib/business/todo.mjs';
import { getSkill } from '../../lib/business/skills.mjs';
import { Scheduler, parseAtTime, parseDuration } from '../../lib/business/scheduler.mjs';
import { ChatLog } from '../../lib/business/chat-log.mjs';
import { guessMimeType, uploadContent } from '../../lib/platform/sendup.mjs';
import { Router } from '../../lib/business/router.mjs';
import os from 'node:os';
import path from 'node:path';
import { unlinkSync } from 'node:fs';
import { check } from './_state.mjs';
import { fakeApiFetch, makeRegistry } from './_fixtures.mjs';

export async function run() {
  // —— 2. 工具注册表 (v2) / 新工具 ——
  console.log('[2] ToolRegistry(v2) 注册/派发/新工具');
  {
    const reg = makeRegistry();
    check('内置工具已注册', ['now', 'uptime', 'room_stats', 'session_stats', 'python', 'web_search', 'fetch_url', 'gold_price', 'games', 'game_detail', 'leaderboard', 'create_room', 'close_room', 'list_rooms', 'delegate', 'todo_list', 'todo_update', 'remember', 'recall', 'skill'].every((n) => reg.list().includes(n)));
    check('room_stats 返回在线数', (await reg.dispatch('room_stats', {})).online_count === 2);
    check('games 工具查询游戏列表', (async () => { const r = await reg.dispatch('games', {}); return r.total === 1 && r.games[0].name === 'demo'; })());
    check('game_detail 工具查详情', (async () => { const r = await reg.dispatch('game_detail', { id: 1 }); return r.zhName === '演示' && r.downloadUrl === '/api/file/download/1'; })());
    check('leaderboard 工具查排行', (async () => { const r = await reg.dispatch('leaderboard', { gameInfoId: 1 }); return r.ranking.length === 2 && r.ranking[0].username === 'alice'; })());
    check('未知工具返回 error', (await reg.dispatch('no_such', {})).error);
    reg.register({ name: 'echo', description: '回显', parameters: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] }, run: async ({ x }) => ({ echoed: x }) });
    check('自定义工具可派发(兼容 name 字段)', (await reg.dispatch('echo', { x: 'hi' })).echoed === 'hi');
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
    await reg.dispatch('todo_update', { action: 'add', text: 'X' }, { from: 'u2' });
    check('todo 用户隔离', (await reg.dispatch('todo_list', {}, { from: 'u1' })).items.length === 1);
    const sess = sessions._get('u3');
    todoHelpers.addTodo(sess, 'a');
    todoHelpers.addTodo(sess, 'b', 20, 'high');
    check('todoHelpers.list', todoHelpers.listTodos(sess).includes('a'));
    check('todoHelpers.priority 标记', /高/.test(todoHelpers.listTodos(sess)));
    check('todoHelpers.done', todoHelpers.doneTodo(sess, 1).ok === true);
    check('todoHelpers.update status', todoHelpers.updateTodo(sess, 1, { status: 'in_progress' }).list.includes('进行中'));
    check('todoHelpers.clear', todoHelpers.clearTodos(sess).list === '(暂无待办)');

    const reg2 = makeRegistry({ sessions });
    await reg2.dispatch('todo_update', { action: 'add', text: 't1', priority: 'high' }, { from: 'u4' });
    await reg2.dispatch('todo_update', { action: 'add', text: 't2' }, { from: 'u4' });
    const rUpd = await reg2.dispatch('todo_update', { action: 'update', index: 2, status: 'in_progress' }, { from: 'u4' });
    check('todo_update 工具 update in_progress', /进行中/.test(rUpd.list));
    const rBad = await reg2.dispatch('todo_update', { action: 'update', index: 9, status: 'done' }, { from: 'u4' });
    check('todo_update 错误序号', /序号无效/.test(rBad.error));
  }

  // —— 2d. 持久记忆 ——
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
    const msgs = Array.from({ length: 6 }, (_, i) => ({ role: 'user', content: `消息${i}啊啊` }));
    const sel = select(msgs, 15);
    check('select 切分 head/recent', sel.recent.length === 3 && sel.head.length === 3, `head=${sel.head.length} recent=${sel.recent.length}`);
    check('select 保留最近在尾部', sel.recent[sel.recent.length - 1].content === msgs[5].content);
    const prompt = buildSummaryPrompt({ previousSummary: undefined, head: '用户: 帮我查金价' });
    check('无 prior 摘要的提示词含模板', prompt.includes('## 目标'));
    const prompt2 = buildSummaryPrompt({ previousSummary: '旧摘要', head: '新对话' });
    check('有 prior 摘要含合并指令', prompt2.includes('<prior-summary>') && prompt2.includes('旧摘要'));
    check('SUMMARY_TEMPLATE 各节齐全', ['## 目标', '## 重要背景', '## 工作进展', '### 已完成', '### 进行中', '### 阻塞', '## 下一步', '## 相关资源'].every((x) => SUMMARY_TEMPLATE.includes(x)));
  }

  // —— 8c. 新工具与命令 (schedule / list_schedules / recent_messages / /大黄鱼 定时 / 最近消息 / chat_log) ——
  console.log('[8c] 定时/聊天记录 工具与命令');
  {
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

    const routerLog = new Router({
      cfg: { cmdPrefix: '/大黄鱼' }, sessions, pondState, startTime: Date.now(),
      api: new XechatApi({ base: 'https://fake', fetchFn: fakeApiFetch }),
      chatLog,
    });
    const cl = await routerLog.handle({ from: 'u1', text: '/大黄鱼 聊天记录 3' });
    check('命令: 聊天记录', /日志中最近 3 条消息/.test(cl) && /第二条/.test(cl) && /再说一句/.test(cl));
    try { unlinkSync(logFile); } catch (e) {}
  }

  // —— 8d. sendup.mjs 单元 + upload_image 工具 ——
  console.log('[8d] 文件分享 + 平台上传');
  {
    check('guessMimeType .txt', guessMimeType('a.txt') === 'text/plain');
    check('guessMimeType .md', guessMimeType('a.md') === 'text/markdown');
    check('guessMimeType .json', guessMimeType('a.json') === 'application/json');
    check('guessMimeType .png', guessMimeType('a.png') === 'image/png');
    check('guessMimeType .pdf', guessMimeType('a.pdf') === 'application/pdf');
    check('guessMimeType .py', guessMimeType('a.py') === 'text/x-python');
    check('guessMimeType 未知扩展', guessMimeType('a.unknownext') === 'application/octet-stream');
    check('guessMimeType 无扩展', guessMimeType('README') === 'application/octet-stream');

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

    let capturedArgs = null;
    const mockApi = {
      token: 'mock-token',
      uploadFile: async (args) => {
        capturedArgs = args;
        return {
          id: 42, fileName: args.filename, filePath: `${args.bizType}/${args.filename}`,
          fileSize: args.isBinary ? Math.floor(args.content.length * 0.75) : Buffer.byteLength(args.content, 'utf8'),
          mimeType: 'image/png', bizType: args.bizType, md5: 'fake-md5',
          view_url: 'https://dld.lesscoding.net/api/file/view/42',
          download_url: 'https://dld.lesscoding.net/api/file/download/42',
        };
      },
    };
    const regUi = createRegistry({
      startTime: Date.now(), pondState: { onlineUsers: new Set() }, sessions: new SessionStore({}),
      api: mockApi, python: { cmd: 'python', timeoutMs: 10000 },
      web: { enabled: true }, skills: { enabled: true }, todo: { maxItems: 20 },
    });
    check('upload_image 工具已注册', regUi.list().includes('upload_image'));
    check('send_file 工具已下线', !regUi.list().includes('send_file'));

    const rText = await regUi.dispatch('upload_image', {
      content: '# 分析报告\n\n今天金价...', filename: '报告.md', bizType: 'user_avatar',
    }, { from: 'u1' });
    check('upload_image 文本(MD)返回 view_url', rText.success === true && /file\/view\/42/.test(rText.view_url) && rText.fileName === '报告.md' && rText.bizType === 'user_avatar' && rText.download_url);
    check('upload_image 文本参数透传(content/filename/bizType)',
      capturedArgs && capturedArgs.content === '# 分析报告\n\n今天金价...' &&
      capturedArgs.filename === '报告.md' && capturedArgs.isBinary === false &&
      capturedArgs.bizType === 'user_avatar');

    capturedArgs = null;
    const fakePng = Buffer.from('fake-png-bytes-here').toString('base64');
    const rBin = await regUi.dispatch('upload_image', {
      content: fakePng, filename: 'screenshot.png', is_binary: true,
    }, { from: 'u1' });
    check('upload_image 二进制(base64+is_binary)返回 view_url', rBin.success === true && /file\/view\/42/.test(rBin.view_url) && rBin.mimeType === 'image/png');
    check('upload_image 二进制 is_binary 透传', capturedArgs && capturedArgs.isBinary === true);

    const rMiss = await regUi.dispatch('upload_image', { filename: 'a.md' }, { from: 'u1' });
    check('upload_image 缺 content 报错', /缺少必填参数/.test(rMiss.error) && /content/.test(rMiss.error));
    const rMissF = await regUi.dispatch('upload_image', { content: 'x' }, { from: 'u1' });
    check('upload_image 缺 filename 报错', /缺少必填参数/.test(rMissF.error) && /filename/.test(rMissF.error));

    mockApi.uploadFile = async () => { throw new Error('HTTP 500'); };
    const rFail = await regUi.dispatch('upload_image', { content: 'x', filename: 'a.md' }, { from: 'u1' });
    check('upload_image 失败带错误信息', /上传失败/.test(rFail.error) && /HTTP 500/.test(rFail.error));

    const regNoApi = createRegistry({
      startTime: Date.now(), pondState: { onlineUsers: new Set() }, sessions: new SessionStore({}),
      python: { cmd: 'python', timeoutMs: 10000 }, web: { enabled: true },
      skills: { enabled: true }, todo: { maxItems: 20 },
    });
    const rNoApi = await regNoApi.dispatch('upload_image', { content: 'x', filename: 'a.md' }, { from: 'u1' });
    check('upload_image 无 api 注入报错', /XechatApi 未注入/.test(rNoApi.error));
  }
}