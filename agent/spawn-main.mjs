// 拉起主大黄鱼实例 (用法: node spawn-main.mjs)
// 不传 login 名, 让 agent 从 .env 读 BOT_USERNAME
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const agentDir = path.dirname(fileURLToPath(import.meta.url));
const child = spawn(process.execPath, ['agent.mjs'], {
  cwd: agentDir,
  env: process.env,
  detached: true,
  stdio: 'ignore',
  windowsHide: true,
});
child.unref();
console.log(`launched main pid=${child.pid}`);