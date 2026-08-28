// 拉起「韭菜哥」agent, 带高攻击性股票老哥人设, 连真实 xechat 测试
// 用法: node spawn-stock-jiucai.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NAME = '韭菜哥';
const PREFIX = `/${NAME}`;
const env = {
  ...process.env,
  BOT_USERNAME: NAME,
  CMD_PREFIX: PREFIX,
  // 关键: 覆盖默认李乐儿种子, 用高攻击性股票老哥 seed
  PERSONA_SEED_FILE: path.join(__dirname, 'data', 'persona-stock-jiucai.txt'),
  // 首次启动强制重生成 (忽略任何旧缓存, 用这个新 seed 出最终人设)
  PERSONA_REGEN: '1',
  // 缓存落到独立文件, 不污染主 bot 的 log/persona.json
  PERSONA_CACHE_FILE: path.join(__dirname, 'log', 'persona-jiucai.json'),
  // 人设触发器配置: 平局默认 human (暴躁老哥主导)
  PERSONA_DEFAULT_MODE: 'human',
  // 日志单独一份, 方便 tail
  AGENT_LOG: path.join(__dirname, 'log', `agent_${NAME}.log`),
  AGENT_QUIET: '1', // 启动后不向控制台吐, 走文件
};
const child = spawn(process.execPath, ['agent.mjs', NAME], {
  cwd: __dirname, env, detached: true, stdio: 'ignore', windowsHide: true,
});
child.unref();
console.log(`已拉起「${NAME}」pid=${child.pid} 触发前缀=${PREFIX}`);
console.log(`seed=${env.PERSONA_SEED_FILE}`);
console.log(`log=${env.AGENT_LOG}`);
