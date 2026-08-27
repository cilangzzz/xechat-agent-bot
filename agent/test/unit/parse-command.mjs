// agent 测试 —— [1] parseCommand (router 里的命令解析)
import { parseCommand } from '../../../lib/business/router.mjs';
import { check } from './_state.mjs';

export async function run() {
  console.log('[1] parseCommand 解析');
  const p = (s) => parseCommand(s, '/小黄鱼');
  check('命中前缀+子命令', p('/小黄鱼 ping').sub === 'ping' && p('/小黄鱼 ping').isCmd);
  check('命中前缀+自由文本', p('/小黄鱼 帮我查下时间').sub === '帮我查下时间');
  check('命中前缀+参数', p('/小黄鱼 help 更多').sub === 'help' && p('/小黄鱼 help 更多').arg === '更多');
  check('未命中前缀', p('今天天气不错').isCmd === false);
  check('恰好等于前缀', p('/小黄鱼').isCmd && p('/小黄鱼').sub === '');
}