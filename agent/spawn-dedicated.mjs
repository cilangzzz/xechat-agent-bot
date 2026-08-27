// 临时辅助: 拉起一个专属大黄鱼实例 (用法: node spawn-dedicated.mjs <领养人用户名>)
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const owner = process.argv[2];
if (!owner) { console.error('用法: node spawn-dedicated.mjs <领养人>'); process.exit(1); }
const botName = `${owner}的大黄鱼`;
const prefix = `/${owner}的大黄鱼`;
const env = {
  ...process.env,
  BOT_USERNAME: botName,
  OWNER: owner,
  OWNER_PREFIX: prefix,
  CMD_PREFIX: prefix,
  AGENT_LOG: path.join(__dirname, `dedicated_${owner}.log`),
};
const child = spawn(process.execPath, ['agent.mjs'], { cwd: __dirname, env, detached: true, stdio: 'ignore', windowsHide: true });
child.unref();
console.log(`已拉起 "${botName}" (pid ${child.pid})`);