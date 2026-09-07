# lib/business/skill-{registry,grep}.mjs — SkillRegistry + grep 工具后端

> 本文件是 [skill-system.md](./skill-system.md) §5-6 的展开。详细说明 `SkillRegistry` 类与 `grepSkills` 工具。

## 1. SkillRegistry

### 1.1 构造函数

```js
new SkillRegistry({
  builtinSkills = new Map(),    // Map<name, SkillInfo>
  dataDir,                      // 默认 agent/data/skills
  remoteUrls = [],              // 从配置 / 工具调用传入
  fs = require('node:fs/promises'),
  fetcher = null,                // (url) => Promise<{manifest, fetchFile}>
})
```

### 1.2 合并优先级

```
init() 顺序:
  1) builtin          → 底层
  2) user_dir         → 覆盖 builtin
  3) user_url         → 覆盖 user_dir (可远程更新 builtin)
```

**同名 skill 后注册覆盖先注册**, 与 opencode 行为一致。

### 1.3 初始化流程

```
init()
  │
  ├─ _all.clear()
  │
  ├─ builtin 全部 set → source: 'builtin'
  │
  ├─ _loadDir(dataDir, 'user_dir')
  │     ├─ 扫描子目录
  │     ├─ 找 {name}/SKILL.md 或 {dir}/SKILL.md
  │     └─ 校验 frontmatter → set _all
  │
  └─ _loadFromUrl(url) for url of remoteUrls
        ├─ 容错: 单个远程失败 → log 跳过
        └─ 每个 skill:
            ├─ 抓 SKILL.md
            ├─ 持久化到 dataDir/{name}/SKILL.md
            └─ set _all → source: 'user_url'
```

### 1.4 远程 skill 持久化

`_loadFromUrl` 抓到 SKILL.md 后会**写盘**到 `dataDir/{name}/SKILL.md`, 即使写盘失败也不影响内存注册。这样:

- 重启后 user_url skill 仍能从 user_dir 路径找到 (即使远程仓库暂时不可用)
- 避免每次启动都依赖网络

### 1.5 API

```js
const reg = new SkillRegistry({...});
await reg.init();         // 启动时一次
const s = reg.get(name);  // 查一个, 无则 undefined
const s = reg.require(name); // 查一个, 无则抛错
reg.all();                // 所有 SkillInfo 数组
reg.names();              // 所有 name 数组
await reg.reload();       // skill_install_from_url 后重发现 (= init())
```

## 2. grep 工具后端 (skill-grep)

### 2.1 设计

- 优先 `rg` (ripgrep) 二进制: 快、支持正则 / glob / 二进制跳过
- 回退 Node `fs.readFileSync` + 正则 (慢但零依赖)

### 2.2 输出裁剪 (防上下文爆炸)

| 项 | 默认值 | 说明 |
|---|---|---|
| `limit` | 100 | 命中数上限 |
| `MAX_LINE_BYTES` | 2048 | 单行截断 (base64 长行也不爆) |
| `MAX_OUTPUT_BYTES` | 16384 | 总输出 16KB 上限, 超则标 `truncated: true` |

### 2.3 `grepSkills({pattern, cwd, path, include, limit, signal})`

```js
const { matches, total, truncated, backend } = await grepSkills({
  pattern: 'TODO|FIXME',
  cwd: '/path/to/skills',
  include: '*.md',
  limit: 50,
});
```

返回:
- `matches: [{path, line, text}]` — 命中的位置
- `total` — 实际命中数 (即使超 limit 也累计)
- `truncated: boolean` — 是否触发 16KB 上限
- `backend: 'rg' | 'node'` — 实际使用的后端

### 2.4 ripgrep 参数

```js
['--no-config', '--no-heading', '--line-number', '--color=never',
 '--hidden', '--no-messages', '--no-binary', '-g', '!**/.git/**']
```

- `--hidden` — 命中 `.xxx` 文件
- `-g !**/.git/**` — 排除 `.git/`
- `--no-binary` — 不输出二进制行 (避免 base64 暴击)

### 2.5 Node 回退 glob 匹配

`globToRegExp` 自实现, 把 `*.md` → `[^/]*\.md`, 把 `**/*.md` → `.*/[^/]*\.md` (简易实现)。

**重要**: 还对 basename 单独匹配, 让 `*.md` 能命中 `local-skill/SKILL.md` 这类子目录里的文件。