// 拉起「草莓小蛋高」agent, 带温柔软妹子人设, 连真实 xechat 测试
// 用法: node spawn-strawberry-cake.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NAME = '草莓小蛋高';
const PREFIX = `/${NAME}`;
const env = {
  ...process.env,
  BOT_USERNAME: NAME,
  CMD_PREFIX: PREFIX,
  // 关键: 覆盖默认李乐儿种子, 用温柔软妹子 seed
  PERSONA_SEED_FILE: path.join(__dirname, 'data', 'persona-strawberry-cake.txt'),
  // 首次启动强制重生成 (忽略任何旧缓存, 用这个新 seed 出最终人设)
  PERSONA_REGEN: '1',
  // 缓存落到独立文件, 不污染主 bot 的 log/persona.json
  PERSONA_CACHE_FILE: path.join(__dirname, 'log', 'persona-strawberry-cake.json'),
  // 人设触发器配置: 平局默认 human (温柔软妹子主导)
  PERSONA_DEFAULT_MODE: 'human',
  // 心情池: casual (暖/轻松/偶尔害羞), 避免默认 sarcastic 给温柔妹子注入"阴阳/冷"情绪
  PERSONA_KIND: 'casual',
  // 关掉跟温柔妹子人设直接冲突的两个机制:
  //   - Rage Mode: 被 @ 后不该去"主动怼别人", 她只会轻轻挡不接茬
  //   - 主动广播: TRIGGER_SYSTEM 全是阴阳/怼话术示例, 跟"不爆粗"人设正面冲突
  //   都关掉 = 纯被动 @ 才回, 100% 走人设腔, 不让通用 prompt 污染声音
  DISABLE_AGGRESSIVE: '1',
  ENABLE_TRIGGER: '0',
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
