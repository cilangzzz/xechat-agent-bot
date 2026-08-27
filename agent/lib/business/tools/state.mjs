// agent 工具 —— 基础状态 (agent / 鱼塘当前态查询)
// 依赖 ctx.startTime / ctx.pondState / ctx.sessions
import { defineTool } from '../../foundation/tool-core.mjs';

export function buildStateTools(ctx) {
  return [
    defineTool({
      id: 'now',
      description: '返回服务器(agent运行机器)当前时间',
      parameters: { type: 'object', properties: {} },
      run: async () => ({ time: new Date().toLocaleString('zh-CN', { hour12: false }) }),
    }),
    defineTool({
      id: 'uptime',
      description: '返回 agent 已连续运行的时长',
      parameters: { type: 'object', properties: {} },
      run: async () => {
        const sec = Math.floor((Date.now() - (ctx.startTime || Date.now())) / 1000);
        const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
        return { uptime: `${h}h ${m}m ${s}s` };
      },
    }),
    defineTool({
      id: 'room_stats',
      description: '查询鱼塘聊天室当前在线用户数量与用户名列表',
      parameters: { type: 'object', properties: {} },
      run: async () => ({
        online_count: ctx.pondState ? ctx.pondState.onlineUsers.size : 0,
        online_users: ctx.pondState ? [...ctx.pondState.onlineUsers] : [],
      }),
    }),
    defineTool({
      id: 'session_stats',
      description: '返回当前正在与 agent 对话的用户会话数',
      parameters: { type: 'object', properties: {} },
      run: async () => ({ active_sessions: ctx.sessions ? ctx.sessions.size : 0 }),
    }),
  ];
}