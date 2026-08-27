// agent 测试 —— 共享状态 (失败计数器 + check 断言)
// 各测试文件文件 import { check } 用法: check('描述', 条件, 详情)
// 失败条数累加到 state.failures, 由 unit-agent.mjs 汇总退出码
export const state = { failures: 0 };

export function check(name, cond, detail = '') {
  if (cond) console.log(`  ✅ ${name}`);
  else { state.failures++; console.error(`  ❌ ${name} ${detail}`); }
}

export function reset() { state.failures = 0; }