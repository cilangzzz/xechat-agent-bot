// agent 测试 —— [6] python 工具 (真实执行) / [7] makeReplySender 统一发送/分片
import { check } from './_state.mjs';
import { makeRegistry } from './_fixtures.mjs';

export async function run() {
  // —— 6. python 工具 (真实执行, 本地计算不联网) ——
  console.log('[6] python 工具执行');
  {
    const reg = makeRegistry();
    const r1 = await reg.dispatch('python', { code: 'print(1+1)' });
    check('python 计算 1+1', r1.stdout.trim() === '2', `实际: ${JSON.stringify(r1).slice(0, 120)}`);
    const r2 = await reg.dispatch('python', { code: 'print(sum(range(101)))' });
    check('python 求和 0..100', r2.stdout.trim() === '5050');
    const regT = makeRegistry({ python: { cmd: 'python', timeoutMs: 1500 } });
    const r3 = await regT.dispatch('python', { code: 'import time; time.sleep(5); print("x")' });
    check('python 超时终止', r3.timedOut === true, `实际: ${JSON.stringify(r3).slice(0, 120)}`);
  }

  // —— 7. 统一回复发送器 (分片/还原) ——
  console.log('[7] makeReplySender 统一发送/分片');
  {
    const { makeReplySender, splitForMarkdown } = await import('../../lib/business/reply.mjs');
    const sent = [];
    const sendReply = makeReplySender({ send: (c, to) => { sent.push({ c, to }); }, maxLen: 200, chunkDelayMs: 0 });
    await sendReply('短消息', 'u1');
    check('短消息单条发送', sent.length === 1 && sent[0].c === '短消息' && sent[0].to === 'u1');
    sent.length = 0;
    const long = '长'.repeat(500);
    await sendReply(long, 'u2');
    check('超长拆 3 片', sent.length === 3, `实际 ${sent.length}`);
    check('拼接还原(无换行长文)', sent.map((x) => x.c.replace(/^↪ /, '')).join('') === long);
    sent.length = 0;
    await sendReply('a'.repeat(250), 'u3');
    check('续片带 ↪ 前缀', sent.length >= 2 && sent.slice(1).every((s) => s.c.startsWith('↪ ')));
    sent.length = 0;
    await sendReply('', 'u4');
    check('空内容不发送', sent.length === 0);
    await sendReply('😀'.repeat(250), 'u5');
    check('emoji 拆片不崩', sent.length >= 2 && sent.every((x) => Array.from(x.c).length <= 200));

    const md = [
      '## 今日头条热点(2026-08-26)',
      '',
      '**🔥 热度最高(千万级)**',
      '1. **1.03亿恒大债权包14.41万成交**(金融, 热度1479万) — 债权包几乎"白菜价"成交, 引发热议',
      '2. **13岁女孩三天靠AI赚1.8万**(科技, 1338万) — AI 造富话题',
      '3. **一组数据看中国制造硬核成绩单**(1211万) — 中国制造硬核成绩单',
      '',
      '**🌪️ 民生/社会**',
      '6. 台风"沙德尔"实时路径(897万)',
      '7. 德芙致歉声明疑为AI撰写(812万)',
      '',
      '## 来源',
      '- toutiao.com/hot-event/hot-board',
      '- rebang.today / tophub.today',
    ].join('\n');
    const pieces = splitForMarkdown(md, 60);
    check('每片都不超过 60 码点 + 2 续段前缀', pieces.every((p) => Array.from(p).length <= 60));
    const joined = pieces.join('');
    check('拼接还原一致', joined === md, 'pieces=' + pieces.length + ' joined len=' + joined.length + ' md len=' + md.length);
    const hasFullH2 = pieces.some((p) => /^## /.test(p.split('\n').find((l) => /^## /.test(l)) || '__none__'));
    const hasFullLi = pieces.some((p) => p.split('\n').some((l) => /^- /.test(l)));
    check('## 标题行被完整保留(未切碎)', hasFullH2);
    check('- 列表行被完整保留(未切碎)', hasFullLi);
  }
}