# skills — 技能包

> 路径: `agent/lib/skills.mjs` (92 行)
> 参考: opencode skill 机制

技能包 = **命名的工作流指令包**。LLM 通过 `skill` 工具加载某个技能后, 该技能的 `instructions` 字符串注入上下文, 后续回答就按该技能的工作流执行 —— 相当于给 `/大黄鱼` 加上技能前缀。

---

## 1. 数据结构

```js
export const SKILLS = {
  report: {
    description: '一句话说明 (供 skill 工具列表展示)',
    instructions: '多行工作流指令 (注入后 LLM 遵守执行)',
  },
  ...
};
```

导出辅助函数:

| 函数 | 用途 |
|---|---|
| `listSkills()` | 返回 `- name: description` 列表 (供 `skill` 工具报错时展示可用项) |
| `getSkill(name)` | 取 `{name, description, instructions}`; 未知返回 `null` |

---

## 2. SKILLS 表

| Skill | 适用 | 工作流 (instructions 核心) |
|---|---|---|
| `report` | 结构化研究报告/总结 | 结论(1-2句) → 背景 → 详述(分点+依据, 可调工具查证) → 来源(URL); 简洁不编造 |
| `explain` | 通俗解释 | 一句话总览 → 1-2 个生活化类比 → 具体例子 → 分步/分层展开; 避免术语堆砌 |
| `analyze` | 数据/文本分析 | 明确问题 → (需要时)python 处理 → 结论+关键依据(数字/区间) → 局限与误差 |
| `translate` | 翻译 | 中英互译 → 译文原文一行 → 术语/歧义处给简明注解; 语境自然不硬译 |
| `story` | 故事/连载 | 定基调与主角 → 每章 100-200 字结尾留悬念 → 语言有画面感 → 用户喊"继续"接着写 |
| `task` | 多步任务管理 | 拆成 3-8 步 → todo_update 记录 → 逐条执行, 完成一个勾一个 → 汇报进展 |
| `news_roundup` | 新闻/热点榜单 | web_search(取前6) → fetch_url 抓 2-3 条详情 → python 排序/去重 → 三段输出(结论/重点/来源); **禁止只搜一次就给结论** |
| `trending` | 热门/趋势 | 至少 2 个关键词角度搜索 → 抓 2-3 条详情取趋势指标 → python 去重/排序/算趋势分数 → 三段输出(趋势概况/上升下降热点/来源) |

---

## 3. 加载流程

```
/大黄鱼 skill news_roundup
   │
   ▼
skill 工具 (tools.mjs)
   ├─ 检查 ctx.skills.enabled          (DISABLE_SKILLS=1 → {error})
   ├─ getSkill('news_roundup')         (未知 → {error} + 可用列表)
   └─ 返回 { loaded: 'news_roundup', instruction: '<instructions 字符串>' }
   │
   ▼
router 把 instruction 注入 LLM 上下文 (作为用户消息 / 系统追加)
   │
   ▼
LLM 后续回答按该技能工作流执行
```

要点:

- **注入的是纯指令字符串**: 不是代码、不是函数, LLM 直接"照做"
- **不改变工具白名单**: 技能只影响"怎么做", 不影响"能调什么工具"
- **一次性会话内生效**: 技能指令进入当前会话上下文, 新会话需要重新加载

---

## 4. 开关与门控

| 环境变量 | 效果 |
|---|---|
| `DISABLE_SKILLS=1` | 关闭全部技能: `skill` 工具返回 `{error: '技能包未开启'}` |

---

## 5. 新增技能包 checklist

1. `skills.mjs` 的 `SKILLS` 加一条
2. `instructions` 写清: 触发场景 + 强制步骤 (每步"必须执行") + 输出格式 + 失败处理
3. `description` 控制在 1 行 (会被 `skill` 工具和 `listSkills()` 展示)
4. `tools.mjs` 的 `skill` 工具 `enum` 会自动跟随 `Object.keys(SKILLS)`, 无需手改
5. 涉及联网/计算的技能, 在 instructions 里强调多步与防假结论 (参考 news_roundup)