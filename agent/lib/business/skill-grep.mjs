// agent —— Skill 内容搜索 (grep 工具后端)
// 设计参考 opencode tool/grep.ts + core/ripgrep.ts:grep
//
// 优先用 ripgrep (`rg`) 二进制: 速度快、支持正则/glob/二进制跳过。
// 没有 ripgrep 时回退到 Node fs.readFileSync + 正则 (慢但零依赖)。
//
// 输出裁剪 (防止上下文爆炸):
//   - 默认 100 条命中上限
//   - 每行 2KB 截断 (超长 base64 行也不爆)
//   - 单次结果总字节上限 16KB (再多就标 truncated)
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_LIMIT = 100;
const MAX_LINE_BYTES = 2048;
const MAX_OUTPUT_BYTES = 16 * 1024;

/**
 * 在 skill 目录里搜正则
 * @param {object} opts
 * @param {string} opts.pattern   正则表达式字符串
 * @param {string} [opts.cwd]      搜索根目录 (默认 process.cwd())
 * @param {string} [opts.path]     子目录 / 单文件相对路径 (相对 cwd)
 * @param {string} [opts.include]  glob 过滤, 例如 "*.md"
 * @param {number} [opts.limit]    最大命中数
 * @param {object} [opts.signal]   AbortSignal
 * @returns {Promise<{matches: Array<{path:string,line:number,text:string}>, total: number, truncated: boolean, backend: 'rg'|'node'}>}
 */
export async function grepSkills({
  pattern,
  cwd,
  path: relPath = '',
  include,
  limit = DEFAULT_LIMIT,
  signal,
} = {}) {
  if (!pattern) throw new Error('grepSkills 需要 pattern');
  const root = cwd || process.cwd();
  const target = relPath ? path.join(root, relPath) : root;
  // 优先用 rg
  if (await hasRg()) return await grepViaRg({ pattern, target, include, limit, signal, root });
  // fallback: Node 同步读
  return await grepViaNode({ pattern, target, include, limit, root });
}

async function hasRg() {
  try {
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync('rg', ['--version'], { stdio: 'ignore' });
    return r.status === 0;
  } catch (e) { return false; }
}

function ripgrepArgs(pattern, target, include) {
  const args = [
    '--no-config',
    '--no-heading',
    '--line-number',
    '--color=never',
    '--hidden',
    '--no-messages',
    '--no-binary',
    '-g', '!**/.git/**',
  ];
  if (include) args.push('-g', include);
  args.push('--', pattern);
  args.push(target);
  return args;
}

async function grepViaRg({ pattern, target, include, limit, signal, root }) {
  const args = ripgrepArgs(pattern, target, include);
  return new Promise((resolve) => {
    const child = spawn('rg', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    const outChunks = [];
    let outBytes = 0;
    let truncated = false;
    child.stdout.on('data', (c) => {
      if (truncated) return;
      outBytes += c.length;
      if (outBytes > MAX_OUTPUT_BYTES) {
        truncated = true;
        child.kill();
        return;
      }
      outChunks.push(c);
    });
    child.on('close', () => {
      const raw = Buffer.concat(outChunks).toString('utf8');
      const matches = parseRgOutput(raw, root, limit);
      resolve({
        matches,
        total: matches.length,
        truncated,
        backend: 'rg',
      });
    });
    child.on('error', () => {
      // rg 二进制突然不可用, 回退到 Node
      grepViaNode({ pattern, target, include, limit, root }).then(resolve);
    });
    if (signal) {
      const onAbort = () => child.kill();
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

function parseRgOutput(raw, root, limit) {
  const out = [];
  let total = 0;
  for (const line of raw.split('\n')) {
    if (!line) continue;
    // rg 格式: path:lineno:content
    const m = line.match(/^(.+?):(\d+):(.*)$/);
    if (!m) continue;
    total++;
    if (out.length >= limit) continue;
    const [, file, lineno, text] = m;
    const absPath = path.isAbsolute(file) ? file : path.resolve(root, file);
    const truncatedText = text.length > MAX_LINE_BYTES
      ? text.slice(0, MAX_LINE_BYTES) + '…[truncated]'
      : text;
    out.push({ path: absPath, line: Number(lineno), text: truncatedText });
  }
  return out;
}

async function grepViaNode({ pattern, target, include, limit, root }) {
  let regex;
  try { regex = new RegExp(pattern, 'm'); }
  catch (e) { throw new Error(`无效正则: ${e.message}`); }
  const globRe = include ? globToRegExp(include) : null;
  const matchesGlob = (rel) => {
    if (!globRe) return true;
    const norm = rel.replace(/\\/g, '/');
    if (globRe.test(norm)) return true;
    // basename 也要匹配: *.md 能命中 local-skill/SKILL.md
    const base = norm.split('/').pop();
    return globRe.test(base);
  };
  const matches = [];
  let total = 0;
  let truncated = false;
  let bytes = 0;

  async function walk(dir) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const ent of entries) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === '.git') continue;
        await walk(p);
      } else if (ent.isFile()) {
        const rel = path.relative(root, p);
        if (globRe && !matchesGlob(rel)) continue;
        let content;
        try { content = await fs.readFile(p, 'utf8'); } catch (e) { continue; }
        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (!regex.test(lines[i])) continue;
          total++;
          if (matches.length >= limit || truncated) continue;
          bytes += lines[i].length;
          if (bytes > MAX_OUTPUT_BYTES) { truncated = true; continue; }
          const truncatedText = lines[i].length > MAX_LINE_BYTES
            ? lines[i].slice(0, MAX_LINE_BYTES) + '…[truncated]'
            : lines[i];
          matches.push({ path: p, line: i + 1, text: truncatedText });
        }
      }
    }
  }

  // target 是文件还是目录
  try {
    const st = await fs.stat(target);
    if (st.isFile()) {
      const rel = path.relative(root, target);
      if (!globRe || matchesGlob(rel)) {
        const content = await fs.readFile(target, 'utf8');
        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (!regex.test(lines[i])) continue;
          total++;
          if (matches.length >= limit || truncated) continue;
          bytes += lines[i].length;
          if (bytes > MAX_OUTPUT_BYTES) { truncated = true; continue; }
          const truncatedText = lines[i].length > MAX_LINE_BYTES
            ? lines[i].slice(0, MAX_LINE_BYTES) + '…[truncated]'
            : lines[i];
          matches.push({ path: target, line: i + 1, text: truncatedText });
        }
      }
    } else {
      await walk(target);
    }
  } catch (e) { /* target 不存在 */ }

  return { matches, total, truncated, backend: 'node' };
}

// 把 glob (例如 *.md 或 **/*.md) 转成正则, 不引依赖; 对 basename 也匹配一次 (让 *.md 能命中子目录的 SKILL.md)

function globToRegExp(glob) {
  let re = '^';
  for (const c of glob) {
    if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if ('.+^$|()[]{}\\'.includes(c)) re += '\\' + c;
    else re += c;
  }
  re += '$';
  return new RegExp(re);
}