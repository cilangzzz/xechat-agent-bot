// agent —— 技能注册表 (SkillRegistry)
// 多源合并: builtin (代码内置) → user_dir (本地 data/skills/) → user_url (远程仓库)
// 设计参考 opencode skill/index.ts:discoverSkills + loadSkills
//
// 数据源优先级: 后注册的同名 skill 覆盖先注册的 (opencode 行为一致)。
// 设计目标:
//   - 一次 init (启动时), 之后纯内存查询 (LLM 调用零 I/O)
//   - reload() 用于 skill_install_from_url 后重新发现
//   - 内置 skills 来自现有 lib/business/skills.mjs 的 SKILLS 常量
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseSkillMd, isValidSkillFrontmatter } from './skill-frontmatter.mjs';

/**
 * @typedef {Object} SkillInfo
 * @property {string} name
 * @property {string} description
 * @property {string} content         - SKILL.md body (frontmatter 之后)
 * @property {string} location       - 绝对路径或 '<builtin>'
 * @property {'builtin'|'user_dir'|'user_url'} source
 * @property {string} [url]          - 仅 user_url 有值
 */

export class SkillRegistry {
  /**
   * @param {object} opts
   * @param {Map<string, SkillInfo>} [opts.builtinSkills] 内置 skills (name → info)
   * @param {string} [opts.dataDir]    用户本地 skills 目录 (默认 agent/data/skills)
   * @param {string[]} [opts.remoteUrls] 远程仓库 URL 列表 (从配置 / 工具调用传入)
   * @param {object} [opts.fs]         文件系统 (测试可注入)
   * @param {object} [opts.fetcher]    远程 fetcher, 签名: (url) => Promise<{manifest, fetchFile}>; 不传则跳过 user_url
   */
  constructor({ builtinSkills = new Map(), dataDir, remoteUrls = [], fs: fsMod = fs, fetcher = null } = {}) {
    this._builtin = builtinSkills;
    this._dataDir = dataDir;
    this._remoteUrls = remoteUrls;
    this._fs = fsMod;
    this._fetcher = fetcher;
    /** @type {Map<string, SkillInfo>} */
    this._all = new Map();
    this._loaded = false;
  }

  /** 扫描所有源,合并到 _all */
  async init() {
    this._all.clear();
    // 1) builtin 优先加载(在底层)
    for (const [name, info] of this._builtin) {
      this._all.set(name, { ...info, source: 'builtin' });
    }
    // 2) user_dir 覆盖 builtin
    if (this._dataDir) {
      await this._loadDir(this._dataDir, 'user_dir');
    }
    // 3) user_url 最后覆盖(可远程更新 builtin / user_dir)
    for (const url of this._remoteUrls) {
      if (!this._fetcher) continue;
      try {
        await this._loadFromUrl(url);
      } catch (e) {
        // 容错: 单个远程仓库失败不影响其他
        // (opencode 行为: 静默 + log)
      }
    }
    this._loaded = true;
  }

  /** 重新扫描本地 + 远程 (skill_install_from_url 后用) */
  async reload() {
    return this.init();
  }

  async _loadDir(dir, source) {
    let entries;
    try { entries = await this._fs.readdir(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      // 也支持 SKILL.md 直接放在 dir 下(单层布局)
      const skillDir = path.join(dir, ent.name);
      const mdPath = path.join(skillDir, 'SKILL.md');
      const flatPath = path.join(dir, 'SKILL.md');
      let skillPath = null;
      try {
        await this._fs.access(mdPath);
        skillPath = mdPath;
      } catch (e) {
        try { await this._fs.access(flatPath); skillPath = flatPath; } catch (e2) { continue; }
      }
      const info = await this._readSkillFile(skillPath, source);
      if (info) this._all.set(info.name, info);
    }
  }

  async _readSkillFile(filePath, source) {
    const raw = await this._fs.readFile(filePath, 'utf8');
    const { frontmatter, content } = parseSkillMd(raw);
    if (!isValidSkillFrontmatter(frontmatter)) return null;
    return {
      name: frontmatter.name.trim(),
      description: frontmatter.description.trim(),
      content,
      location: filePath,
      source,
    };
  }

  async _loadFromUrl(url) {
    const result = await this._fetcher(url);
    const { manifest, fetchFile } = result;
    if (!manifest || !Array.isArray(manifest.skills)) return;
    for (const entry of manifest.skills) {
      if (!entry || !entry.name || !Array.isArray(entry.files)) continue;
      // 找到 entry.files 里的 SKILL.md
      const mdFile = entry.files.find((f) => /SKILL\.md$/i.test(f)) || 'SKILL.md';
      try {
        const raw = await fetchFile(`${url.replace(/\/$/, '')}/${encodeURIComponent(entry.name)}/${mdFile}`);
        const { frontmatter, content } = parseSkillMd(raw);
        if (!isValidSkillFrontmatter(frontmatter)) continue;
        // 持久化到 dataDir
        const skillDir = path.join(this._dataDir || '.', entry.name);
        try {
          await this._fs.mkdir(skillDir, { recursive: true });
          await this._fs.writeFile(path.join(skillDir, 'SKILL.md'), raw, 'utf8');
        } catch (e) { /* 写盘失败也不影响内存注册 */ }
        this._all.set(frontmatter.name.trim(), {
          name: frontmatter.name.trim(),
          description: frontmatter.description.trim(),
          content,
          location: path.join(skillDir, 'SKILL.md'),
          source: 'user_url',
          url,
        });
      } catch (e) { /* 单个 skill 失败不影响 */ }
    }
  }

  /** 查一个 skill */
  get(name) { return this._all.get(name); }

  /** 必须存在否则抛错 */
  require(name) {
    const s = this._all.get(name);
    if (!s) throw new Error(`未知 skill: ${name}`);
    return s;
  }

  /** 所有 skill 列表 */
  all() { return [...this._all.values()]; }

  /** 按名称列表 */
  names() { return [...this._all.keys()]; }
}