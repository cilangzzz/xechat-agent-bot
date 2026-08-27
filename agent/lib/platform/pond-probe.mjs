// 鱼塘 agent 智能体 —— 跨鱼塘探测 (probe_pond 工具的后端)
// 复用 ws-client.mjs 的 WsClient: 连目标鱼塘 WS 端口 → 一次性访客昵称登录
// → 抓 ONLINE_USERS(登录成功即被推送完整在线列表, 见 api/ws-protocol.md §5.3)
// → 可选抓最近历史消息(HISTORY_MSG) → 立即断开。
// 只读探测: 不发任何聊天消息, 拿完即走, 不打扰目标鱼塘。
import { WsClient } from '../foundation/ws-client.mjs';

const VISITOR_PREFIX = '巡塘员'; // 一次性访客昵称前缀(≤12 字符, 满足服务端昵称校验)

function makeVisitorName() {
  return VISITOR_PREFIX + Math.floor(100 + Math.random() * 900);
}

/**
 * 探测一个鱼塘并返回其在线用户列表(可附最近聊天)。
 * @param {object} opts
 * @param {string} opts.host       目标鱼塘主机(域名/IP)
 * @param {number} [opts.port=33859] 目标鱼塘 WS 端口(原生端口的 +1)
 * @param {boolean} [opts.viaProxy=false] 是否走本地代理连接
 * @param {object} [opts.proxy]    代理配置 {host, port}
 * @param {number} [opts.history=0] 顺带返回的最近聊天条数(0=不要, 上限 30)
 * @param {number} [opts.timeoutMs=12000] 整体超时
 * @returns {Promise<object>} { ok, host, port, online_count, online_users, history_messages } 或 { error }
 */
export async function probePond({
  host,
  port = 33859,
  viaProxy = false,
  proxy = { host: '127.0.0.1', port: 7897 },
  history = 0,
  timeoutMs = 12000,
  log = () => {},
} = {}) {
  if (!host) return { error: '需要目标鱼塘主机(host)' };
  const wantHistory = Math.max(0, Math.min(30, Number(history) || 0));

  // 昵称被拒(重复/敏感词/风控)时换名重试一次; 其它失败直接返回
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = await probeOnce({ host, port, viaProxy, proxy, wantHistory, timeoutMs, log, attempt });
    if (r.error && attempt === 1 && /登录被拒|昵称重复|昵称不合法|黑名单/.test(r.error)) continue;
    return r;
  }
  return { error: '登录被拒(昵称/风控), 重试后仍失败' };
}

function probeOnce({ host, port, viaProxy, proxy, wantHistory, timeoutMs, log, attempt }) {
  return new Promise((resolve) => {
    const username = makeVisitorName();
    const client = new WsClient({
      host, port,
      proxy,
      direct: !viaProxy,
      username,
      status: 'FISHING',
      heartbeatMs: 25000,
      staleTimeoutMs: 90000,
      replaySkipMs: 2000,
      cmdPrefix: '/x',
      log: (s) => log(`[probe#${attempt}] ${s}`),
    });

    let done = false;
    let loginRejected = '';
    const historyMsgs = [];
    let timer = null;

    const finish = (payload) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { client.stop(); } catch (e) {}
      resolve(payload);
    };

    client.onMessage = (m) => {
      const t = m.type || m.action;
      if (t === 'ONLINE_USERS' && m.body && Array.isArray(m.body.userList)) {
        // 去掉访客自己(服务端把新用户也放进列表)
        const list = m.body.userList
          .filter((u) => u && u.username && u.username !== username)
          .map((u) => ({
            username: u.username,
            status: u.status,
            region: u.shortRegion || '',
            role: u.role || 'USER',
          }));
        finish({
          ok: true,
          host, port, viaProxy,
          online_count: list.length,
          online_users: list,
          history_messages: historyMsgs,
        });
      } else if (t === 'HISTORY_MSG' && m.body && Array.isArray(m.body.msgList)) {
        if (wantHistory > 0) {
          historyMsgs.push(...m.body.msgList.slice(-wantHistory).map((h) => ({
            from: h.user && h.user.username,
            content: h.body && h.body.content,
            time: h.time,
          })));
        }
      } else if (t === 'SYSTEM') {
        const txt = typeof m.body === 'string' ? m.body : (m.body && m.body.content) || '';
        if (/重复|不合法|为空|未获取|黑名单|拒绝/.test(txt)) {
          loginRejected = txt.split('\n')[0];
          finish({ error: `登录被拒: ${loginRejected}` });
        }
      }
    };

    client.runOnce().then((why) => {
      if (done) return;
      if (loginRejected) { finish({ error: `登录被拒: ${loginRejected}` }); return; }
      if (why === 'handshake-fail') finish({ error: 'WS 握手失败: 目标鱼塘不可达(被墙/端口不对/非 WS 服务)' });
      else if (why === 'connect-fail' || why === 'connect-error' || why === 'sock-error') finish({ error: `连接失败(${why}): 目标不可达或代理不通` });
      else if (why !== 'stopped') finish({ error: `连接中断(${why})` });
    });

    timer = setTimeout(() => {
      if (!done) finish({ error: `超时(${timeoutMs}ms): 未在预期时间内拿到在线列表(目标可能拒绝服务)` });
    }, timeoutMs);
  });
}
