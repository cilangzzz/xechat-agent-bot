// 鱼塘 agent 智能体 —— 每会话待办 (references: opencode session/todo)
// 待办直接挂在 SessionStore 的会话对象上(内存态), 工具层提供 add/list/done/update/delete/clear。
// 状态: pending / in_progress / completed / cancelled(opencode todowrite 风格)。
export const TODO_STATUS = { pending: '待办', in_progress: '进行中', completed: '已完成', cancelled: '已取消' };
const PRIORITY_LABEL = { low: '低', normal: '中', high: '高' };

/** 初始化待办(会话对象需有 todos 字段) */
export function initTodos(sess) {
  if (!Array.isArray(sess.todos)) sess.todos = [];
  return sess.todos;
}

/** 添加一条待办, 返回 {ok, list} 或 {error} */
export function addTodo(sess, text, maxItems = 20, priority = 'normal') {
  const t = String(text || '').trim();
  if (!t) return { error: '待办内容不能为空' };
  const list = initTodos(sess);
  if (list.length >= maxItems) return { error: `待办已达上限(${maxItems}条), 先完成或删除一些吧` };
  list.push({
    id: list.length ? Math.max(...list.map((i) => i.id)) + 1 : 1,
    text: t,
    status: 'pending',
    priority: PRIORITY_LABEL[priority] ? priority : 'normal',
    at: Date.now(),
  });
  return { ok: true, list: formatList(list) };
}

/** 列表展示 */
export function listTodos(sess) {
  const list = initTodos(sess);
  return formatList(list);
}

function formatList(list) {
  if (!list.length) return '(暂无待办)';
  return list
    .map((t, i) => `${i + 1}. [${TODO_STATUS[t.status] || t.status}${t.priority && t.priority !== 'normal' ? '/' + PRIORITY_LABEL[t.priority] : ''}] ${t.text}`)
    .join('\n');
}

/** 按序号(1 起)完成一项(已 completed 再调切回 pending; 否则标 completed) */
export function doneTodo(sess, index) {
  const list = initTodos(sess);
  const n = toIndex(index, list.length);
  if (n < 0) return { error: `序号无效(共 ${list.length} 项)` };
  list[n].status = list[n].status === 'completed' ? 'pending' : 'completed';
  return { ok: true, list: formatList(list) };
}

/** 修改指定项的 status/text/priority(部分更新) */
export function updateTodo(sess, index, patch = {}) {
  const list = initTodos(sess);
  const n = toIndex(index, list.length);
  if (n < 0) return { error: `序号无效(共 ${list.length} 项)` };
  const item = list[n];
  if (patch.status && TODO_STATUS[patch.status]) item.status = patch.status;
  if (typeof patch.text === 'string' && patch.text.trim()) item.text = patch.text.trim();
  if (patch.priority && PRIORITY_LABEL[patch.priority]) item.priority = patch.priority;
  return { ok: true, list: formatList(list) };
}

/** 删除一项 */
export function deleteTodo(sess, index) {
  const list = initTodos(sess);
  const n = toIndex(index, list.length);
  if (n < 0) return { error: `序号无效(共 ${list.length} 项)` };
  list.splice(n, 1);
  return { ok: true, list: formatList(list) };
}

/** 清空 */
export function clearTodos(sess) {
  sess.todos = [];
  return { ok: true, list: '(暂无待办)' };
}

function toIndex(input, len) {
  const n = Number(input);
  return !Number.isFinite(n) || n < 1 || n > len ? -1 : n - 1;
}

/** LLM 用: 结构化视图(给工具结果, 让模型能读) */
export function todosAsJson(sess) {
  return initTodos(sess);
}

/** 从 ctx/extra 解析当前工具调用的目标会话(优先 extra.from, 否则 ctx.from); 用于 todo 工具 */
export function getTodoSession(ctx, extra) {
  const from = (extra && extra.from) || (ctx && ctx.from);
  if (ctx && ctx.sessions && from) return ctx.sessions._get(from);
  return { todos: [] };
}