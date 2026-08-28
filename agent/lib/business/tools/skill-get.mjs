// agent 工具 —— skill_get: 加载某个 skill 的完整指令到上下文 (替代旧 skill 工具)
// name 是字符串(不是 enum), 支持 builtin/user_dir/user_url 三类
import { defineTool } from '../../foundation/tool-core.mjs';

export function buildSkillGetTools(ctx) {
  return [
    defineTool({
      id: 'skill_get',
      description: `加载一个技能包到上下文, 之后按该技能的工作流执行。name 从 skill_list 取。
返回: {loaded, description, instruction, location, source}`,
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '技能名, 完整字符串 (无枚举, 用 skill_list 看可用列表)' },
        },
        required: ['name'],
      },
      budget: 12000, // 整个 SKILL.md body 可能上千字
      run: async ({ name }) => {
        if (!ctx.skills?.enabled) return { error: '技能包未开启(DISABLE_SKILLS=1)' };
        const reg = ctx.skills?.registry;
        if (!reg) return { error: '技能注册表未初始化' };
        const info = reg.get(String(name || '').trim());
        if (!info) {
          const known = reg.all().map((s) => s.name).join('、');
          return { error: `未知技能「${name}」, 可用: ${known || '(空)'}` };
        }
        // content 按配置上限截断
        const max = ctx.skills.maxContentChars || 8000;
        const truncated = info.content.length > max;
        return {
          loaded: info.name,
          description: info.description,
          instruction: truncated ? info.content.slice(0, max) + '\n...[truncated]' : info.content,
          location: info.location,
          source: info.source,
          truncated,
        };
      },
    }),
  ];
}