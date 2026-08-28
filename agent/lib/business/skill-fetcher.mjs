// agent —— 远程 skill 仓库 fetcher
// 协议: 仓库根 URL 需提供 index.json, 格式:
//   { "skills": [{ "name": "...", "description": "...", "version": "1.0.0", "files": ["SKILL.md", "references/foo.md"] }] }
// 每个 skill 的 SKILL.md 从 `{base}/{name}/SKILL.md` 抓取。
// 设计参考 opencode skill/discovery.ts:Discovery.pull

/**
 * @param {string} base 仓库根 URL (例如 https://example.com/.well-known/skills/)
 * @param {object} opts
 * @param {(url: string) => Promise<string>} [opts.httpGet] GET 纯文本的 fetcher; 不传则用 globalThis.fetch
 * @param {object} [opts.log] log 函数
 */
export async function fetchSkillManifest(base, { httpGet, log = () => {} } = {}) {
  const getter = httpGet || ((u) => globalThis.fetch(u).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status} ${u}`);
    return r.text();
  }));
  const baseNorm = base.replace(/\/$/, '');
  const idxUrl = `${baseNorm}/index.json`;
  log(`[skill-fetcher] GET ${idxUrl}`);
  const txt = await getter(idxUrl);
  let data;
  try { data = JSON.parse(txt); } catch (e) { throw new Error(`index.json 不是合法 JSON: ${e.message}`); }
  if (!data || !Array.isArray(data.skills)) {
    throw new Error('index.json 缺少 skills 数组');
  }
  // 返回 manifest + fetchFile 闭包
  return {
    manifest: data,
    fetchFile: async (relPath) => {
      const url = `${baseNorm}/${relPath.replace(/^\//, '')}`;
      log(`[skill-fetcher] GET ${url}`);
      return await getter(url);
    },
  };
}

/**
 * 给 SkillRegistry 用的高阶 fetcher: 输入 URL, 输出 {manifest, fetchFile}
 * @param {string} url
 * @param {object} [opts]
 * @param {(url: string) => Promise<string>} [opts.httpGet]
 * @param {object} [opts.log]
 */
export async function buildRegistryFetcher(url, opts) {
  return await fetchSkillManifest(url, opts);
}