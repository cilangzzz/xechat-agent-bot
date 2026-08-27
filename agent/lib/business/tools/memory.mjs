// agent 工具 —— 持久记忆 (受 ENABLE_MEMORY 门控)
// 依赖 ctx.memory (lib/business/memory.mjs)
import { defineTool } from '../../foundation/tool-core.mjs';

export function buildMemoryTools(ctx) {
  return [
    defineTool({
      id: 'remember',
      description: '记下一条用户的关键事实(如昵称/偏好/约定), 之后可 recall 查询。',
      parameters: {
        type: 'object',
        properties: { fact: { type: 'string', description: '要记住的事实, 陈述句' } },
        required: ['fact'],
      },
      run: async ({ fact }, extra) => {
        const mem = ctx.memory;
        if (!mem || !mem.enabled) return { error: '记忆功能未开启(管理员设 ENABLE_MEMORY=1)' };
        const from = extra.from;
        if (!from) return { error: '不知道是谁的事实' };
        const r = mem.remember(from, fact);
        return r ? { ok: true, stored: r.value } : { error: '事实为空' };
      },
    }),
    defineTool({
      id: 'recall',
      description: '查询已记住的该用户事实(可按关键字过滤), 回应个性化问题时用。',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: '可选关键字, 模糊匹配' } },
      },
      run: async ({ query } = {}, extra) => {
        const mem = ctx.memory;
        if (!mem || !mem.enabled) return { error: '记忆功能未开启(管理员设 ENABLE_MEMORY=1)' };
        const from = extra.from;
        if (!from) return { facts: [] };
        return { facts: mem.search(from, query) };
      },
    }),
  ];
}