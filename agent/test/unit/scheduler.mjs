// agent 测试 —— [8] Scheduler 定时任务 / [8b] createTrigger 主动消息触发器
import { Scheduler, parseAtTime, parseDuration } from '../../lib/business/scheduler.mjs';
import { createTrigger } from '../../lib/business/trigger.mjs';
import { check } from './_state.mjs';

export async function run() {
  // —— 8. 定时任务处理器 (Scheduler) ——
  console.log('[8] Scheduler 定时任务');
  {
    const fired = [];
    const s = new Scheduler({ enabled: true, tickMs: 100, persist: false });
    s.start((t) => fired.push(t));
    s.add({ atMs: Date.now() + 100000, task: '未来', to: 'u', mode: 'remind' });
    s.tick();
    check('未到期不触发', fired.length === 0);
    s.add({ atMs: Date.now() - 10, task: '现在', to: 'u', mode: 'remind' });
    s.tick();
    check('到期触发', fired.length === 1 && fired[0].task === '现在');
    s.tick();
    check('一次性任务触发后移除', fired.length === 1 && s.size === 1);
    const r = s.add({ atMs: Date.now() + 100000, task: '可取消', to: null });
    check('cancel 成功', s.cancel(r.id) === true);
    check('cancel 后列表为空', s.list().length === 1);
    s.stop();
    check('parseDuration 分钟', parseDuration('5分钟') === 300000);
    check('parseDuration 小时', parseDuration('2小时') === 7200000);
    check('parseDuration 秒', parseDuration('30秒') === 30000);
    check('parseDuration 非法', parseDuration('abc') === null);
    const at = parseAtTime('08:00', new Date('2026-08-26T10:00:00').getTime());
    check('parseAtTime 今天已过→明天', at === new Date('2026-08-27T08:00:00').getTime());
    const at2 = parseAtTime('12:00', new Date('2026-08-26T10:00:00').getTime());
    check('parseAtTime 今天未过→今天', at2 === new Date('2026-08-26T12:00:00').getTime());
    check('parseAtTime 非法', parseAtTime('25:99') === null);
  }

  // —— 8b. 主动消息触发器 (Trigger) ——
  console.log('[8b] createTrigger 每 N 条(非自己)消息触发');
  {
    let logLines = [];
    const t = createTrigger({ enabled: true, threshold: 3, cooldownMs: 5000, log: (s) => logLines.push(s) });
    check('条数未到不触发', t.onMessage({ from: 'a', content: '1' }) === null && t.onMessage({ from: 'a', content: '2' }) === null);
    const batch = t.onMessage({ from: 'a', content: '3' });
    check('每 N 条触发(含同用户多条)', Array.isArray(batch) && batch.length === 3 && batch[2].from === 'a');
    check('窗口已重置', t.getState().windowCount === 0);
    check('触发后进入冷却', t.onMessage({ from: 'd', content: '5' }) === null);
    const t2 = createTrigger({ enabled: true, threshold: 2, cooldownMs: 0 });
    t2.onMessage({ from: 'x', content: '1' });
    const b2 = t2.onMessage({ from: 'x', content: '2' });
    check('同用户多条也算条数', Array.isArray(b2) && b2.length === 2);
    const t3 = createTrigger({ enabled: false, threshold: 2 });
    check('disabled 不触发', t3.onMessage({ from: 'a', content: '1' }) === null && t3.onMessage({ from: 'b', content: '2' }) === null);
  }
}