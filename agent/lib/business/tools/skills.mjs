// agent 工具 —— 技能包 (references: opencode skill)
// 依赖 ../skills.mjs (SKILLS / getSkill / listSkills)
// 依赖 ctx.skills.enabled
import { defineTool } from '../../foundation/tool-core.mjs';
import * as skillsMod from '../skills.mjs';

export function buildSkillsTools(ctx) {
  return [
    defineTool({
      id: 'skill',
      description: `加载一个技能包(${Object.keys(skillsMod.SKILLS).join('/')}), 之后按该技能的工作流执行。`,
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', enum: Object.keys(skillsMod.SKILLS), description: '技能名' } },
        required: ['name'],
      },
      run: async ({ name }) => {
        if (!ctx.skills?.enabled) return { error: '技能包未开启(DISABLE_SKILLS=1 会关闭)' };
        const s = skillsMod.getSkill(name);
        if (!s) return { error: `未知技能「${name}」, 可用: ${skillsMod.listSkills().join('、')}` };
        return { loaded: s.name, instruction: s.instructions };
      },
    }),
  ];
}