// agent 测试 —— [5] SessionStore 多用户隔离 / token 预算压缩 / tryLock
import { SessionStore } from '../../../lib/business/sessions.mjs';
import { check } from './_state.mjs';

export async function run() {
  console.log('[5] SessionStore 多用户隔离/token预算压缩');
  {
    const s = new SessionStore({ historyMax: 3 });
    for (let i = 0; i < 5; i++) s.pushUser('a', `m${i}`);
    s.pushUser('b', 'other');
    const ha = s.get('a').history, hb = s.get('b').history;
    check('a 未压缩前保留全部', ha.length === 5 && ha[0].content === 'm0');
    check('b 独立', hb.length === 1 && hb[0].content === 'other');
    s.clear('a');
    check('clear 生效', s.get('a').history.length === 0 && s.size === 1);

    const sc = new SessionStore({ historyMax: 3, compressBudgetTokens: 8, summaryMaxLen: 200 });
    for (let i = 0; i < 6; i++) sc.pushUser('c', `msg${i}啊`);
    const compressed = await sc.maybeCompress('c', async (summary, batch) => `已压缩[${batch.length}条]`);
    check('token预算压缩触发', compressed === true);
    const snap = sc.get('c');
    check('摘要已生成', snap.summary.startsWith('已压缩['), `实际: ${snap.summary}`);
    check('压缩后只留最近', snap.history.length >= 3 && snap.history[snap.history.length - 1].content.includes('msg5'));

    const lock = sessionsTryLockCheck(sc);
    check('tryLock 同用户忙时返回 null', lock === null);
  }
}

function sessionsTryLockCheck(store) {
  const rel = store.tryLock('ck');
  const again = store.tryLock('ck');
  if (rel) rel();
  return again; // 应为 null(第一次未释放前)
}