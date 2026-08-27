// 鱼塘 agent 智能体 —— 单元测试入口 (编排器)
// 各分类测试拆到 test/unit/ 下: parse-command / tools / llm / router / sessions / scheduler / run-scripts
// 运行:  node test/unit-agent.mjs
// 退出码: 任一分类断言失败 → 非 0, 输出失败计数。
import { state } from './unit/_state.mjs';
import { run as runParseCommand } from './unit/parse-command.mjs';
import { run as runTools } from './unit/tools.mjs';
import { run as runLlm } from './unit/llm.mjs';
import { run as runRouter } from './unit/router.mjs';
import { run as runSessions } from './unit/sessions.mjs';
import { run as runScheduler } from './unit/scheduler.mjs';
import { run as runScripts } from './unit/run-scripts.mjs';

await runParseCommand();
await runTools();
await runLlm();
await runRouter();
await runSessions();
await runScheduler();
await runScripts();

if (state.failures) {
  console.error(`\n❌ UNIT FAIL: ${state.failures} 项失败`);
  process.exit(1);
}
console.log('\n✅ UNIT PASS —— agent v2 逻辑验证通过');