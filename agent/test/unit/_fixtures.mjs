// agent 测试 —— 共享 fake: fakeApiFetch + makeRegistry
// fakeApiFetch: 模拟 Xechat 平台 API (游戏列表/详情/排行榜)
// makeRegistry: 快速构造一个 ToolRegistry, 带在线用户 + 假 api + 默认子能力配置
import { createRegistry } from '../../lib/business/tools/index.mjs';
import { SessionStore } from '../../lib/business/sessions.mjs';
import { XechatApi } from '../../lib/platform/xechat-api.mjs';
import { SkillRegistry } from '../../lib/business/skill-registry.mjs';
import { getBuiltinSkills } from '../../lib/business/skills.mjs';

export function fakeApiFetch(url) {
  const respond = (obj) => ({ ok: true, json: async () => obj });
  if (url.includes('/api/gameInfo/list')) {
    return Promise.resolve(respond({ code: 200, message: 'success', data: { records: [
      { id: 1, gameName: 'demo', gameNameZhCn: '演示', version: '1.0.0', status: 1, playUrl: 'http://demo', categoryNames: ['休闲'] },
    ], total: 1 } }));
  }
  if (url.includes('/api/gameInfo/detail/') || /\/api\/gameInfo\/[^/]+$/.test(url)) {
    return Promise.resolve(respond({ code: 200, message: 'success', data: { id: 1, gameName: 'demo', gameNameZhCn: '演示', version: '1.0.0', status: 1, description: '演示游戏', categoryNames: ['休闲'], playUrl: 'http://demo', downloadUrl: '/api/file/download/1' } }));
  }
  if (url.includes('/api/leaderboard/ranking')) {
    return Promise.resolve(respond({ code: 200, message: 'success', data: [{ username: 'alice', score: 100 }, { username: 'bob', score: 90 }] }));
  }
  return Promise.resolve(respond({ code: 500, message: 'no fake route: ' + url, data: null }));
}

export function makeRegistry(extra = {}) {
  // 构造一个本地 SkillRegistry (builtin 同步装载), 给 skill_* 工具用
  const skillRegistry = new SkillRegistry({
    builtinSkills: getBuiltinSkills(),
    dataDir: null, // 测试不扫盘
    remoteUrls: [],
  });
  for (const [name, info] of getBuiltinSkills()) {
    skillRegistry._all.set(name, { ...info, source: 'builtin' });
  }
  return createRegistry({
    startTime: Date.now(),
    pondState: { onlineUsers: new Set(['a', 'b']) },
    sessions: new SessionStore({}),
    api: new XechatApi({ base: 'https://fake', fetchFn: fakeApiFetch }),
    python: { cmd: 'python', timeoutMs: 10000 },
    web: { enabled: true },
    skills: { enabled: true, registry: skillRegistry, dataDir: null, maxContentChars: 8000, grepLimit: 100 },
    todo: { maxItems: 20 },
    ...extra,
  });
}