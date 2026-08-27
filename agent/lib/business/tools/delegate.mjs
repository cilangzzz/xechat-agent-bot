// agent 工具 —— 子代理委托 (references: opencode task 工具)
// 依赖 ctx.delegate / ctx.subagentDepth
import { defineTool } from '../../foundation/tool-core.mjs';

export function buildDelegateTools(ctx) {
  return [
    defineTool({
      id: 'delegate',
      description: '把一项任务委派给专业子智能体并取回结论: explore=联网/平台调研专家, math=计算专家(python)。适合自己不想做多步长链的情况。',
      parameters: {
        type: 'object',
        properties: {
          agent: { type: 'string', enum: ['explore', 'math'], description: '子智能体类型: explore(调研)或 math(计算)' },
          task: { type: 'string', description: '交给子智能体的具体任务描述(中文, 写清要什么结论)' },
        },
        required: ['agent', 'task'],
      },
      budget: 8000,
      run: async ({ agent, task }, extra) => {
        if (typeof ctx.delegate !== 'function') return { error: '子智能体通道未就绪' };
        const depth = extra.depth ?? 0;
        if (depth >= (ctx.subagentDepth ?? 1)) {
          return { error: `子智能体嵌套已达上限(${ctx.subagentDepth ?? 1} 层), 请直接在当前层完成` };
        }
        if (ctx.status) ctx.status(`把任务交给子智能体「${agent}」…`);
        const out = await ctx.delegate({ agent, task, from: extra.from, depth: depth + 1, status: extra.status });
        if (out.error) return { error: `子智能体「${agent}」失败: ${out.error}` };
        return `<task state="completed">\n${out.result || '(无输出)'}\n</task>`;
      },
    }),
  ];
}