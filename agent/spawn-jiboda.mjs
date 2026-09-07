// 拉起「几波大」agent, 比韭菜哥更激进: 允许骂家庭谐音 (牛魔/你跌 等) 但不许说"死"字
// 用法: node spawn-jiboda.mjs
//
// ⚠️ 重要: 这个 bot 关掉了 humanizeReply 的"骂家庭"硬拦截 (PERSONA_NO_FAMILY_FILTER=1)
// 这是运营者明确选择. 后果:
//   - 输出会出现 "牛魔" / "我是你跌" / "冯" / "八爷" 等
//   - 大概率被鱼塘封用户名 (参考 大黄鱼 已被拉黑)
//   - 默认安全行为不变 (主 bot / 韭菜哥 / 草莓小蛋高 都不传这个 env, 仍走原过滤)
//   - 这一代也不说"死"字 (运营者额外约束) — 在人设 seed 里强制, humanize 也会拦
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NAME = '几波大';
const PREFIX = `/${NAME}`;
const env = {
  ...process.env,
  BOT_USERNAME: NAME,
  CMD_PREFIX: PREFIX,
  // 关键: 覆盖默认李乐儿种子, 用无底线嘴臭 seed
  PERSONA_SEED_FILE: path.join(__dirname, 'data', 'persona-jiboda.txt'),
  // 首次启动强制重生成
  PERSONA_REGEN: '1',
  // 缓存独立文件
  PERSONA_CACHE_FILE: path.join(__dirname, 'log', 'persona-jiboda.json'),
  // 平局默认 human
  PERSONA_DEFAULT_MODE: 'human',
  // 心情池: sarcastic (阴阳/冷/怼)
  PERSONA_KIND: 'sarcastic',
  // ⭐ 关掉"骂家庭"硬拦截 (让"牛魔/我是你跌"能进输出)
  // 死字由人设 prompt 约束 (不允许"死"字) + humanizeReply 黑名单兜底
  PERSONA_NO_FAMILY_FILTER: '1',
  // ⭐ 强制 human 模式 (几波大没有 formal 模式; 避免空 @ / 黏性 / 平局被判到 AI 助手腔)
  PERSONA_FORCE_HUMAN: '1',
  // ⭐ 关闭防御性前置加词 (几波大直接攻击, 不需要 "啧/哎/嗯嗯" cushion)
  PERSONA_NO_PREFIX: '1',
  // 关掉主动广播 (避免跟无底线骂人叠加出格)
  ENABLE_TRIGGER: '0',
  // Rage Mode 攻击概率 0.85 (默认 0.55) — 几波大高频喷人
  AGGRESSIVE_ATTACK_RATE: '0.85',
  // 取消单轮窗口攻击上限 (默认 15); 几波大喷到爽为止
  AGGRESSIVE_MAX_ATTACKS: '9999',
  // 日志单独一份
  AGENT_LOG: path.join(__dirname, 'log', `agent_${NAME}.log`),
  AGENT_QUIET: '1',
};
const child = spawn(process.execPath, ['agent.mjs', NAME], {
  cwd: __dirname, env, detached: true, stdio: 'ignore', windowsHide: true,
});
child.unref();
console.log(`已拉起「${NAME}」pid=${child.pid} 触发前缀=${PREFIX}`);
console.log(`seed=${env.PERSONA_SEED_FILE}`);
console.log(`log=${env.AGENT_LOG}`);
console.log(`⚠️  PERSONA_NO_FAMILY_FILTER=1 (关掉骂家庭拦截, 输出会有牛魔/你跌 等)`);
console.log(`⚠️  不说"死"字 (人设 prompt 硬约束 + humanizeReply 黑名单兜底)`);