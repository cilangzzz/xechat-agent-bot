// agent 工具 —— skill_install_from_url / skill_uninstall
// 协议: 仓库根 URL 提供 index.json, 每项含 {name, files}; SKILL.md 从 {base}/{name}/SKILL.md 抓
import path from 'node:path';
import fs from 'node:fs/promises';
import { defineTool } from '../../foundation/tool-core.mjs';
import { fetchSkillManifest } from '../skill-fetcher.mjs';

export function buildSkillInstallTools(ctx) {
  return [
    defineTool({
      id: 'skill_install_from_url',
      description: `从远程仓库 URL 安装技能。仓库根须提供 index.json:
  { "skills": [{ "name": "...", "description": "...", "version": "1.0.0", "files": ["SKILL.md", "..."] }] }
每个 skill 的 SKILL.md 从 {base}/{name}/SKILL.md 抓取, 落地到 agent/data/skills/{name}/SKILL.md 后注册。
常用仓库: H:\\Documents\\software-dev-ai-workflow\\0.0-通用skill\\ (本地路径可走 skill_install_from_path 或 SKILLS_PATHS)。`,
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '仓库根 URL, 例如 https://example.com/.well-known/skills/' },
          name: { type: 'string', description: '可选, 只安装指定名字; 缺省则按 index.json 装全部' },
        },
        required: ['url'],
      },
      budget: 30000, // 多个 SKILL.md 抓取, 一次最多装几十个
      run: async ({ url, name }) => {
        if (!ctx.skills?.enabled) return { error: '技能包未开启(DISABLE_SKILLS=1)' };
        if (!url) return { error: '需要 url 参数' };
        const dataDir = ctx.skills.dataDir || path.join(process.cwd(), 'data', 'skills');
        try {
          await fs.mkdir(dataDir, { recursive: true });
        } catch (e) { /* 已存在 */ }
        // httpGet: 优先用 ctx.web.enabled 时的 httpGet, 否则用全局 fetch
        const httpGet = async (u) => {
          if (ctx.web?.enabled) {
            const { httpGet: hg } = await import('../../platform/web.mjs');
            const r = await hg(u, { proxy: ctx.proxy, timeoutMs: ctx.web?.timeoutMs || 15000 });
            if (r.status < 0) throw new Error(r.error || 'http fail');
            return r.text;
          }
          const r = await globalThis.fetch(u, { signal: AbortSignal.timeout(15000) });
          if (!r.ok) throw new Error(`HTTP ${r.status} ${u}`);
          return await r.text();
        };
        try {
          const { manifest, fetchFile } = await fetchSkillManifest(String(url).trim(), { httpGet, log: (m) => ctx.log?.(m) });
          let entries = manifest.skills || [];
          if (name) entries = entries.filter((e) => e && e.name === name);
          const installed = [];
          for (const entry of entries) {
            if (!entry || !entry.name || !Array.isArray(entry.files)) continue;
            const mdFile = entry.files.find((f) => /SKILL\.md$/i.test(f)) || 'SKILL.md';
            try {
              const raw = await fetchFile(`${encodeURIComponent(entry.name)}/${mdFile}`);
              // 落地到 dataDir
              const dir = path.join(dataDir, entry.name);
              await fs.mkdir(dir, { recursive: true });
              await fs.writeFile(path.join(dir, 'SKILL.md'), raw, 'utf8');
              installed.push(entry.name);
            } catch (e) {
              // 单个失败不影响其它
            }
          }
          // 重新发现
          const reg = ctx.skills.registry;
          if (reg) await reg.reload();
          return { installed, count: installed.length, url, dataDir };
        } catch (e) {
          return { error: '安装失败: ' + (e.message || e) };
        }
      },
    }),

    defineTool({
      id: 'skill_uninstall',
      description: '卸载一个用户安装的 skill(只删本地缓存, 不删 builtin)。',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: '要卸载的 skill 名' } },
        required: ['name'],
      },
      budget: 4000,
      run: async ({ name }) => {
        const reg = ctx.skills?.registry;
        if (!reg) return { error: '技能注册表未初始化' };
        const info = reg.get(String(name || '').trim());
        if (!info) return { error: `未知技能「${name}」` };
        if (info.source === 'builtin') return { error: '不能卸载内置技能' };
        try {
          // info.location 是 SKILL.md 文件路径, 取父目录删
          const dir = path.dirname(info.location);
          await fs.rm(dir, { recursive: true, force: true });
        } catch (e) { return { error: '卸载失败: ' + (e.message || e) }; }
        await reg.reload();
        return { uninstalled: name };
      },
    }),
  ];
}