import { extractToolCallFromText, stripLeakedToolCallText } from './tool-call-parse.mjs';

// 鱼塘 agent 智能体 —— LLM 调用层 (升级版, references: opencode session/processor.ts)
// DeepSeek Chat Completions (OpenAI 兼容)。新增:
//   - agentRun(): 子智能体回合(独立历史 + 专用工具白名单), 供 delegate / explore / math 指令复用;
//   - 工具结果统一截断、错误参数以模型可读文本回流(由 tool-core.dispatch 完成)、网络瞬时错误重试一次;
//   - status 回调: 允许工具在长时间操作时向聊天广播 💭 进度;
//   - **多步思维链(Reflect)**: 工具结果回填后注入 user 提示, 强制模型评估"是否够/还要不要继续";
//     借鉴 opencode 的"每步工具结果后由模型自己反思"模式(无结构化 Reflect 工具, prompt-level)。
//   - **Doom-loop 守护**: 同名同参连续 3 次相同 tool call → 强制停止, 防无限循环。
// 兼容性: chat() / agentTurn() 公开签名与旧版一致。
const START_HINT = '好的，开始处理…';

/** 工具结果回填后注入 user 角色, 让模型评估"够不够 / 还要不要继续" —— 借鉴 opencode 多步调研模式。
 *  留最后一轮不注, 让模型自由收尾。 */
const REFLECT_PROMPT = `工具结果已就绪。先静默评估:
1) 当前信息够回答用户的原始问题吗?(够 → 直接给最终回答)
2) 不够 → 还缺什么?web_search 给的是 snippet,关键 URL 应 fetch_url 抓详情;数据/排行类用 python 处理/聚合。
3) 多步调研应在 todo_update 记录步骤,边干边勾。
**禁止** 拿到一个工具结果就直接总结;除非已调用 ≥2 个不同类型工具 且 数据足够,否则继续调用。`;

/** Doom-loop 阈值: 连续 N 次同名同参重复就停 */
const DOOM_LOOP_THRESHOLD = 3;

