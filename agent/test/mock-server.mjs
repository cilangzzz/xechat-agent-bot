// 鱼塘 agent 智能体 —— 本地 mock 鱼塘服务器 (离线端到端自测用)
// 用原生 net 实现最简 WebSocket 服务端, 模拟 Xechat 服务端的协议行为:
//   握手 → LOGIN → 回 SYSTEM 欢迎 + USER_STATE 上线 + ONLINE_USERS 快照
//   转发 CHAT / USER_STATE 广播; 记录 agent 发出的 CHAT 作为回复
// 不连真实鱼塘、不产生任何外网流量, 只验证 agent 骨架的协议与流程。
import net from 'node:net';
import crypto from 'node:crypto';

function sha1Base64(s) {
  return crypto.createHash('sha1').update(s).digest('base64');
}

/** 服务端→客户端 文本帧 (服务端帧不带掩码) */
export function encodeServerText(text) {
  const data = Buffer.from(text, 'utf8');
  const len = data.length;
  let header;
  if (len < 126) { header = Buffer.from([0x81, len]); }
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([header, data]);
}

/** 解码客户端帧 (客户端帧带掩码) */
function decodeMaskedFrame(buf) {
  if (buf.length < 2) return null;
  const b0 = buf[0], b1 = buf[1];
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let len = b1 & 0x7f, offset = 2;
  if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); offset = 4; }
  else if (len === 127) { if (buf.length < 10) return null; len = Number(buf.readBigUInt64BE(2)); offset = 10; }
  const maskLen = masked ? 4 : 0;
  if (buf.length < offset + maskLen + len) return null;
  let payload = buf.slice(offset + maskLen, offset + maskLen + len);
  if (masked) {
    const mask = buf.slice(offset, offset + 4);
    const out = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) out[i] = payload[i] ^ mask[i % 4];
    payload = out;
  }
  return { opcode, payload, consumed: offset + maskLen + len };
}

export class MockPondServer {
  /**
   * @param {object} opts { port(默认0=随机), host(默认127.0.0.1), users(预置在线用户) }
   *   回调: onLogin(username) / onReply(from, replyText) / onLog(line)
   */
  constructor(opts = {}) {
    this.host = opts.host || '127.0.0.1';
    this.port = opts.port || 0;
    this.users = opts.users || ['mocker_01', 'mocker_02'];
    this.onLogin = opts.onLogin || null;
    this.onReply = opts.onReply || null;
    this.onLog = opts.onLog || (() => {});
    this.server = null;
    this.sock = null;
    this.buf = Buffer.alloc(0);
    this.loggedInUser = null;
    this.replies = [];
    this.heartbeats = [];
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((sock) => this._handleSocket(sock));
      this.server.on('error', reject);
      this.server.listen(this.port, this.host, () => {
        this.port = this.server.address().port;
        resolve(this.port);
      });
    });
  }

  stop() {
    return new Promise((resolve) => {
      try { this.sock && this.sock.destroy(); } catch (e) {}
      this.server && this.server.close(() => resolve());
      if (!this.server) resolve();
    });
  }

  /** 模拟服务端发一条聊天消息 (触发 agent), 用真实服务端的 type=USER 结构 */
  sendChat(from, text) {
    this._sendJson({ type: 'USER', user: { username: from }, body: { content: text, msgType: 'TEXT', toUsers: [] }, time: '08/25 12:00' });
  }

  _handleSocket(sock) {
    this.sock = sock;
    this.buf = Buffer.alloc(0);
    let handshaked = false;

    sock.on('data', (chunk) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      if (!handshaked) {
        const idx = this.buf.indexOf('\r\n\r\n');
        if (idx < 0) return;
        const head = this.buf.slice(0, idx).toString('latin1');
        this.buf = this.buf.slice(idx + 4);
        const m = head.match(/Sec-WebSocket-Key:\s*(.+)/i);
        const accept = sha1Base64((m ? m[1].trim() : '') + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11');
        sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        handshaked = true;
        this.onLog('[mock] WS 握手完成');
        return;
      }
      while (true) {
        const fr = decodeMaskedFrame(this.buf);
        if (!fr) break;
        this.buf = this.buf.slice(fr.consumed);
        if (fr.opcode !== 1) continue;
        let m; try { m = JSON.parse(fr.payload.toString('utf8')); } catch (e) { continue; }
        this._onJson(m);
      }
    });
    sock.on('error', () => {});
    sock.on('close', () => { this.onLog('[mock] 连接关闭'); });
  }

  _onJson(m) {
    const action = m.action;
    this.onLog(`[mock] 收到 ${action}`);
    if (action === 'LOGIN') {
      this.loggedInUser = m.body && m.body.username;
      if (this.onLogin) this.onLogin(this.loggedInUser);
      this._sendJson({ type: 'SYSTEM', body: { content: '欢迎来到鱼塘' } });
      this._sendJson({ type: 'USER_STATE', body: { state: 'ONLINE', user: { username: this.loggedInUser } } });
      // 与真实服务端一致: ONLINE_USERS 的 body 是 { userList: [...] }
      this._sendJson({ type: 'ONLINE_USERS', body: { userList: this.users.map((u) => ({ username: u })) } });
    }
    if (action === 'HEARTBEAT') { this.heartbeats.push(m); /* 忽略 */ }
    if (action === 'CHAT') {
      const replyText = m.body && m.body.content;
      this.replies.push(replyText);
      if (this.onReply) this.onReply(m.body && m.body.toUsers, replyText);
    }
  }

  _sendJson(obj) {
    if (!this.sock) return;
    try { this.sock.write(encodeServerText(JSON.stringify(obj))); } catch (e) {}
  }
}
