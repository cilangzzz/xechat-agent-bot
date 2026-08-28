// agent 工具 —— skill_search: 在 skill 目录里搜正则 (grep 工具后端)
// 优先 ripgrep, 回退 Node fs; 输出裁剪防爆
import path from 'node:path';
import { defineTool } from '../../foundation/tool-core.mjs';
import { grepSkills } from '../skill-grep.mjs';

export function buildSkillSearchTools(ctx) {
  return [
    defineTool({
      id: 'skill_search',
      description: `在已安装/内置的 skill 内容里搜索关键词(ripgrep 风格正则), 返回 命中文件:行号:截断文本。
让 LLM 在不加载整个 SKILL.md 的情况下, 找到最相关的 skill / 段落。
优先 ripgrep, 无 rg 则 Node fs (较慢但零依赖)。
**默认搜索根**: ${ctx.skills?.dataDir || 'agent/data/skills/'} (含 builtin/user_dir/user_url)。
可指定 path 子目录 / include glob 缩小范围。`,
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: '正则表达式, 例如 "routing|router|agent"' },
          path: { type: 'string', description: '可选, 子目录或单文件路径(相对 dataDir)' },
          include: { type: 'string', description: '可选, 文件 glob 过滤, 例如 "*.md"' },
        },
        required: ['pattern'],
      },
      budget: 8000,
      run: async ({ pattern, path: relPath, include }) => {
        if (!ctx.skills?.enabled) return { error: '技能包未开启(DISABLE_SKILLS=1)' };
        if (!pattern) return { error: '需要 pattern 参数' };
        const dataDir = ctx.skills?.dataDir || path.join(process.cwd(), 'data', 'skills');
        const limit = ctx.skills?.grepLimit || 100;
        const timeoutMs = ctx.skills?.grepTimeoutMs || 5000;
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), timeoutMs);
        try {
          const r = await grepSkills({
            pattern: String(pattern),
            cwd: dataDir,
            path: relPath || '',
            include: include || undefined,
            limit,
            signal: ac.signal,
          });
          // 简化路径: 相对 dataDir
          const matches = r.matches.map((m) => ({
            path: m.path,
            relPath: path.isAbsolute(m.path) ? path.relative(dataDir, m.path) : m.path,
            line: m.line,
            text: m.text,
          }));
          return {
            count: matches.length,
            total: r.total,
            truncated: r.truncated,
            backend: r.backend,
            matches,
          };
        } catch (e) {
          return { error: '搜索失败: ' + (e.message || e) };
        } finally {
          clearTimeout(timer);
        }
      },
    }),
  ];
}