// agent 测试 —— Rage Mode (aggressive.mjs) 单元测试
// 覆盖: 触发 / 冷却 / 同人跳过 / 上限 / 过期 / disabled / 续期
import { createAggressiveMode, createHarassmentTracker } from '../../lib/business/aggressive.mjs';
import { check } from './_state.mjs';

export async function run() {
  console.log('[10] Rage Mode');

  // —— 10.1 默认 disabled 不触发 —— //
  {
    const logs = [];
    const ag = createAggressiveMode({ enabled: false, log: (s) => logs.push(s) });
    ag.trigger('mention');
    const r = ag.tick({ from: 'u1', content: 'hi' });
    check('disabled 时 tick 不返回攻击', r === null, `actual: ${JSON.stringify(r)}`);
  }

  // —— 10.2 trigger → tick (固定 rng=0 → 100% 命中 attack) —— //
  {
    const ag = createAggressiveMode({ enabled: true, attackRate: 0.3, cooldownMs: 0, maxAttacks: 8, rng: () => 0 });
    ag.trigger('mention');
    const r = ag.tick({ from: 'u1', content: '今天行情不错' });
    check('trigger 后第一次 tick 返回攻击', r && r.target === 'u1' && r.content.includes('行情'), `actual: ${JSON.stringify(r)}`);
    ag.recordAttack('u1');
  }

  // —— 10.3 cooldownMs 阻尼 (用 clock 注入固定时间) —— //
  {
    let now = 100000;
    const ag = createAggressiveMode({ enabled: true, cooldownMs: 30000, attackRate: 1.0, rng: () => 0, clock: () => now });
    ag.trigger('mention', now);
    ag.recordAttack('u1', now);
    now += 5000;
    const blocked = ag.tick({ from: 'u2', content: 'x' });
    check('冷却期内 tick 返回 null', blocked === null, `actual: ${JSON.stringify(blocked)}`);
    now += 26000; // 总 31s > 30s
    const ok = ag.tick({ from: 'u2', content: 'x' });
    check('冷却过后 tick 返回攻击', ok !== null, `actual: ${JSON.stringify(ok)}`);
  }

  // —— 10.4 同一人不连续 —— //
  {
    const ag = createAggressiveMode({ enabled: true, cooldownMs: 0, attackRate: 1.0, rng: () => 0 });
    ag.trigger('mention');
    ag.tick({ from: 'u1', content: 'a' });
    ag.recordAttack('u1');
    const r = ag.tick({ from: 'u1', content: 'b' });
    check('不连续攻击同一人', r === null, `actual: ${JSON.stringify(r)}`);
    const r2 = ag.tick({ from: 'u2', content: 'c' });
    check('换人可以继续', r2 !== null && r2.target === 'u2', `actual: ${JSON.stringify(r2)}`);
  }

  // —— 10.5 maxAttacks 上限 —— //
  {
    const ag = createAggressiveMode({ enabled: true, cooldownMs: 0, maxAttacks: 2, attackRate: 1.0, rng: () => 0 });
    ag.trigger('mention');
    const r1 = ag.tick({ from: 'u1', content: 'a' }); ag.recordAttack('u1');
    const r2 = ag.tick({ from: 'u2', content: 'b' }); ag.recordAttack('u2');
    const r3 = ag.tick({ from: 'u3', content: 'c' });
    check('maxAttacks=2 第三次 tick 返 null (上限)', r3 === null, `actual: ${JSON.stringify(r3)}`);
    check('maxAttacks=2 第二次仍正常', r2 !== null);
  }

  // —— 10.6 durationMs 过期 —— //
  {
    let now = 100000;
    const ag = createAggressiveMode({ enabled: true, durationMs: 10000, cooldownMs: 0, attackRate: 1.0, rng: () => 0, clock: () => now });
    ag.trigger('mention', now);
    now += 5000;
    const early = ag.tick({ from: 'u1', content: 'a' });
    check('5s 后 tick 仍返回攻击', early !== null);
    ag.recordAttack('u1', now);
    now += 6000; // 总 11s > 10s
    const expired = ag.tick({ from: 'u2', content: 'b' });
    check('durationMs 过期后 tick 返 null', expired === null, `actual: ${JSON.stringify(expired)}`);
  }

  // —— 10.7 trigger 续期 (rage mode 未过期时再次 trigger) —— //
  {
    let now = 100000;
    const ag = createAggressiveMode({ enabled: true, durationMs: 60000, cooldownMs: 0, maxAttacks: 8, attackRate: 1.0, rng: () => 0, clock: () => now });
    ag.trigger('mention', now);
    ag.recordAttack('u1', now);
    now += 30000;
    // 第二次 trigger: 应该续期而不是重置
    ag.trigger('proactive', now);
    const snap = ag.snapshot();
    check('trigger 续期: 攻击计数保留', snap.attacksThisRound === 1, `actual: ${snap.attacksThisRound}`);
    check('trigger 续期: 过期时间已重置', snap.expiresAt > now + 30000, `expiresAt=${snap.expiresAt}, now=${now}`);
  }

  // —— 10.8 rng > attackRate 时不攻击 —— //
  {
    let cnt = 0;
    const ag = createAggressiveMode({ enabled: true, attackRate: 0.5, cooldownMs: 0, rng: () => 0.99 }); // 永远 > 0.5
    ag.trigger('mention');
    for (let i = 0; i < 100; i++) {
      const r = ag.tick({ from: 'u' + i, content: 'x' });
      if (r) cnt++;
    }
    check('rng 永远 > attackRate 时 tick 不触发', cnt === 0, `cnt=${cnt}`);
  }

  // —— 10.9 attackRate 接近 1 时接近全部命中 —— //
  {
    let cnt = 0;
    const ag = createAggressiveMode({ enabled: true, attackRate: 1.0, cooldownMs: 0, rng: () => 0.0001 });
    ag.trigger('mention');
    for (let i = 0; i < 100; i++) {
      const r = ag.tick({ from: 'u' + i, content: 'x' });
      if (r) cnt++;
    }
    check('rng ≈ 0 + attackRate=1 时 100% 命中', cnt === 100, `cnt=${cnt}`);
  }

  // —— 10.10 骚扰计数器 (复读机累加 / 不同内容不计数) —— //
  console.log('[10.10] HarassmentTracker');
  {
    let now = 100000;
    const ht = createHarassmentTracker({ windowMs: 60000, clock: () => now });

    const r1 = ht.record('u1', '叫爹');
    check('首次调用 = 1', r1 === 1, `actual: ${r1}`);

    const r2 = ht.record('u1', '叫爹');
    check('同一内容重复 → 累加', r2 === 2, `actual: ${r2}`);

    const r3 = ht.record('u1', '叫爹');
    check('同一内容再重复 → 累加', r3 === 3, `actual: ${r3}`);

    const r4 = ht.record('u1', '嘬嘬嘬');
    check('同用户不同内容 → 重置 1', r4 === 1, `actual: ${r4}`);

    const r5 = ht.record('u2', '叫爹');
    check('不同用户 → 独立计数', r5 === 1, `actual: ${r5}`);

    // 时间超出窗口
    now += 70000;
    const r6 = ht.record('u1', '叫爹');
    check('窗口过期 → 重置', r6 === 1, `actual: ${r6}`);

    const e = ht.get('u1');
    check('get 返回当前状态', e && typeof e.count === 'number');
    ht.reset('u1');
    check('reset 单用户后清空', ht.get('u1') === null);
  }
}