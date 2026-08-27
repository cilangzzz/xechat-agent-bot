// agent 工具 —— 待办 (references: opencode session/todo)
// 依赖 ../todo.mjs (helpers: getTodoSession, todosAsJson, addTodo, doneTodo, ...)
// 依赖 ctx.todo.maxItems
import { defineTool } from '../../foundation/tool-core.mjs';
import * as todoMod from '../todo.mjs';

export function buildTodoTools(ctx) {
  return [
    defineTool({
      id: 'todo_list',
      description: '查看当前用户会话的待办清单(id/状态/内容)',
      parameters: { type: 'object', properties: {} },
      run: async (_a, extra) => {
        const sess = todoMod.getTodoSession(ctx, extra);
        return { items: todoMod.todosAsJson(sess) };
      },
    }),
    defineTool({
      id: 'todo_update',
      description: `创建/维护一份结构化任务清单, 用于多步调研/任务的规划与跟踪(参考 opencode todowrite)。

## 何时使用
- 任务包含 ≥3 个独立步骤(不仅仅是 3 次同类工具调用)
- 复杂调研/任务, 先写步骤再动手
- 用户给了多项任务或编号列表

## 何时不用
- 单一简单任务或闲聊, 跟踪无价值

## 状态
- pending / in_progress(同时只能 1 条) / completed / cancelled

## 规则
- 动手前先把当前步骤标为 in_progress, 完成立刻勾 completed(**不批量**)
- 完成需含验证(看到结果), 不靠"意图"
- 遇到阻塞 → 保持 in_progress 并加一条 follow-up todo 描述阻塞原因
- 持续多步调用 ≥2 个不同类型工具 才算"已调研"

action: add(新增)/done(完成或取消完成 by 序号)/update(修改状态/优先级/文本 by 序号)/delete(删除)/clear(清空)`,
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['add', 'done', 'update', 'delete', 'clear'], description: '操作类型' },
          text: { type: 'string', description: 'action=add 时的待办内容' },
          index: { type: 'integer', description: 'action=done/update/delete 时的序号(从 1 开始)' },
          status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled'], description: 'action=update 时的目标状态' },
          priority: { type: 'string', enum: ['low', 'normal', 'high'], description: 'action=add/update 时的优先级' },
        },
        required: ['action'],
      },
      budget: 4000,
      run: async ({ action, text, index, status, priority }, extra) => {
        const sess = todoMod.getTodoSession(ctx, extra);
        const max = ctx.todo?.maxItems || 20;
        let r;
        if (action === 'add') r = todoMod.addTodo(sess, text, max, priority);
        else if (action === 'done') r = todoMod.doneTodo(sess, index);
        else if (action === 'update') r = todoMod.updateTodo(sess, index, { text, status, priority });
        else if (action === 'delete') r = todoMod.deleteTodo(sess, index);
        else if (action === 'clear') r = todoMod.clearTodos(sess);
        else return { error: `未知操作: ${action}` };
        return r.error ? { error: r.error } : { list: r.list };
      },
    }),
  ];
}