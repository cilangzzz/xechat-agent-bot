// 鱼塘 agent 智能体 —— 持久用户事实 (references: opencode 无此, 聊天室增强)
// 把用户在对话中透露的关键事实(昵称、爱好、偏好)按用户持久化到 JSON 文件,
// 重启后仍可被 remember/recall 工具取用。
// 安全: 聊天室消息实际广播(协议非真私密), 因此默认 ENABLE_MEMORY=0 关闭; 开启需管理员明确配置。
import fs from 'node:fs';
import path from 'node:path';

export class MemoryStore {
  /**
   * @param {object} opts { file, enabled, maxFactsPerUser }
   */
  constructor({ file, enabled = false, maxFactsPerUser = 30 } = {}) {
    this.file = file;
    this.enabled = !!enabled;
    this.maxFactsPerUser = maxFactsPerUser;
    this.data = {}; // username -> [{ key, value, at }]
    this._dirty = false;
    this._saveTimer = null;
    if (this.enabled) this._load();
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) this.data = parsed;
    } catch (e) { this.data = {}; }
  }

  /** 保存到磁盘(去抖 1s) */
  _scheduleSave() {
    if (!this.enabled) return;
    this._dirty = true;
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      if (!this._dirty) return;
      this._dirty = false;
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
      } catch (e) {}
    }, 1000);
  }

  /** 某用户名下的全部事实 */
  get(username) {
    return Array.isArray(this.data[username]) ? this.data[username] : [];
  }

  /** 记录/更新一条事实 (key 相同时覆盖) */
  set(username, key, value) {
    const list = this.get(username).filter((f) => f.key !== key);
    list.push({ key, value: String(value), at: new Date().toISOString() });
    while (list.length > this.maxFactsPerUser) list.shift();
    this.data[username] = list;
    this._scheduleSave();
  }

  /** 记住一条用户表达的事实(无显式 key 时生成一个稳定 key) */
  remember(username, fact) {
    const f = String(fact || '').trim();
    if (!f) return null;
    const key = 'fact-' + hashStr(f);
    this.set(username, key, f);
    return { key, value: f };
  }

  /** 按关键字模糊匹配(大小写不敏感), 返回匹配事实 */
  search(username, query) {
    const q = String(query || '').trim().toLowerCase();
    let hit = this.get(username);
    if (q) hit = hit.filter((f) => (f.value || '').toLowerCase().includes(q) || (f.key || '').toLowerCase().includes(q));
    return hit.slice(-8);
  }

  /** 关闭时立即落盘 */
  flush() {
    if (!this.enabled) return;
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    this._dirty = true;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (e) {}
  }
}

/** 简单稳定哈希(FNV-1a), 用于生成事实 key */
function hashStr(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}