export function createLlm(cfg, log = () => {}) {
  const { apiKey, base, model, timeoutMs, maxTokens, temperature, mock, mockToolCall, mockLongReply, maxToolIterations } = cfg;

  /** 单次 Chat Completions 请求; 返回 { content, toolCalls|null, raw } */
  async function callOnce(messages, tools) {
    if (mock) {
      const last = [...messages].reverse().find((m) => m.role === 'user' || m.role === 'tool');
      const lastUserText = (last && last.content || '').toString().slice(0, 60);
      if (mockLongReply && lastUserText.includes('TESTLONG')) {
        return { content: 'LONGREPLY|' + '长'.repeat(480), toolCalls: null };
      }
      const toolCalled = messages.some((m) => m.role === 'tool');
      // mockToolCall 只在"带工具"的调用(agentTurn/agentRun)里触发, 测工具循环;
      // 纯 chat(定时/主动广播/压缩)不触发, 直接返回 mock 文本。
      if (mockToolCall && tools && !toolCalled) {
        return {
          content: null,
          toolCalls: [{ id: 'mock_call_1', type: 'function', function: { name: 'room_stats', arguments: '{}' } }],
        };
      }
      return { content: `[mock回复] 收到: ${lastUserText}`, toolCalls: null };
    }
    if (!apiKey) throw new Error('缺少 DEEPSEEK_API_KEY (可设 MOCK_LLM=1 离线自测)');
    return await req('/chat/completions', {
      model, messages, max_tokens: maxTokens, temperature,
      ...(tools && tools.length ? { tools, tool_choice: 'auto' } : {}),
      // 默认关掉 deepseek 的内部思考模式: 避免 reasoning_content 把 max_tokens 耗光, 留下空 content/tool_calls
      // (flash/推理变体常默认开, 关闭后模型直接产出最终回复, 单次 token 占用大幅下降)
      thinking: { type: 'disabled' },
    });
  }

  /** 单次 HTTP 请求, 网络瞬时错误重试一次 */
  async function req(path, body) {
    const doReq = async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const resp = await fetch(base + path, {
          method: 'POST',
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
          body: JSON.stringify(body),
        });
        if (!resp.ok) throw new Error('HTTP ' + resp.status + ' ' + (await resp.text()).slice(0, 120));
        const data = await resp.json();
        const choice = data.choices && data.choices[0];
        const msg = (choice && choice.message) || {};
        return {
          content: (msg.content || '').trim(),
          toolCalls: Array.isArray(msg.tool_calls) && msg.tool_calls.length ? msg.tool_calls : null,
          raw: msg,
        };
      } finally { clearTimeout(timer); }
    };
    try { return await doReq(); }
    catch (e) {
      log(`[LLM] 首次调用异常: ${e.message}, 重试一次`);
      return doReq();
    }
  }

  /** 单轮多轮对话 (不涉及工具); 空回复时丢弃历史只带当前消息重试一次 */
  async function chat(systemPrompt, history) {
    const baseMsgs = [{ role: 'system', content: systemPrompt }, ...history];
    let out;
    try { out = await callOnce(baseMsgs, null); }
    catch (e) { log(`[LLM] chat 首次调用异常: ${e.message}`); }
    if (!out || !out.content) {
      const lastUser = [...history].reverse().find((m) => m.role === 'user');
      log('[LLM] 空回复, 丢弃历史重试一次');
      out = await callOnce([{ role: 'system', content: systemPrompt }, ...(lastUser ? [lastUser] : [])], null);
    }
    if (!out || !out.content) throw new Error('空回复');
    return out.content;
  }

  /** 通用 agent 工具循环: 模型返回 tool_calls → dispatch → 回填, 直到给出最终文本。
   *  借鉴 opencode 多步调研:
   *    - 每次工具结果回填后, 在非最后轮注入 user 角色的 Reflect 提示, 让模型评估"够不够";
   *    - 同名同参连续 DOOM_LOOP_THRESHOLD 次触发兜底停止。 */
  async function runLoop({ systemPrompt, history, tools, maxIterations = maxToolIterations, think, from, depth }) {
    const msgs = [{ role: 'system', content: systemPrompt }, ...history];
    const schema = tools.openAiSchemas();
    const knownTools = new Set(tools.list());
    const recentFp = []; // Doom-loop 指纹缓冲: 每次循环记录一次完整 fingerprint
    let out;
    let reflectedOnce = false; // Reflect 提示本轮只推一次(在 tool 全部回填之后)

    /** 把模型的 tool_calls 逐个执行并回填 tool 消息; note 仅在 tool 块回填完成、未触发继续条件时推一次 */
    async function executeToolCalls(toolCalls, note) {
      msgs.push({ role: 'assistant', content: out && out.content ? out.content : null, tool_calls: toolCalls.map((t) => ({
        id: t.id, type: 'function', function: { name: t.function.name, arguments: t.function.arguments || '{}' },
      })) });
      for (const tc of toolCalls) {
        const name = tc.function && tc.function.name;
        let args = {};
        try { args = JSON.parse(tc.function.arguments || '{}'); } catch (e) {}
        let result;
        try { result = await tools.dispatch(name, args, { status: think, from, depth }); }
        catch (e) { result = { error: String(e.message || e) }; }
        log(`[TOOL] ${name}(${JSON.stringify(args).slice(0, 80)}) → ${JSON.stringify(result).slice(0, 200)}`);
        msgs.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
      }
      if (note) msgs.push({ role: 'user', content: note });
      reflectedOnce = !!note;
    }

    /** 同名同参指纹; 用于 doom-loop 守护 */
    function fpOf(toolCalls) {
      return toolCalls.map((t) => `${t.function.name}|${t.function.arguments || '{}'}`).join(',');
    }

    /** 模型把工具调用写成了文本(没走函数调用机制): 尝试恢复执行; 无法恢复则剥掉。返回 'executed'(已回填) 或 最终文本。 */
    async function recoverLeakedText(content) {
      const leaked = extractToolCallFromText(content, knownTools);
      if (!leaked) return content || '（无回复）';          // 正常文本
      if (leaked.calls && leaked.calls.length) {
        log(`[LLM] 检测到文本形式的工具调用(${leaked.calls.length}个), 恢复执行`);
        const narrative = stripLeakedToolCallText(content); // 剥掉工具块后剩下的说明文本
        if (narrative) msgs.push({ role: 'assistant', content: narrative });
        for (let k = 0; k < leaked.calls.length; k++) {
          const c = leaked.calls[k];
          let args = {};
          try { args = JSON.parse(c.arguments || '{}'); } catch {}
          let result;
          try { result = await tools.dispatch(c.name, args, { status: think, from, depth }); }
          catch (e) { result = { error: String(e.message || e) }; }
          log(`[TOOL-恢复] ${c.name}(${JSON.stringify(args).slice(0, 80)}) → ${JSON.stringify(result).slice(0, 200)}`);
          // 用合成 assistant(tool_calls) + tool 消息回填, 满足 OpenAI 兼容 API 的 tool_call_id 关联
          const callId = `leaked_${k}_${c.name}`;
          msgs.push({ role: 'assistant', content: null, tool_calls: [{
            id: callId, type: 'function', function: { name: c.name, arguments: JSON.stringify(args) },
          }] });
          msgs.push({ role: 'tool', tool_call_id: callId, content: JSON.stringify(result) });
        }
        return 'executed';
      }
      const cleaned = stripLeakedToolCallText(content);
      log('[LLM] 检测到被截断的工具调用文本, 已剥除');
      return cleaned || '（我这边工具输出有点问题，换个方式再试）';
    }

    for (let i = 0; i < maxIterations; i++) {
      reflectedOnce = false;
      try { out = await callOnce(msgs, schema); }
      catch (e) {
        log(`[LLM] 工具轮异常: ${e.message}`);
        think('稍微卡了一下, 让我再想想…');
        return '我这边有点卡, 稍后再试?';
      }
      // 空回复兜底 (继承原 bot 的 robustness): 丢弃历史, 只带当前用户消息重试一次
      if (!out.content && !out.toolCalls) {
        const lastUser = [...history].reverse().find((m) => m.role === 'user');
        log('[LLM] 空回复, 丢弃历史重试一次');
        try { out = await callOnce([{ role: 'system', content: systemPrompt }, ...(lastUser ? [lastUser] : [])], schema); }
        catch (e) { out = null; }
        if (!out || (!out.content && !out.toolCalls)) { think('有点卡, 让我再想想…'); return '这个我暂时答不上来，换个问题试试？'; }
      }
      if (!out.toolCalls) {
        const r = await recoverLeakedText(out.content);
        if (r !== 'executed') return r;
        // 文本泄漏路径也走 Reflect(若本轮还没注入)
        if (!reflectedOnce && i < maxIterations - 1) msgs.push({ role: 'user', content: REFLECT_PROMPT });
        reflectedOnce = true;
        continue;
      }

      // Doom-loop 守护
      const fp = fpOf(out.toolCalls);
      recentFp.push(fp);
      if (recentFp.length >= DOOM_LOOP_THRESHOLD && recentFp.slice(-DOOM_LOOP_THRESHOLD).every((x) => x === fp)) {
        think('我好像卡在重复上了, 换个思路');
        log(`[LLM] Doom-loop: ${fp} 连续 ${DOOM_LOOP_THRESHOLD} 次`);
        return '（陷入重复调用, 已停止; 请换种说法或拆简单一点）';
      }

      // 注入 Reflect: 留出最后一轮(i === maxIterations-1)不注, 让模型自由收尾
      // MOCK 模式默认不注, 避免污染 mock 自测的回复(Reflect 是真实 LLM 模式下的多步思考锚点)
      const note = (i < maxIterations - 1 && !cfg.mock) ? REFLECT_PROMPT : '';
      await executeToolCalls(out.toolCalls, note);
    }

    // 迭代超限: 保留工具 + 收尾提示, 再给最多 3 轮 —— 模型能真正调用工具收尾, 而不是被逼把工具写成文本
    msgs.push({ role: 'system', content: '工具调用次数已达上限。请基于已有信息直接给出最终回答。若信息确实不足, 如实告诉用户"没查到/获取失败", 给出已尝试的方向和可行的替代建议(如换官网、提供更精确的关键词), 不要再继续调用同类工具重试, 不要把工具调用写成文本。' });
    // 不再 think('信息够了…') 暴露内部迭代上限, 改写日志
    log('[LLM] runLoop 达到 maxIterations, 进入收尾阶段(最多 3 轮)');
    for (let j = 0; j < 3; j++) {
      try { out = await callOnce(msgs, schema); }
      catch (e) { out = null; }
      if (!out || (!out.content && !out.toolCalls)) break;
      if (out.toolCalls) { await executeToolCalls(out.toolCalls); continue; }
      const r = await recoverLeakedText(out.content);
      if (r !== 'executed') return r;
    }
    return '（这次没查到结果，可能要换个说法或稍后再试）';
  }

  /**
   * agent 回合 (主智能体, 兼容旧签名)。
   * @param {object} ctx {
   *   systemPrompt, history, tools(注册表视图), maxIterations?,
   *   onThinking(step)=>void, from?, depth?
   * }
   * @returns {string} 最终回答
   */
  async function agentTurn({ systemPrompt, history, tools, maxIterations = maxToolIterations, onThinking, from, depth = 0 }) {
    const think = onThinking || (() => {});
    think(START_HINT);
    return runLoop({ systemPrompt, history, tools, maxIterations, think, from, depth });
  }

  /**
   * 子智能体回合 (references: opencode task 工具)。
   * @param {object} ctx {
   *   agentName, systemPrompt, task, tools(子智能体视图), onThinking?,
   *   from?, depth?, maxIterations?
   * }
   * @returns {Promise<{ agent:string, result:string }>}
   */
  async function agentRun({ agentName = 'subtask', systemPrompt, task, tools, onThinking, from, depth = 1, maxIterations = 6 }) {
    const think = onThinking || (() => {});
    const history = [{ role: 'user', content: `任务: ${String(task || '')}` }];
    const result = await runLoop({ systemPrompt, history, tools, maxIterations, think, from, depth });
    return { agent: agentName, result };
  }

  return { chat, agentTurn, agentRun, callOnce };
}