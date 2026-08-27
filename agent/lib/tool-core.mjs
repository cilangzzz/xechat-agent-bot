// 鱼塘 agent 智能体 —— 工具定义 v2 / 注册表 (references: opencode tool/tool.ts + session/tools.ts)
// 每个工具 = { id, description, parameters(OpenAI function schema), budget, run(args, ctx) }。
// 与旧版相比的改进:
//   - 统一注册/校验/截断/状态: dispatch 失败时把"模型可读的修参提示"回流给 LLM(类似 opencode InvalidArgumentsError);
//   - 字符串输出按 budget 截断;
//   - run 拿到统一 ctx(状态广播/会话/api/记忆/技能/子代理委托);
//   - filter() 按 agent 白名单产出子视图(多智能体的工具可见性控制)。
// 兼容性: register/dispatch/openAiSchemas/describe/list 公开 API 与旧版一致, 既有测试不回归。

/** 定义工具: 兼容字段 name|id */
export function defineTool({ id, name, description = '', parameters = { type: 'object', properties: {} }, budget = 4000, run }) {
  if (!id && !name) throw new Error('工具缺少 id(name)');
  if (typeof run !== 'function') throw new Error('工具缺少 run');
  return { id: id || name, name: name || id, description, parameters, budget, run };
}

/** 极简 JSON Schema 校验: required + 原始类型。失败返回错误数组, 成功返回 [] */
export function validateArgs(parameters, args) {
  const errors = [];
  const props = (parameters && parameters.properties) || {};
  for (const req of (parameters && parameters.required) || []) {
    if (args[req] === undefined || args[req] === null) errors.push(`缺少必填参数「${req}」`);
  }
  for (const [k, v] of Object.entries(args || {})) {
    const sch = props[k];
    if (!sch || v === undefined || v === null) continue;
    const t = sch.type;
    if (t === 'integer' && (typeof v !== 'number' || !Number.isInteger(v))) errors.push(`参数「${k}」应为整数`);
    else if (t === 'number' && typeof v !== 'number') errors.push(`参数「${k}」应为数字`);
    else if (t === 'string' && typeof v !== 'string') errors.push(`参数「${k}」应为字符串`);
    else if (t === 'boolean' && typeof v !== 'boolean') errors.push(`参数「${k}」应为布尔`);
    else if (t === 'array' && !Array.isArray(v)) errors.push(`参数「${k}」应为数组`);
  }
  return errors;
}

export function truncateResult(result, budget) {
  if (Array.isArray(result)) {
    return result.map((r) => (typeof r === 'string' ? truncateStr(r, budget) : r));
  }
  if (result && typeof result === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(result)) out[k] = typeof v === 'string' ? truncateStr(v, budget) : v;
    return out;
  }
  if (typeof result === 'string') return truncateStr(result, budget);
  return result;
}

function truncateStr(s, max) {
  return s.length <= max ? s : `${s.slice(0, max)}\n...[输出过长已截断]`;
}

export class ToolRegistry {
  /** @param {object} ctx 基础上下文, 传给每个工具的 run; 可在 dispatch 时以 extra 覆盖/追加 */
  constructor(ctx = {}) {
    this.ctx = ctx;
    this.tools = new Map();
  }

  register(tool) {
    const def = defineTool(tool);
    this.tools.set(def.id, def);
    return this;
  }

  /** 按 id(name) 集合产出一个只含这些工具的子视图(浅共享底层定义) */
  filter(ids) {
    const sub = new ToolRegistry(this.ctx);
    for (const n of ids) {
      const t = this.tools.get(n);
      if (t) sub.tools.set(t.id, t);
    }
    return sub;
  }

  /**
   * 执行工具。
   * @param {string} name
   * @param {object} args
   * @param {object} [extra] 覆盖/追加到 ctx(如 { status, from, depth })
   */
  async dispatch(name, args, extra = {}) {
    const def = this.tools.get(name);
    if (!def) return { error: `未知工具: ${name}` };
    const errs = validateArgs(def.parameters, args || {});
    if (errs.length) {
      // 模型可读的修参提示, 让 LLM 下一轮重写参数(参照 opencode InvalidArgumentsError 文案)
      return {
        error: `工具「${name}」参数有误: ${errs.join('; ')}。请修正参数后重试。`,
      };
    }
    const ctx = { ...this.ctx, ...extra };
    try {
      return truncateResult(await def.run(args || {}, ctx), def.budget);
    } catch (e) {
      return { error: String((e && e.message) || e) };
    }
  }

  /** OpenAI function calling 所需 schemas 数组 */
  openAiSchemas() {
    return [...this.tools.values()].map((t) => ({
      type: 'function',
      function: {
        name: t.id,
        description: t.description || '',
        parameters: t.parameters || { type: 'object', properties: {} },
      },
    }));
  }

  /** 纯文本工具清单(给 LLM 系统提示词 / help) */
  describe() {
    return [...this.tools.values()]
      .map((t) => `- ${t.id}: ${t.description || ''}`)
      .join('\n');
  }

  list() { return [...this.tools.keys()]; }
  has(name) { return this.tools.has(name); }
}