// 鱼塘 agent 智能体 —— 定时任务处理器
// 到设定时间触发任务(提醒 / 调 LLM 执行)。内存队列为主; 开启 ENABLE_SCHEDULE_PERSIST 时落盘 JSON,
// 重启恢复(参考 memory.mjs 模式)。
// 对外:
//   add({ atMs, task, to, mode })  —— atMs 为绝对毫秒时间戳; task 为任务内容文本; mode: 'remind'|'auto'
//   cancel(id) / list() / start(onFire) / stop()
import fs from 'node:fs';
import path from 'node:path';

export class Scheduler {
  /** @param {object} opts { enabled, tickMs, persist, file, log } */
  constructor({ enabled = true, tickMs = 5000, persist = false, file = null, log = () => {} } = {}) {
    this.enabled = enabled;
    this.tickMs = tickMs;
    this.persist = persist;
    this.file = file;
    this.log = log;
    this.queue = new Map(); // id -> task
    this._seq = 0;
    this._timer = null;
    this._onFire = null;
    if (persist && file) this._load();
  }

  /** 注册一个一次性定时任务。@returns { id, atMs } */
  add({ atMs, task, to = null, mode = 'remind' }) {
    const id = 'sched_' + (++this._seq) + '_' + Date.now().toString(36);
    const entry = { id, atMs: Math.max(0, Number(atMs) || 0), task: String(task || ''), to, mode, createdAt: Date.now() };
    this.queue.set(id, entry);
    this._save();
    return { id: entry.id, atMs: entry.atMs };
  }

  /** 取消任务 */
  cancel(id) {
    const ok = this.queue.delete(id);
    if (ok) this._save();
    return ok;
  }

  /** 列出未到期任务 */
  list() {
    return [...this.queue.values()]
      .filter((t) => t.atMs > Date.now())
      .sort((a, b) => a.atMs - b.atMs)
      .map((t) => ({ id: t.id, atMs: t.atMs, task: t.task, to: t.to, mode: t.mode }));
  }

  /** 开始 tick: 到点调 onFire(entry) */
  start(onFire) {
    if (!this.enabled) return;
    this._onFire = onFire || (() => {});
    this._timer = setInterval(() => this.tick(), this.tickMs);
    if (this._timer.unref) this._timer.unref();
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  /** 手动触发一次到期检查(测试/手动用) */
  tick() {
    const now = Date.now();
    const due = [];
    for (const [id, t] of this.queue) {
      if (t.atMs <= now) { due.push(t); this.queue.delete(id); }
    }
    if (due.length) {
      this._save();
      for (const t of due) {
        try { this._onFire && this._onFire(t); }
        catch (e) { this.log(`[定时] 触发异常: ${e.message}`); }
      }
    }
    return due;
  }

  get size() { return this.queue.size; }

  // —— 持久化 ——
  _load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      const now = Date.now();
      this._seq = parsed.seq || 0;
      this.queue = new Map();
      for (const t of (parsed.tasks || [])) {
        if (t.atMs <= now) continue; // 过期任务不恢复
        this.queue.set(t.id, t);
        if (/^sched_(\d+)_/.test(t.id)) this._seq = Math.max(this._seq, Number(t.id.match(/^sched_(\d+)_/)[1]));
      }
    } catch (e) { this.queue = new Map(); }
  }

  _save() {
    if (!this.persist || !this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({
        seq: this._seq,
        tasks: [...this.queue.values()].filter((t) => t.atMs > Date.now()),
      }, null, 2), 'utf8');
    } catch (e) {}
  }
}

/** 解析 "HH:MM" / "HH:MM:SS" → 今天或明天的绝对毫秒时间戳(已过期则明天) */
export function parseAtTime(str, now = Date.now()) {
  const m = String(str || '').trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]), sec = Number(m[3] || 0);
  if (h > 23 || min > 59 || sec > 59) return null;
  const d = new Date(now);
  d.setHours(h, min, sec, 0);
  let ms = d.getTime();
  if (ms <= now) ms += 24 * 3600 * 1000; // 今天已过 → 明天
  return ms;
}

/** 解析相对时间 "5分钟"/"2小时"/"30秒" → 相对毫秒 */
export function parseDuration(str) {
  const s = String(str || '').trim().toLowerCase();
  let m = s.match(/^(\d+(?:\.\d+)?)\s*(秒|分钟|小时|分|s|sec|second|m|min|minute|h|hour|hours?)$/);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2];
  const mult = unit.includes('秒') || unit.includes('s') ? 1000
    : (unit.includes('小时') || unit.includes('h')) ? 3600 * 1000
    : 60 * 1000;
  return Math.round(n * mult);
}