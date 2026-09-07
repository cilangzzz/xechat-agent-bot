// 意图识别单元测试 — 不连真实鱼塘, 用 mock LLM 验证分类 + 路由逻辑
//   node test/test-intent.mjs
import { classifyIntent, INTENT_SYSTEM_PROMPT, intentCache } from '../lib/business/intent.mjs';

/** 假 LLM: 按 user 文本里第一个关键字返回对应标签; 其余返回 'main' */
function makeMockLLM(map) {
  const calls = [];
  return {
    calls,
    async chat(sys, history) {
      const u = history[history.length - 1].content;
      calls.push({ sys, u });
      for (const [k, v] of Object.entries(map)) {
        if (u.includes(k)) return v;
      }
      return 'main';
    },
  };
}

let pass = 0, fail = 0;
function assert(cond, name, info) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${info ? ` — ${info}` : ''}`); }
}

async function main() {
  console.log('\n=== classifyIntent 基础 ===');

  // 1. 空 / 超短 → main
  {
    const llm = makeMockLLM({});
    const r = await classifyIntent('', llm);
    assert(r === 'main', '空文本 → main');
    const r2 = await classifyIntent('x', llm);
    assert(r2 === 'main', '单字符 → main');
    assert(llm.calls.length === 0, '短文本不发 LLM 请求');
  }

  // 2. 基础标签识别
  {
    const llm = makeMockLLM({ 金价: 'query', 天气: 'explore', '2+3': 'math', 五子棋: 'room', 你好: 'chat' });
    const r1 = await classifyIntent('查下今天金价', llm);
    assert(r1 === 'query', '金价 → query');
    const r2 = await classifyIntent('北京天气怎么样', llm);
    assert(r2 === 'explore', '天气 → explore');
    const r3 = await classifyIntent('2+3 等于多少', llm);
    assert(r3 === 'math', '数学 → math');
    const r4 = await classifyIntent('开一个五子棋房间', llm);
    assert(r4 === 'room', '房间 → room');
    const r5 = await classifyIntent('你好啊', llm);
    assert(r5 === 'chat', '问候 → chat');
  }

  // 3. 标签白名单 + 兜底
  {
    const llm = makeMockLLM({});
    const r1 = await classifyIntent('随便说点啥', { ...llm, chat: async () => 'unknown_label' });
    assert(r1 === 'main', '未知标签 → main');
    const r2 = await classifyIntent('随便说点啥2', { ...llm, chat: async () => 'Intent: explore' });
    assert(r2 === 'explore', '带前缀的输出 → 抽取');
    const r3 = await classifyIntent('随便说点啥3', { ...llm, chat: async () => '**math**' });
    assert(r3 === 'math', '带星号的输出 → 抽取');
    const r4 = await classifyIntent('随便说点啥4', { ...llm, chat: async () => '' });
    assert(r4 === 'main', '空 LLM 输出 → main');
  }

  // 4. 异常/超时 → main 兜底
  {
    const llm = { chat: async () => { throw new Error('network'); } };
    const r = await classifyIntent('查金价', llm);
    assert(r === 'main', '异常 → main');
  }
  {
    const llm = { chat: async () => new Promise((r) => setTimeout(() => r('explore'), 99999)) };
    const r = await classifyIntent('查天气', llm, { timeoutMs: 50 });
    assert(r === 'main', '超时 → main');
  }

  // 5. 缓存命中
  {
    intentCache.set('cached-text', 'explore'); // 预先污染缓存
    const llm = makeMockLLM({});
    const r = await classifyIntent('cached-text', llm);
    assert(r === 'explore', '缓存命中');
    assert(llm.calls.length === 0, '缓存命中不发请求');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });