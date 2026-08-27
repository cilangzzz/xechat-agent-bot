// agent 测试 —— LLM 工具循环 / 子智能体回合 / 泄漏恢复 / Reflect + Doom-loop
// 覆盖 lib/foundation/llm.mjs + tool-call-parse.mjs
import { createLlm } from '../../../lib/foundation/llm.mjs';
import { check } from './_state.mjs';
import { makeRegistry } from './_fixtures.mjs';

export async function run() {
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
    check('agentRun 返回 {agent,result}', out.agent === 'math' && out.result === '子智能体最终结论');
    const msgs = calls[1].messages;
    check('子智能体独立历史以"任务:"开头', msgs.some((m) => m.role === 'user' && /任务:/.test(m.content)));
    check('子智能体工具白名单生效', !msgs.some((m) => m.role === 'tool' && /未知工具: web_search/.test(m.content)));
    delete globalThis.fetch;
  }

  // —— 3c. 泄漏工具调用文本 → 恢复执行/剥除 ——
  console.log('[3c] 泄漏工具调用恢复');
  {
    const { extractToolCallFromText, stripLeakedToolCallText } = await import('../../../lib/foundation/tool-call-parse.mjs');
    const xml = '<tool_calls>\n<invoke name="now"><parameter name="x">1</parameter></invoke>\n</tool_calls>';
    const p1 = extractToolCallFromText(xml, new Set(['now']));
    check('解析 Anthropic XML 工具调用', p1 && p1.calls.length === 1 && p1.calls[0].name === 'now');
    const js = '我先调用工具 {"name":"room_stats","arguments":{}} 再来回答';
    const p2 = extractToolCallFromText(js, new Set(['room_stats']));
    check('解析 OpenAI JSON 工具调用', p2 && p2.calls.length === 1 && p2.calls[0].name === 'room_stats');
    const p3 = extractToolCallFromText(xml, new Set());
    check('空工具集不恢复(聊天模式)', p3 && p3.calls.length === 0);
    const broken = '<tool_calls><invoke name="python"><parameter name="code">import urllib';
    check('截断标记识别', extractToolCallFromText(broken, new Set(['python'])).markers === true);
    check('截断文本被剥除', !stripLeakedToolCallText(broken).includes('tool_calls') && !stripLeakedToolCallText(broken).includes('invoke'));
    check('普通文本不误判', extractToolCallFromText('今天天气不错', new Set(['python'])) === null);
  }

  // —— 3d. agentTurn 泄漏恢复端到端 ——
  console.log('[3d] agentTurn 泄漏恢复端到端');
  {
    const calls = [];
    globalThis.fetch = async (url, opts) => {
      calls.push(JSON.parse(opts.body));
      const respond = (obj) => ({ ok: true, json: async () => obj });
      if (calls.length === 1) {
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
}