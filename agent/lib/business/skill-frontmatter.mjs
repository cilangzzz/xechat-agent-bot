// agent —— SKILL.md 极简 frontmatter 解析器 (无外部依赖)
// 支持标准 SKILL.md frontmatter (--- yaml ---) + 没有 frontmatter 的纯文本。
// 设计参考 opencode skill frontmatter 规范 (name/description 必填), 但保持极简:
//   - 不依赖 gray-matter
//   - 兼容单行 key: value (无完整 YAML 解析)
//   - value 自动去除首尾引号
//   - 缺省 frontmatter 时视为空 frontmatter + 全文为 content
export function parseSkillMd(text) {
  const s = String(text || '');
  // 仅匹配文档开头的 frontmatter (^---\n 到 \n---\n)
  const m = s.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/);
  if (!m) return { frontmatter: {}, content: s, hasFrontmatter: false };
  const [, fmRaw, content] = m;
  const frontmatter = {};
  for (const line of fmRaw.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue; // 空行/注释跳过
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    let val = line.slice(colon + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key) frontmatter[key] = val;
  }
  return { frontmatter, content, hasFrontmatter: true };
}

/** 验证 frontmatter 是否满足 SKILL.md 最低要求 (name + description) */
export function isValidSkillFrontmatter(fm) {
  return !!(fm && typeof fm.name === 'string' && fm.name.trim() && typeof fm.description === 'string' && fm.description.trim());
}