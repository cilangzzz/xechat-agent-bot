// 鱼塘 agent 智能体 —— 会话管理 (带结构化上下文压缩 + 每用户待办 + 每用户并发锁)
// 每个用户独立的会话 = 摘要(summary) + 最近消息 + 待办(todos)。
// 压缩策略参考 opencode: 按 token 预算保留最近对话(tail)、把多余旧消息(head)交给 LLM 压成
// 结构化摘要(compaction.mjs), 增量合并到已有摘要 —— 上下文始终有界且可继续工作。
import { estimateTokens, select } from './compaction.mjs';

export class SessionStore {
  constructor({ historyMax = 10, compressAt = 14, summaryMaxLen = 800, ttlMs = 0, compressBudgetTokens = 3000 } = {}) {
    this.historyMax = historyMax;
    this.compressAt = compressAt;            // 保留的兼容字段(不再作为唯一触发条件)
    this.summaryMaxLen = summaryMaxLen;
    this.ttlMs = ttlMs;                      // >0 时超过该时长未活跃的会话会被惰性清理
    this.compressBudgetTokens = compressBudgetTokens; // 估计 token 达该值才触发压缩
    this.map = new Map();
    this.locks = new Map();                  // 每用户 in-flight 锁 (username -> Promise)
  }

  /** 追加一条用户消息, 返回该会话的完整上下文快照 { summary, history } */
  pushUser(username, content) {
    const s = this._get(username);
    s.history.push({ role: 'user', content });
    s.lastActive = Date.now();
    return this._snapshot(s);
  }

  /** 追加一条 assistant 回复 */
  pushAssistant(username, content) {
    const s = this._get(username);
    s.history.push({ role: 'assistant', content });
    s.lastActive = Date.now();
  }

  /** 读取某用户当前上下文快照 */
  get(username) {
    const s = this.map.get(username);
    return s ? this._snapshot(s) : { summary: '', history: [] };
  }

  /** 读取原始 history 数组 (测试用) */
  getRawHistory(username) {
    const s = this.map.get(username);
    return s ? [...s.history] : [];
  }

  /**
   * token 预算式压缩: 估计 token 超过预算时, 把多余旧消息(head)交给 summarizeFn 压进摘要,
   * 保留最近预算内消息(至少 historyMax 条)。signature 与旧版兼容 (username, summarizeFn)。
   * @param {string} username
   * @param {(summary:string, batch:object[])=>Promise<string>} summarizeFn
   * @param {object} [opts] { budget } 覆盖预算
   * @returns {Promise<boolean>} 是否真的压缩了
   */
  async maybeCompress(username, summarizeFn, opts = {}) {
    const s = this.map.get(username);
    if (!s || s.compressing) return false;
    const budget = opts.budget ?? this.compressBudgetTokens;
    if (estimateTokens(s.history.map((m) => m.content)) <= budget) return false;
    if (s.history.length <= this.historyMax) return false;
    s.compressing = true;
    try {
      const { head, recent } = select(s.history, budget);
      // 保证至少保留最近 historyMax 条(即使单条超预算)
      const keep = recent.length >= this.historyMax ? recent : s.history.slice(-this.historyMax);
      const toCompress = s.history.slice(0, s.history.length - keep.length);
      if (!toCompress.length) return false;
      const newSummary = await summarizeFn(s.summary, toCompress);
      if (newSummary) s.summary = newSummary.slice(0, this.summaryMaxLen);
      s.history = keep;
      return true;
    } finally {
      s.compressing = false;
    }
  }

  /** 清空某用户会话(含待办) */
  clear(username) {
    this.map.delete(username);
  }

  /** 惰性清理过期会话 */
  gc() {
    if (!this.ttlMs) return;
    const now = Date.now();
    for (const [k, s] of this.map) if (now - s.lastActive > this.ttlMs) this.map.delete(k);
  }

  get size() { return this.map.size; }

  /** 每用户并发锁: 同一用户名串行执行; 不同用户互不阻塞。返回释放函数。 */
  async acquire(username) {
    const prev = this.locks.get(username) || Promise.resolve();
    let release;
    const next = new Promise((r) => { release = r; });
    this.locks.set(username, prev.then(() => next));
    await prev.catch(() => {});
    return () => { this.locks.delete(username); release(); };
  }

  /** 非阻塞尝试加锁: 同用户已在处理则返回 null(聊天室里后续消息直接跳过), 否则返回释放函数。 */
  tryLock(username) {
    if (this.locks.has(username)) return null;
    let release;
    this.locks.set(username, new Promise((r) => { release = r; }));
    return () => { this.locks.delete(username); release(); };
  }

  _get(username) {
    let s = this.map.get(username);
    if (!s) {
      s = { history: [], summary: '', todos: [], lastActive: Date.now(), compressing: false };
      this.map.set(username, s);
    }
    return s;
  }

  _snapshot(s) {
    return { summary: s.summary || '', history: [...s.history], todos: s.todos || [] };
  }
}