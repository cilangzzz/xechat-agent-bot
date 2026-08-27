// agent 工具 —— 定时任务 (references: 常规调度器)
// 依赖 ../scheduler.mjs (parseDuration / parseAtTime)
// 依赖 ctx.scheduler (add / list / enabled)
import { defineTool } from '../../foundation/tool-core.mjs';
import * as schedMod from '../scheduler.mjs';

export function buildSchedulerTools(ctx) {
  return [
    defineTool({
      id: 'schedule',
      description: '注册一个一次性定时任务: 到设定时间提醒用户或自动执行。支持 inMinutes(相对时间, 如"5分钟")或 atTime(绝对时间, 如"18:30", 今天已过则明天)。mode=remind 到点直接发提醒文本; mode=auto 到点按 task 内容自动生成回复(可查资料)。',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: '要提醒/执行的内容(或给 auto 模式的指令), 必填' },
          inMinutes: { type: 'string', description: '相对时间, 如 "5分钟" "2小时" "30秒"; 与 atTime 二选一' },
          atTime: { type: 'string', description: '绝对时间 HH:MM(可带秒), 今天已过则明天; 与 inMinutes 二选一' },
          to: { type: 'string', description: '指定接收人(用户名); 不填则到时广播' },
          mode: { type: 'string', enum: ['remind', 'auto'], description: 'remind=到点发文本; auto=到点自动生成再发(默认 remind)' },
        },
        required: ['task'],
      },
      run: async ({ task, inMinutes, atTime, to, mode }, extra) => {
        const sched = ctx.scheduler;
        if (!sched || !sched.enabled) return { error: '定时任务未开启(DISABLE_SCHEDULE=1 会关闭)' };
        let atMs = null;
        if (inMinutes) {
          const ms = schedMod.parseDuration(inMinutes);
          if (ms == null || ms <= 0) return { error: `无法解析相对时间: ${inMinutes}(用"5分钟"/"2小时"/"30秒")` };
          atMs = Date.now() + ms;
        } else if (atTime) {
          atMs = schedMod.parseAtTime(atTime);
          if (atMs == null) return { error: `无法解析时间: ${atTime}(用 HH:MM, 如 18:30)` };
        } else {
          return { error: '需要 inMinutes(相对时间)或 atTime(绝对时间)' };
        }
        const from = extra.from || ctx.from;
        const res = sched.add({ atMs, task, to: to || from || null, mode: mode || 'remind' });
        return { id: res.id, atMs: res.atMs, estimated: new Date(res.atMs).toLocaleString('zh-CN', { hour12: false }), task };
      },
    }),
    defineTool({
      id: 'list_schedules',
      description: '查看所有未到期的定时任务(id/触发时间/内容)',
      parameters: { type: 'object', properties: {} },
      run: async () => {
        const sched = ctx.scheduler;
        if (!sched || !sched.enabled) return { error: '定时任务未开启' };
        const list = sched.list();
        return { count: list.length, tasks: list.map((t) => ({
          id: t.id,
          at: new Date(t.atMs).toLocaleString('zh-CN', { hour12: false }),
          task: t.task, to: t.to, mode: t.mode,
        })) };
      },
    }),
  ];
}