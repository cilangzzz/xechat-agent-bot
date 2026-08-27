// 鱼塘 agent 智能体 —— 聊天记录日志 (持久化)
// 把当前会话收到的聊天消息追加写入 JSONL 文件(data/chat-log.jsonl), 供跨重启查询
// (recent_messages 是内存当前会话; chat_log 工具/`/大黄鱼 聊天记录` 从该日志读历史)。
// 每行: {"from","self","content","time"}。
// 通过大小上限(默认 1000 条)自动裁剪, 避免无限增长。默认开启, DISABLE_CHAT_LOG=1 关闭。
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { createReadStream } from 'node:fs';

export class ChatLog {
  /**
   * @param {object} opts { enabled, file, maxEntries, log }
   */
  constructor({ enabled = true, file = null, maxEntries = 1000, log = () => {} } = {}) {
    this.enabled = !!enabled;
    this.file = file;
    this.maxEntries = maxEntries;
    this.log = log;
  }

  /** 追加一条聊天记录(异步不阻塞) */
  append({ from, content, self = false, time = Date.now() }) {
    if (!this.enabled || !this.file) return;
    const line = JSON.stringify({
      from: String(from || '?'),
      self: !!self,
      content: String(content || '').slice(0, 300),
      time,
    });
    try {
      // 确保目录存在(data/ 可能还没建)
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, line + '\n', 'utf8');
      this._maybeTrim();
    } catch (e) { this.log(`[chat-log] 写入失败: ${e.message}`); }
  }

  /** 读取最近 n 条(跨重启可查); from 可选过滤用户 */
  async readRecent(n = 10, { from } = {}) {
    if (!this.enabled || !this.file || !fs.existsSync(this.file)) return [];
    const limit = Math.min(200, Math.max(1, n || 10));
    const lines = await this._readAllLines();
    let entries = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    if (from) entries = entries.filter((e) => e.from === from);
    return entries.slice(-limit);
  }

  /** 行数统计 */
  count() {
    if (!this.enabled || !this.file || !fs.existsSync(this.file)) return 0;
    let n = 0;
    try {
      const buf = fs.readFileSync(this.file, 'utf8');
      n = buf ? buf.split('\n').filter(Boolean).length : 0;
    } catch (e) {}
    return n;
  }

  _readAllLines() {
    return new Promise((resolve) => {
      const out = [];
      if (!fs.existsSync(this.file)) return resolve(out);
      const rl = readline.createInterface({ input: createReadStream(this.file), crlfDelay: Infinity });
      rl.on('line', (l) => { if (l.trim()) out.push(l.trim()); });
      rl.on('close', () => resolve(out));
      rl.on('error', () => resolve(out));
    });
  }

  /** 超过上限时, 只保留最近 maxEntries(每次多写一条时顺带检查, 文件小时开销可忽略) */
  _maybeTrim() {
    try {
      if (!this.file || !fs.existsSync(this.file)) return;
      const size = fs.statSync(this.file).size;
      if (size < 64 * 1024) return; // <64KB 不裁剪
      const lines = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean);
      if (lines.length <= this.maxEntries) return;
      fs.writeFileSync(this.file, lines.slice(-this.maxEntries).join('\n') + '\n', 'utf8');
    } catch (e) {}
  }
}