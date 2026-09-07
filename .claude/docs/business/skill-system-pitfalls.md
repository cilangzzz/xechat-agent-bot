# lib/business/skill-* — 集成示例与坑点

> 本文件是 [skill-system.md](./skill-system.md) §7-8 的展开。

## 1. 启动流程 (集成示例)

```js
import { SkillRegistry } from './skill-registry.mjs';
import { buildRegistryFetcher } from './skill-fetcher.mjs';
import { SKILLS } from './skills.mjs';          // builtin skills

// 1. builtin skills 来自 skills.mjs 的 SKILLS 常量
const builtinSkills = new Map();
for (const sk of SKILLS) {
  builtinSkills.set(sk.name, {
    name: sk.name,
    description: sk.description,
    content: sk.content,
    location: '<builtin>',
    source: 'builtin',
  });
}

// 2. 创建 registry
const fetcher = config.skillRemoteUrls.length > 0
  ? (url) => buildRegistryFetcher(url)
  : null;

const registry = new SkillRegistry({
  builtinSkills,
  dataDir: config.skillDataDir,
  remoteUrls: config.skillRemoteUrls,
  fetcher,
});

// 3. 启动时 init 一次
await registry.init();

// 4. 工具调用 / LLM 决策用
const skill = registry.get('foo');
// 工具调用: skill_install_from_url 后:
await registry.reload();
```

## 2. 坑点

### 2.1 `init()` 必须 `await`

未 init 时 `get()` / `all()` 都返回空。`agent.mjs` 启动要 `await registry.init()` 再让 router 工作。

### 2.2 不要把 builtin 持久化

builtin skills 来自 `skills.mjs` 的 SKILLS 常量, 不应该出现在 `dataDir/`。否则会被 user_dir 路径覆盖。

### 2.3 远程失败静默

`_loadFromUrl` 单个仓库失败仅 log 跳过, **不影响**其他仓库和 builtin。需要监控时看 `[skill-fetcher]` 日志。

### 2.4 SKILL.md frontmatter 必须在文档开头

`^---\n` 必须真在第一行, 中间不能有空行。如果 frontmatter 前有 BOM 或空格, 解析失败。

### 2.5 `rg` 二进制检测用 `spawnSync`

```js
const r = spawnSync('rg', ['--version'], { stdio: 'ignore' });
return r.status === 0;
```

- `rg` 不在 PATH → 返回 false, 自动用 Node 回退
- 容器化部署时记得安装 ripgrep (apt: `ripgrep`)

### 2.6 grep 输出 16KB 上限

超过会被 `kill` 子进程 + 标 `truncated: true`。LLM 看到的 `truncated` 字段**必须**提示"结果被截断, 建议缩小搜索范围"。

### 2.7 reload() 是同步重发现

`reload()` = `init()`, 是异步 (内部 `await _loadDir` / `_loadFromUrl`)。在工具 `skill_install_from_url` 成功后调一次, **不要**在其他地方偷偷调 (会拖慢请求)。

### 2.8 多源合并优先级

```
init() 顺序:
  1) builtin   → 底层
  2) user_dir  → 覆盖 builtin
  3) user_url  → 覆盖 user_dir (可远程更新 builtin)
```

**同名 skill 后注册覆盖先注册**, 与 opencode 行为一致。

### 2.9 dataDir 不存在不报错

`_loadDir` 用 `try { readdir } catch { return; }`, `dataDir` 不存在视为空 (无 user_dir skills)。这是有意为之, **不要**让 agent 启动失败。

### 2.10 SKILL.md 文件名必须大写

```js
const mdFile = entry.files.find((f) => /SKILL\.md$/i.test(f)) || 'SKILL.md';
```

正则 `i` 标记 → 大小写不敏感, 但**约定**用大写 `SKILL.md`。

### 2.11 远程 skill 持久化失败不影响内存

`_loadFromUrl` 写盘失败也继续 set `_all`, 这样重启后即使远程仓库失效, 至少本地有副本可用。