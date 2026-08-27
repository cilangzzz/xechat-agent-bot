// 鱼塘 agent 智能体 —— WebSocket 连接层
// 协议核心从原 /大黄鱼 bot (listen_reply.mjs) 原样提取, 封装为可复用的 WsClient:
//   - 支持 HTTP CONNECT 代理 / 直连两种通道
//   - 手写 WebSocket 帧编解码 (无第三方依赖)
//   - LOGIN / HEARTBEAT / 登录被拒识别 / 90s 僵死看门狗
// 一次 runOnce() = 一次完整连接生命周期, 返回退出原因; 由外层决定重连策略。
import net from 'node:net';
import crypto from 'node:crypto';

/** 客户端→服务端 文本帧编码 (RFC6455, 必须加掩码) */
export function encodeClientText(text) {
  const data = Buffer.from(text, 'utf8');
  const len = data.length;
  const mask = crypto.randomBytes(4);
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = data[i] ^ mask[i % 4];
  let header;
  if (len < 126) {
    header = Buffer.alloc(6);
    header[0] = 0x81; header[1] = 0x80 | len;
    mask.copy(header, 2);
  } else if (len < 65536) {
    header = Buffer.alloc(8);
    header[0] = 0x81; header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
    mask.copy(header, 4);
  } else {
    header = Buffer.alloc(14);
    header[0] = 0x81; header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
    mask.copy(header, 10);
  }
  return Buffer.concat([header, masked]);
}

/** 服务端→客户端 帧解码 (服务端帧不带掩码) */
export function decodeServerFrame(buf) {
  if (buf.length < 2) return null;
  const b0 = buf[0], b1 = buf[1];
  const opcode = b0 & 0x0f;
  let len = b1 & 0x7f, offset = 2;
  if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); offset = 4; }
  else if (len === 127) { if (buf.length < 10) return null; len = Number(buf.readBigUInt64BE(2)); offset = 10; }
  if (buf.length < offset + len) return null;
  return { opcode, payload: buf.slice(offset, offset + len), consumed: offset + len };
}

export class WsClient {
  /**
   * @param {object} opts 见 config.mjs
   * @param {(line:string)=>void} [opts.log]
   */
  constructor(opts) {
    this.opts = opts;
    this.log = opts.log || (() => {});
    /** 收到解析后的消息回调: (msg, {frame}) => void */
    this.onMessage = null;
    /** 登录成功回调: () => void */
    this.onLogin = null;
    /** 待匹配响应队列: [{match, resolve, reject, timer}] —— sendActionAndWait 使用 */
    this._waiters = [];
    this.sock = null;
    this.loggedIn = false;
    this.loginRejected = false;
    this._buf = Buffer.alloc(0);
    this._runResolve = null;
    this._timers = [];
  }

  /** 发送一条 JSON action 消息 */
  sendAction(action, body = {}) {
    this.sendText(JSON.stringify({ action, body }));
  }

  /**
   * 发送一条 action 并等待匹配的响应解析(用于 GAME_ROOM 等请求-响应语义)。
   * 匹配规则 match(msg, t, body):true 命中即 resolve 该条消息, 不命中继续等待。
   * 默认 8s 超时, 拒绝时返回 { error: 'timeout', lastSeen }。
   * 注意: 该方法只在 tool 派发使用, 聊天消息不走这里。
   */
  sendActionAndWait(action, body = {}, {match, timeoutMs = 8000} = {}) {
    return new Promise((resolve, reject) => {
      if (typeof match !== 'function') {
        reject(new Error('sendActionAndWait 需要 match 函数'));
        return;
      }
      if (!this.sock) { reject(new Error('not connected')); return; }
      const waiter = { match, resolve, reject, timer: null, done: false };
      waiter.timer = setTimeout(() => {
        if (waiter.done) return;
        waiter.done = true;
        // 从队列移除
        const i = this._waiters.indexOf(waiter);
        if (i >= 0) this._waiters.splice(i, 1);
        reject(new Error('timeout: ' + action));
      }, timeoutMs);
      this._waiters.push(waiter);
      try {
        this.sendAction(action, body);
      } catch (e) {
        if (waiter.done) return;
        waiter.done = true;
        clearTimeout(waiter.timer);
        const i = this._waiters.indexOf(waiter);
        if (i >= 0) this._waiters.splice(i, 1);
        reject(e);
      }
    });
  }

  /** 内部: 把一条收到消息喂给所有 waiter, 第一个 match 的消费它 */
  _feedWaiters(msg) {
    const t = msg.action || msg.type;
    const body = msg.body || {};
    for (let i = 0; i < this._waiters.length; i++) {
      const w = this._waiters[i];
      let hit = false;
      try { hit = !!w.match(msg, t, body); } catch (e) { hit = false; }
      if (hit) {
        w.done = true;
        clearTimeout(w.timer);
        this._waiters.splice(i, 1);
        w.resolve({ msg, type: t });
        return;
      }
    }
  }

  sendText(text) {
    if (!this.sock) throw new Error('not connected');
    this.sock.write(encodeClientText(text));
  }

  /** 主动断开 (不触发自动重连语义, 由外层接管) */
  stop() {
    this._finish('stopped');
  }

