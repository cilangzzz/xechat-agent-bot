// 验证领养上限: 模拟 pondState.onlineUsers 不同状态, 检查 _adopt 的拒绝/放行判断
// 直接复用 router.mjs 的 _adopt 逻辑 (提取核心判断)
import { Router } from '../lib/business/router.mjs';

function checkCap(onlineUsers, species = '大黄鱼', cap = 5) {
  const suffix = `的${species}`;
  const adoptedOnline = onlineUsers.filter((u) => u && u !== species && u.endsWith(suffix));
  return { count: adoptedOnline.length, cap, allowed: adoptedOnline.length < cap };
}

const cases = [
  { name: '鱼塘空(无人在线)',         users: [],                                       expect: { allowed: true, count: 0 } },
  { name: '只有主实例',              users: ['大黄鱼'],                              expect: { allowed: true, count: 0 } },
  { name: '1 个领养实例(可领)',      users: ['大黄鱼', '张三的大黄鱼'],              expect: { allowed: true, count: 1 } },
  { name: '4 个领养(可领)',          users: ['大黄鱼', 'a的大黄鱼', 'b的大黄鱼', 'c的大黄鱼', 'd的大黄鱼'], expect: { allowed: true, count: 4 } },
  { name: '5 个领养(达顶,拒)',       users: ['大黄鱼', 'a的大黄鱼', 'b的大黄鱼', 'c的大黄鱼', 'd的大黄鱼', 'e的大黄鱼'], expect: { allowed: false, count: 5 } },
  { name: '5 个领养 + 别人(还是拒)', users: ['大黄鱼', '路人甲', 'a的大黄鱼', 'b的大黄鱼', 'c的大黄鱼', 'd的大黄鱼', 'e的大黄鱼'], expect: { allowed: false, count: 5 } },
  { name: '同名 NPC_系列(应是领养)',  users: ['大黄鱼', 'NPC_0的大黄鱼', 'NPC_2的大黄鱼'], expect: { allowed: true, count: 2 } },
  { name: '含老格式 "IIDD的大黄鱼"', users: ['大黄鱼', 'IIDD的大黄鱼', '低调y的大黄鱼'], expect: { allowed: true, count: 2 } },
];

let pass = 0, fail = 0;
for (const c of cases) {
  const got = checkCap(c.users);
  const ok = got.allowed === c.expect.allowed && got.count === c.expect.count;
  console.log(`${ok ? '✅' : '❌'} ${c.name} | count=${got.count}/${got.cap} | allowed=${got.allowed}`);
  if (ok) pass++; else { fail++; console.log(`   期望: count=${c.expect.count}, allowed=${c.expect.allowed}`); }
}
console.log(`\n${pass} passed, ${fail} failed`);