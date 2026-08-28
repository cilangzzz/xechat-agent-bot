// agent 工具 —— skill_list: 列出所有可用 skill (builtin + 用户 + 远程)
import { defineTool } from '../../foundation/tool-core.mjs';

export function buildSkillListTools(ctx) {
  return [
    defineTool({
      id: 'skill_list',
      description: '列出所有可用技能包(builtin + 用户本地 + 远程仓库), 返回 name + 一句描述。LLM 据此判断该加载哪个 skill。',
      parameters: {
        type: 'object',
        properties: {
          verbose: { type: 'boolean', description: '是否带 location/source 详情, 默认 false' },
        },
      },
      budget: 4000,
      run: async ({ verbose } = {}) => {
        const reg = ctx.skills?.registry;
        if (!reg) return { error: '技能注册表未初始化(检查 ctx.skills.registry)' };
        const all = reg.all();
        return {
          count: all.length,
          skills: all.map((s) => ({
            name: s.name,
            description: s.description,
            ...(verbose ? { location: s.location, source: s.source } : {}),
          })),
        };
      },
    }),
  ];
}