  /** 一次连接生命周期: 连接→握手→登录→监听, resolve(退出原因) */
  runOnce() {
    return new Promise((resolve) => {
      this._runResolve = resolve;
      const { host, port, proxy, direct, username, status } = this.opts;
      const TARGET = { host, port };
      let sock;
      try {
        sock = direct ? net.connect(TARGET.port, TARGET.host) : net.connect(proxy.port, proxy.host);
      } catch (e) { resolve('connect-error'); return; }
      this.sock = sock;
      let tunneled = false, handshaked = false;
      this._buf = Buffer.alloc(0);
      this.loggedIn = false;
      this.loginRejected = false;
      let liveSince = 0, lastData = Date.now();
      let hb = null, watchdog = null;

      const finish = (why) => {
        for (const t of this._timers) { try { clearInterval(t); } catch (e) {} }
        this._timers = [];
        // 拒绝所有未消费的 waiter(连接结束)
        const err = new Error('connection ended: ' + why);
        for (const w of this._waiters) {
          if (w.done) continue;
          w.done = true;
          clearTimeout(w.timer);
          try { w.reject(err); } catch (e) {}
        }
        this._waiters = [];
        try { sock.destroy(); } catch (e) {}
        this.sock = null;
        this._runResolve = null;
        resolve(why);
      };

      const doWsHandshake = () => {
        const key = crypto.randomBytes(16).toString('base64');
        sock.write(`GET /xechat HTTP/1.1\r\nHost: ${TARGET.host}:${TARGET.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
      };

      sock.on('connect', () => {
        if (direct) { tunneled = true; doWsHandshake(); }
        else { sock.write(`CONNECT ${TARGET.host}:${TARGET.port} HTTP/1.1\r\nHost: ${TARGET.host}:${TARGET.port}\r\n\r\n`); }
      });

      sock.on('data', (chunk) => {
        this._buf = Buffer.concat([this._buf, chunk]);
        lastData = Date.now();
        if (!tunneled) {
          if (direct) {
            tunneled = true;
          } else {
            const idx = this._buf.indexOf('\r\n\r\n');
            if (idx < 0) return;
            const head = this._buf.slice(0, idx).toString('latin1');
            this._buf = this._buf.slice(idx + 4);
            if (!head.includes(' 200 ')) { this.log(`[-] CONNECT 失败: ${head.split('\r\n')[0]}`); finish('connect-fail'); return; }
            tunneled = true;
          }
          doWsHandshake();
        }
        if (tunneled && !handshaked) {
          const idx = this._buf.indexOf('\r\n\r\n');
          if (idx < 0) return;
          const head = this._buf.slice(0, idx).toString('latin1');
          this._buf = this._buf.slice(idx + 4);
          if (!head.includes(' 101 ')) { this.log(`[-] WS 握手失败: ${head.split('\r\n')[0]}`); finish('handshake-fail'); return; }
          handshaked = true;
          this.log(`[+] WS 握手成功, 以 ${username} 登录`);
          // 与旧 bot 保持字节级一致: LOGIN 的 uuid 每次连接重新生成; HEARTBEAT 不带 body 字段
          this.sendAction('LOGIN', {
            username, status, platform: 'WEB',
            uuid: 'web-' + Math.random().toString(36).slice(2),
            pluginVersion: '', reconnected: false,
          });
          hb = setInterval(() => {
            try { this.sendText(JSON.stringify({ action: 'HEARTBEAT' })); } catch (e) {}
          }, this.opts.heartbeatMs);
          this._timers.push(hb);
        }
        if (handshaked) {
          while (true) {
            const fr = decodeServerFrame(this._buf);
            if (!fr) break;
            this._buf = this._buf.slice(fr.consumed);
            if (fr.opcode !== 1) { if (fr.opcode === 8) { finish('server-close'); return; } continue; }
            const raw = fr.payload.toString('utf8');
            let m; try { m = JSON.parse(raw); } catch (e) { continue; }
            const t = m.action || m.type;

            // 先尝试喂给 sendActionAndWait 的 waiter
            this._feedWaiters(m);

            if (t === 'SYSTEM') {
              const txt = typeof m.body === 'string' ? m.body : (m.body && m.body.content) || '';
              if (/黑名单|重复|不合法|为空|未获取|禁言|拒绝/.test(txt)) {
                this.log(`[!] 登录被拒: ${txt.split('\n')[0]}`);
                this.loginRejected = true;
                finish('login-rejected');
                return;
              }
              if (/欢迎/.test(txt)) this.log(`[SYS] ${txt.split('\n')[0]}`);
            }
            if (t === 'USER_STATE' && m.body && m.body.state === 'ONLINE'
                && m.body.user && m.body.user.username === username && !this.loggedIn) {
              this.loggedIn = true;
              liveSince = Date.now();
              this.log(`[+] 登录成功, 开始监听 "${this.opts.cmdPrefix}" 指令`);
              if (this.onLogin) this.onLogin();
            }
            if (this.onMessage) this.onMessage(m, { live: liveSince > 0 && Date.now() - liveSince > this.opts.replaySkipMs });
          }
        }
      });
      sock.on('error', (e) => { if (!this.loginRejected) this.log(`[-] socket: ${e.code}`); finish('sock-error'); });
      sock.on('close', () => { finish('closed'); });
      // 存活看门狗: 90s 无任何数据则判定连接僵死, 主动重连(避免静默死连接)
      watchdog = setInterval(() => {
        if (Date.now() - lastData > this.opts.staleTimeoutMs) { this.log(`[-] ${this.opts.staleTimeoutMs / 1000}s 无数据, 判定连接僵死, 重连`); finish('stale'); }
      }, 30000);
      this._timers.push(watchdog);
    });
  }
}
