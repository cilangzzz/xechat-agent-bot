# lib/business/skill-{fetcher,frontmatter,registry,grep}.mjs — Skill 管理系统 (opencode 风格)

> 4 个模块组成, 2026-08-28 (commit `d474b50`) 一次性引入, 参考 [opencode skill/discovery.ts](https://github.com/sst/opencode) 实现的多源 skill 发现 + 注册 + 检索系统。

| 文件 | 行数 | 职责 |
|---|---|---|
| [skill-fetcher.mjs](../../../agent/lib/business/skill-fetcher.mjs) | 47 | 远程仓库协议 (`index.json`) + 文件抓取 |
| [skill-frontmatter.mjs](../../../agent/lib/business/skill-frontmatter.mjs) | 32 | SKILL.md frontmatter 解析 + 校验 |
| [skill-registry.mjs](../../../agent/lib/business/skill-registry.mjs) | 152 | 多源合并: builtin + user_dir + user_url |
| [skill-grep.mjs](../../../agent/lib/business/skill-grep.mjs) | 217 | skill 内容搜索 (ripgrep + Node 回退) |

## 1. 设计目标

- **一次 init 零 I/O**: 启动时全量发现, 之后纯内存查询 (LLM 工具调用不阻塞 I/O)
- **多源合并**: builtin (内置) → user_dir (本地 data/skills/) → user_url (远程仓库), 后注册覆盖前注册
- **reload() 机制**: `skill_install_from_url` 后调 `reload()` 重新发现
- **零外部依赖**: frontmatter 自实现 (不引 gray-matter); ripgrep 可选, 回退 Node fs

## 2. 数据模型 `SkillInfo`

```js
/** @typedef {Object} SkillInfo
 *  @property {string} name
 *  @property {string} description
 *  @property {string} content         - SKILL.md body (frontmatter 之后)
 *  @property {string} location       - 绝对路径或 '<builtin>'
 *  @property {'builtin'|'user_dir'|'user_url'} source
 *  @property {string} [url]          - 仅 user_url 有值
 */
```

## 3. SKILL.md frontmatter 规范

### 3.1 格式

```markdown
---
name: skill-name
description: 一句话描述
version: 1.0.0
---

# 这里是正文内容

正文继续...
```

- 仅识别 `name` + `description` 两个**必填**字段; 其他 (version / allowed-tools 等) **可选但被忽略**
- value 自动去首尾引号 (`"value"` / `'value'` → `value`)
- 缺省 frontmatter → 视为空 frontmatter + 全文为 content

### 3.2 `parseSkillMd(text)`

```js
parseSkillMd(text) → { frontmatter, content, hasFrontmatter }
```

- 正则匹配文档开头的 `^---\n...\n---\n` (开头的 `---` 必须真在文档首行)
- 逐行解析 `key: value`, 跳过空行和 `#` 注释

### 3.3 `isValidSkillFrontmatter(fm)`

```js
isValidSkillFrontmatter(fm) → boolean
```

校验 `name` + `description` 都非空字符串。**任意一个缺失则该 skill 不会注册**。

## 4. 远程仓库协议 (skill-fetcher)

### 4.1 协议 URL 结构

```
{base}/index.json                 ← 仓库清单
{base}/{skill-name}/SKILL.md      ← 每个 skill 文档
{base}/{skill-name}/references/... ← 可选附件
```

### 4.2 index.json 格式

```json
{
  "skills": [
    {
      "name": "my-skill",
      "description": "...",
      "version": "1.0.0",
      "files": ["SKILL.md", "references/foo.md"]
    }
  ]
}
```

- `name` / `description` 必填
- `files` 必须包含 `SKILL.md` (大小写不敏感); 找不到则默认按 `SKILL.md` 抓

### 4.3 `fetchSkillManifest(base, opts)`

```js
const { manifest, fetchFile } = await fetchSkillManifest('https://example.com/.well-known/skills/');
// fetchFile('my-skill/SKILL.md') → Promise<string>
```

- 默认用 `globalThis.fetch` (Node 18+); 可注入 `httpGet`
- URL 末尾斜杠自动归一 (`base.replace(/\/$/, '')`)
- 失败抛错: `HTTP {status}` / `index.json 不是合法 JSON` / `缺少 skills 数组`

### 4.4 `buildRegistryFetcher(url, opts)`

高阶封装, 给 `SkillRegistry` 用。实际就是 `fetchSkillManifest(url, opts)`。

## 5. SkillRegistry (skill-registry)

详细 API / 合并优先级 / 初始化流程 / 持久化机制见 [skill-system-detail.md §1](./skill-system-detail.md#1-skillregistry)。

简要 API:

```js
const reg = new SkillRegistry({...});
await reg.init();         // 启动时一次
const s = reg.get(name);  // 查一个, 无则 undefined
const s = reg.require(name); // 查一个, 无则抛错
reg.all();                // 所有 SkillInfo 数组
reg.names();              // 所有 name 数组
await reg.reload();       // skill_install_from_url 后重发现 (= init())
```

## 6. grep 工具后端 (skill-grep)

详细参数 / 输出裁剪 / ripgrep args / Node 回退 glob 见 [skill-system-detail.md §2](./skill-system-detail.md#2-grep-工具后端-skill-grep)。

核心要点:
- 优先 `rg`, 回退 Node `fs.readFileSync`
- 100 命中上限 / 2KB 单行截断 / 16KB 总输出上限
- `truncated: true` 表示输出被截断

## 7. 启动流程 (集成示例)

详见 [skill-system-pitfalls.md §1](./skill-system-pitfalls.md#1-启动流程-集成示例)。简要版:

```js
import { SkillRegistry } from './skill-registry.mjs';
import { buildRegistryFetcher } from './skill-fetcher.mjs';
import { SKILLS } from './skills.mjs';

const builtinSkills = new Map();
for (const sk of SKILLS) {
  builtinSkills.set(sk.name, {
    name: sk.name, description: sk.description,
    content: sk.content, location: '<builtin>', source: 'builtin',
  });
}

const fetcher = config.skillRemoteUrls.length > 0
  ? (url) => buildRegistryFetcher(url) : null;

const registry = new SkillRegistry({
  builtinSkills, dataDir: config.skillDataDir,
  remoteUrls: config.skillRemoteUrls, fetcher,
});

await registry.init();                    // 启动时一次
const skill = registry.get('foo');        // 工具调用
await registry.reload();                  // skill_install_from_url 后
```

## 8. 坑点

**11 项坑点见 [skill-system-pitfalls.md §2](./skill-system-pitfalls.md#2-坑点)**, 包括:
- `init()` 必须 await
- 不要把 builtin 持久化到 dataDir
- 远程失败静默 (不影响其他源)
- SKILL.md frontmatter 必须在文档开头
- rg 二进制检测用 spawnSync
- grep 输出 16KB 上限
- reload() 是异步重发现
- 多源合并优先级
- dataDir 不存在不报错
- SKILL.md 文件名约定大写
- 远程 skill 持久化失败不影响内存

`reload()` = `init()`, 是异步 (内部 `await _loadDir` / `_loadFromUrl`)。在工具 `skill_install_from_url` 成功后调一次, **不要**在其他地方偷偷调 (会拖慢请求)。