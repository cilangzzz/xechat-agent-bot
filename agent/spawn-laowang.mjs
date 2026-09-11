// 拉起「老王10月回本」agent — 玩世不恭的中年打工人 + 重仓梭哈散户, 比几波大收敛, 比韭菜哥草根
// 用法: node spawn-laowang.mjs
//
// 人设: 短句 ≤10 字为主, 「待到秋来十月八」「明日可期」「淦你娘」「沃斯泥巴巴」
// 不开家庭红线 (跟几波大比); 骂人上限是「淦你娘」/「沃斯泥巴巴」/「擦」, 不说「草你妈」
// 对 bot 有 meta 视角, 会品评 bot, 也会撩 bot (叫爸爸 / 假装我女朋友 / 骂我一句)
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NAME = process.env.LAOWANG_NAME || '老王10月回本';
const PREFIX = `/${NAME}`;
const env = {
  ...process.env,
  BOT_USERNAME: NAME,
  CMD_PREFIX: PREFIX,
  // 关键: 覆盖默认李乐儿种子, 用老王 persona seed
  PERSONA_SEED_FILE: path.join(__dirname, 'data', 'persona-laowang.txt'),
  // 首次启动强制重生成
  PERSONA_REGEN: '1',
  // 缓存独立文件
  PERSONA_CACHE_FILE: path.join(__dirname, 'log', 'persona-laowang.json'),
  // 平局默认 human (老王主导, 偶尔 formal)
  PERSONA_DEFAULT_MODE: 'human',
  // 心情池: cold (老王是「冷/散漫/玩世不恭」型, 不走 casual 也不走 sarcastic 阴阳)
  // 老王的核心情绪是 *无所谓 + 偶尔上头*, 最贴近 cold pool (躺平/冷漠)
  PERSONA_KIND: 'cold',
  // ❌ 不开 PERSONA_NO_FAMILY_FILTER — 老王不上头到「cao你🐎啊」那种程度, 他的上限是「淦你娘」, 默认 humanize 兜底够用
  // ⭐ 强制 human 模式 (老王没有 formal 模式; 避免空 @ / 黏性 / 平局被判到 AI 助手腔)
  PERSONA_FORCE_HUMAN: '1',
  // ❌ 不开 PERSONA_NO_PREFIX — 老王虽然不带前置, 但 humanizeReply 的「啧/哎/嗯嗯」cushion 跟 *不骂* 人设不冲突; 关掉反而可能让回复过冲
  // Rage Mode 关掉 — 老王不主动怼别人, 他是 *被动撩 bot* / *冷眼聊天*, 不主动攻击
  DISABLE_AGGRESSIVE: '1',
  // 主动广播关掉 (避免跟老王「冷/散漫」人设冲突)
  ENABLE_TRIGGER: '0',
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
console.log(`⚠️  老王 persona: 玩世不恭中年股民, 短句 ≤10 字, 招牌「待到秋来十月八」「明日可期」「淦你娘」「沃斯泥巴巴」`);
console.log(`⚠️  老王不上头到「cao你🐎啊」, 默认 humanize 兜底保留 (不需要 PERSONA_NO_FAMILY_FILTER)`);