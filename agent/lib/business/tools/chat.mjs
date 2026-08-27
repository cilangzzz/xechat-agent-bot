// agent 工具 —— 聊天记录 (内存 recent_messages / 持久 chat_log)
// recent_messages 只看当前连接收到的; chat_log 看持久化日志(含跨重启更早历史)
// 依赖 ctx.pondState.roomLog / ctx.chatLog
import { defineTool } from '../../foundation/tool-core.mjs';

export function buildChatTools(ctx) {
  return [
    defineTool({
      id: 'recent_messages',
      description: '查看当前会话最近收到的聊天消息(仅连接后收到的, 不含历史数据)。用于了解大家刚才在聊什么。',
      parameters: {
        type: 'object',
        properties: { n: { type: 'integer', description: '返回条数, 默认 10, 最多 30' } },
      },
      run: async ({ n = 10 }) => {
        const log = ctx.pondState && ctx.pondState.roomLog;
        const list = Array.isArray(log) && log.length ? log.slice(-Math.min(30, Math.max(1, n || 10))) : [];
        return {
          count: list.length,
          messages: list.map((m) => ({ from: m.from, self: !!m.self, content: m.content, time: m.time })),
        };
      },
    }),
    defineTool({
      id: 'chat_log',
      description: '查看聊天记录日志中最近的消息(持久化到磁盘, 跨重启可查, 含更早的历史)。recent_messages 只查当前连接, 这个查日志。',
      parameters: {
        type: 'object',
        properties: {
          n: { type: 'integer', description: '返回条数, 默认 10, 最多 200' },
          from: { type: 'string', description: '可选: 只看某个用户发的' },
        },
      },
      run: async ({ n = 10, from } = {}) => {
        const cl = ctx.chatLog;
        if (!cl || !cl.enabled) return { error: '聊天记录日志未开启(DISABLE_CHAT_LOG=1 会关闭)' };
        const list = await cl.readRecent(n, { from });
        return { count: list.length, total: cl.count(), messages: list };
      },
    }),
  ];
}