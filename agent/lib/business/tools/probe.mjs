// agent 工具 —— 跨鱼塘探测 (probe_pond): 一次性访客登录目标鱼塘拿在线列表, 只读不发言
// 拒绝探测自己(当前鱼塘看在线用 room_stats)
// 依赖 ctx.host / ctx.port / ctx.proxy, lib/platform/pond-probe.mjs
import { defineTool } from '../../foundation/tool-core.mjs';

export function buildProbeTools(ctx) {
  return [
    defineTool({
      id: 'probe_pond',
      description: `访问其他鱼塘(WebSocket 聊天服务)并获取其在线用户列表(可附最近聊天)。用一次性访客昵称登录目标鱼塘(登录成功服务端即推送完整在线列表), 拿完立即断开, 不发言、不留痕。
已知鱼塘: 充电鸭鱼塘=lesscoding.net:33859(直连可通); 官方鱼塘=xechat.xeblog.cn:33859(域名未备案, 一般被墙返回失败); 当前鱼塘=${ctx.host || '本机'}:${ctx.port || 33859}(本工具拒绝探测自己, 看在线用 room_stats)。
用户说"访问/查询/看一下其他鱼塘/别的鱼塘/别的塘"时使用; 直连失败可带 viaProxy=true 重试。`,
      parameters: {
        type: 'object',
        properties: {
          host: { type: 'string', description: '目标鱼塘主机(域名或IP), 如 lesscoding.net' },
          port: { type: 'integer', description: '目标鱼塘 WS 端口, 默认 33859(即原生端口的 +1)' },
          viaProxy: { type: 'boolean', description: '走本地代理 127.0.0.1:7897 连接(默认 false=直连; 直连失败时可重试开启)' },
          history: { type: 'integer', description: '顺带返回最近聊天消息条数, 默认 0(不需要)' },
        },
        required: ['host'],
      },
      budget: 6000,
      run: async ({ host, port = 33859, viaProxy = false, history = 0 }) => {
        const h = String(host || '').trim();
        if (!h) return { error: '需要目标鱼塘主机(host)' };
        // 拒绝探测自己: 会重复登录制造第二个会话并广播进塘通知; 当前鱼塘用 room_stats 即可
        if (ctx.host && String(ctx.host).trim() === h && (Number(port) || 33859) === Number(ctx.port)) {
          return { error: '那是当前所在鱼塘, 看在线直接用 room_stats 即可, 不必访问' };
        }
        const { probePond } = await import('../../platform/pond-probe.mjs');
        return await probePond({
          host: h,
          port: Number(port) || 33859,
          viaProxy: !!viaProxy,
          proxy: ctx.proxy || { host: '127.0.0.1', port: 7897 },
          history: Number(history) || 0,
        });
      },
    }),
  ];
}