// 鱼塘 agent 智能体 —— 子智能体委托通道 (subagent delegation)
// 把 router.mjs 里的 _runSubdirect + _delegateSub 抽出来: 子智能体独立系统提示词 +
// 工具白名单 + 独立历史(参考 opencode explore/math 子代理设计)。
// 类持有 router 引用, 走 router.llm.agentRun()。
import { getAgent, buildAgentSystemPrompt } from './agents.mjs';

export class SubagentDelegate {
  /** @param {import('./router.mjs').Router} router Router 实例, 提供 cfg/llm/pondState/sessions/_agentView 等 */
  constructor(router) {
    this.r = router;
  }

  /** 显式调用子智能体并返回结果文本 (用于 explore/math 指令) */
  async _runSubdirect(agentName, task, from) {
    if (!task) return `用法: /${this.r.cfg.cmdPrefix} ${agentName} <${agentName === 'math' ? '算式' : '问题'}>`;
    const r = await this._delegateSub({ agent: agentName, task, from, status: this.r._lastThink });
    return r.error ? `子智能体「${agentName}」失败: ${r.error}` : r.result;
  }

  /** 子智能体执行通道: 独立系统提示词 + 工具白名单 + 独立历史 */
  async _delegateSub({ agent, task, from, depth = 1, status }) {
    const def = getAgent(agent);
    if (!def || def.mode !== 'subagent') return { error: `未知子智能体: ${agent}` };
    if (!this.r.llm || typeof this.r.llm.agentRun !== 'function') return { error: '子智能体通道未就绪' };
    const view = this.r._agentView(agent);
    const systemPrompt = buildAgentSystemPrompt({
      agent: def,
      cfg: this.r.cfg,
      pondState: this.r.pondState,
      sessions: this.r.sessions,
      toolList: view.describe().split('\n'),
    });
    const think = status || this.r._lastThink || (() => {});
    try {
      const out = await this.r.llm.agentRun({
        agentName: agent,
        systemPrompt,
        task,
        tools: view,
        onThinking: think,
        from,
        depth,
        maxIterations: def.maxIterations || this.r.cfg.agents.subagentIterations,
      });
      return { result: (out && out.result) || '(无输出)' };
    } catch (e) {
      return { error: String((e && e.message) || e) };
    }
  }
}