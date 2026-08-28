// 鱼塘 agent 智能体 —— 技能包 (references: opencode skill 机制)
// 命名的工作流指令包: LLM 通过 skill_get 工具加载某个技能后, 指令进入上下文,
// 后续回答就按该技能的工作流执行 —— 类似于 /大黄鱼 加技能前缀。
//
// 多源: builtin (代码内置) + user_dir (本地 data/skills/) + user_url (远程仓库).
// 见 skill-registry.mjs 实现。SKILLS 常量保留作 BUILTIN 源 + 旧 API 兼容。

// —— 把 SKILLS 常量转为 SkillInfo 形状 (供 SkillRegistry._builtin 用) ——
export function getBuiltinSkills() {
  /** @type {Map<string, {name:string, description:string, content:string, location:string}>} */
  const m = new Map();
  for (const [name, s] of Object.entries(SKILLS)) {
    m.set(name, {
      name,
      description: s.description,
      content: s.instructions,
      location: '<builtin>',
    });
  }
  return m;
}

/** 已弃名: 建议用 SkillRegistry.all().map(s => `- ${s.name}: ${s.description}`) */
export function listSkills() {
  return Object.entries(SKILLS).map(([name, s]) => `- ${name}: ${s.description}`);
}

/** 已弃名: 建议用 SkillRegistry.get(name) */
export function getSkill(name) {
  const s = SKILLS[name];
  return s ? { name, description: s.description, instructions: s.instructions } : null;
}

// 保留原 SKILLS 常量(旧代码 + router 命令会用到),新逻辑迁移到 SkillRegistry
export const SKILLS = {
  report: {
    description: '生成结构化研究报告/总结报告: 先搜资料→提炼要点→按 背景/结论/详述/来源 组织',
    instructions: `你正在执行"报告"技能。输出一份结构化报告, 结构固定为:
## 结论
- 先说核心结论(1-2 句)
## 背景
- 为什么关注这个问题
## 详述
- 分点展开事实、数据、依据 (需要时可调用工具查证)
## 来源
- 列 URL 或出处
要求: 简洁、给依据、不编造; 超过单条消息上限时自然地用分片呈现。`,
  },
  explain: {
    description: '把复杂概念用通俗易懂的方式解释清楚(类比/例子/分步)',
    instructions: `你正在执行"解释"技能。目标是用对方能听懂的方式讲清楚:
- 先一句话总览(它是什么)
- 再用 1-2 个生活化类比
- 给一个具体例子
- 最后按步骤/层次展开
避免术语堆砌; 用过的术语都给出白话解释。`,
  },
  analyze: {
    description: '数据/文本分析: 拆解任务→(如需)用 python 处理→给出结论与依据',
    instructions: `你正在执行"分析"技能。流程:
1. 明确要回答的问题与可用数据
2. 需要计算/处理时调用 python(打印可读结果)
3. 基于结果给出结论, 并附关键依据(数字/区间)
4. 说明局限与误差来源(如适用)
不要只给结论不给过程依据。`,
  },
  translate: {
    description: '翻译: 中英互译, 保持语境自然, 输出 译文 + 简要注解(可选)',
    instructions: `你正在执行"翻译"技能。规则:
- 先判断源语言与目标语言(默认中英互译)
- 输出: 译文原文一行 + 若有术语/歧义再给出简明注解
- 口语/语境要翻得自然, 不要逐字硬译`,
  },
  story: {
    description: '写故事/连载: 分章节输出, 每章短小精悍, 结尾留钩子',
    instructions: `你正在执行"写作"技能。写故事/小说连载时:
- 先定基调与主角(短)
- 每章 100-200 字, 结尾留悬念
- 语言有画面感; 超长内容自然分片发送
- 用户可喊"继续"接着上一章写`,
  },
  task: {
    description: '多步任务管理: 拆解步骤→用 todo 记录→逐步执行并汇报进展',
    instructions: `你正在执行"任务管理"技能。对于多步任务:
1. 先把整个任务拆成 3-8 个可执行步骤
2. 用 todo_update 记录这些步骤
3. 逐条执行, 完成一个就勾掉一个(todo_update done)
4. 汇报时给出已完成/进行中/下一步
不要一次性长篇规划却不落地。`,
  },
  news_roundup: {
    description: '新闻/热点榜单: 多步 web_search → fetch_url 抓详情 → python 排序/去重 → 给来源',
    instructions: `你正在执行"热点榜单"工作流。用户通常问"今日热点"、"头条榜"、"最近 XX 领域热门"等。
流程(每步**必须执行**, 不要省略):
1) web_search 搜 "{query} 今日热点" / "{query} 头条榜" 等, 选 1-2 个角度, 每次取前 6 条结果;
2) 从候选 URL 中挑 2-3 条最相关的, 用 fetch_url 抓详情(300 字段内的关键事实);
3) 数据/排行类需要排序去重时, 用 python 处理;
4) 最终输出三段(每条 1-2 行短句, 便于 200 字分片后仍美观):
   ## 结论 (1-2 句核心)
   ## 重点 (每条 1 行, 含关键数字/事件)
   ## 来源 (URL 列表)
若某步工具失败/为空, 反思后换关键词或换 URL 再试;**禁止** 只调一次 web_search 就给结论。`,
  },
  trending: {
    description: '热门/趋势: 多源搜索 + 聚合 + 按热度/趋势维度组织',
    instructions: `你正在执行"趋势/热门"工作流。流程与 news_roundup 类似, 但输出按热度/趋势维度组织:
1) web_search 至少 2 个不同关键词角度, 收集候选;
2) fetch_url 抓 2-3 条详情获取趋势指标(关注度/讨论量/对比变化);
3) 用 python 去重/排序/计算趋势分数;
4) 输出三段(每条 1-2 行短句):
   ## 趋势概况 (整体走向)
   ## 上升/下降热点 (按热度分组)
   ## 来源 (URL 列表)`,
  },
};

// === 保留原始 export 顺序以兼容旧 import ===
// (原 listSkills/getSkill 已上方重新声明)