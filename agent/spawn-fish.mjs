// 批量拉起多个"中国鱼类"命名的 agent 进鱼塘
// 用法: node spawn-fish.mjs [数量]
// 默认 10 条鱼, 每条独立进程/独立日志, 错峰 2s 启动降低同源大批量登录被封特征。
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FISHES = [
  // 四大家鱼 + 常见淡水鱼
  '草鱼','鲤鱼','鲢鱼','鲫鱼','青鱼','鳙鱼','鲶鱼','黑鱼','黄颡鱼','翘嘴',
  '白条','鳊鱼','鲮鱼','罗非鱼','鳜鱼','鲈鱼','鳟鱼','虹鳟','哲罗鱼','狗鱼',
  // 海水鱼
  '带鱼','黄花鱼','黄鱼','鲳鱼','鳗鱼','鳕鱼','秋刀鱼','金枪鱼','三文鱼','沙丁鱼',
  '多宝鱼','龙利鱼','鲅鱼','马鲛鱼','比目鱼','石斑鱼','鲷鱼','鲻鱼','海鲈鱼','花鲈',
  '红衫鱼','银鲳','仓鱼','飞鱼','旗鱼','马面鱼','沙尖鱼','龙头鱼','水潺','目鱼',
  // 鲤鱼/观赏/地方名产
  '荷包鲤','镜鲤','锦鲤','金鱼','龙睛','斗鱼','孔雀鱼','红绿灯','宝莲灯','斑马鱼',
  // 更多淡水与小型鱼
  '泥鳅','黄鳝','鲇鱼','塘鲺','乌鳢','银鱼','太湖银鱼','白鲦','餐条','马口鱼',
  '溪哥','宽鳍鱲','鳑鲏','麦穗鱼','棒花鱼','船丁鱼','沙鳅','花鳅','黄鳍','红鳍',
  // 海产补充
  '鲍鱼','鱿鱼','章鱼','墨鱼','海参','海胆','扇贝','生蚝','蛤蜊','蛏子',
  // 更多
  '鱼翅','鱼唇','鱼肚','鱼籽','咸鱼','干鱼','风干鱼','腊鱼','糟鱼','熏鱼',
];
const count = Math.min(parseInt(process.argv[2] || '10', 10) || 10, FISHES.length);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const launched = [];
for (let i = 0; i < count; i++) {
  const name = FISHES[i];
  const env = {
    ...process.env,
    BOT_USERNAME: name,
    CMD_PREFIX: `/${name}`,
    AGENT_LOG: path.join(__dirname, 'log', `fish_${name}.log`),
  };
  const child = spawn(process.execPath, ['agent.mjs', name], { cwd: __dirname, env, detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  launched.push({ name, pid: child.pid });
  console.log(`已拉起「${name}」(pid ${child.pid}) 前缀 /${name}`);
  await sleep(2000); // 错峰, 降低同源批量登录被封风险
}
console.log(`\n共启动 ${launched.length} 条鱼: ${launched.map((l) => `${l.name}(${l.pid})`).join(', ')}`);