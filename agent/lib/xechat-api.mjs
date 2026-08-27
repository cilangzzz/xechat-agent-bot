// 鱼塘 agent 智能体 —— Xechat 平台 API 客户端
// 查询鱼塘(lesscoding.net)常用功能: 游戏列表 / 游戏详情 / 排行榜。
// 客户端 API 基址: https://dld.lesscoding.net/api/ (无需鉴权, 与注册接口同前缀;
// 注意: manager-api-docs.json 里写的 /xeManager 前缀实际未部署, 真实可用的是 /api/)。
// fetchFn 可注入, 便于离线测试(不产生真实外网流量)。
export class XechatApi {
  constructor({ base = 'https://dld.lesscoding.net', timeoutMs = 12000, fetchFn, log = () => {} } = {}) {
    this.base = base.replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
    this.fetchFn = fetchFn || globalThis.fetch;
    this.log = log;
  }

  async _req(method, path, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const resp = await this.fetchFn(this.base + path, {
        method,
        signal: controller.signal,
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      if (data.code !== 200) throw new Error(data.message || `业务码 ${data.code}`);
      return data.data;
    } finally { clearTimeout(timer); }
  }

  /** 游戏列表 (POST /api/gameInfo/list), keyword 按 name/中文名 模糊过滤 */
  async gameList({ size = 20, keyword = '' } = {}) {
    const data = await this._req('POST', '/api/gameInfo/list', { page: { current: 1, size } });
    let records = (data && data.records) || [];
    if (keyword) {
      const kw = String(keyword);
      records = records.filter((r) =>
        (r.gameName || '').toLowerCase().includes(kw.toLowerCase())
        || (r.gameNameZhCn || '').includes(kw)
        || (r.description || '').includes(kw));
    }
    return records.map((r) => ({
      id: r.id,
      name: r.gameName,
      zhName: r.gameNameZhCn,
      version: r.version,
      status: r.status,          // 1 = 上线
      online: r.status === 1,
      playUrl: r.playUrl,
      categories: (r.categoryNames || []).filter(Boolean).join('、'),
      fileSize: r.fileSize,
    }));
  }

  /** 游戏详情 (支持 id 或英文名), 此接口中文名/描述编码正常 */
  async gameDetail(idOrName) {
    const isId = /^\d+$/.test(String(idOrName));
    const path = isId ? `/api/gameInfo/detail/${idOrName}` : `/api/gameInfo/${encodeURIComponent(idOrName)}`;
    const r = await this._req('GET', path);
    return {
      id: r.id,
      name: r.gameName,
      zhName: r.gameNameZhCn,
      version: r.version,
      status: r.status,
      online: r.status === 1,
      description: r.description,
      categories: (r.categoryNames || []).filter(Boolean).join('、'),
      playUrl: r.playUrl,
      downloadUrl: r.downloadUrl,
      fileSize: r.fileSize,
      updateTime: r.updateTime,
    };
  }

  /** 排行榜 (POST /api/leaderboard/ranking), 需游戏 id */
  async leaderboard({ gameInfoId, rankKey = 'score', limit = 10 } = {}) {
    const data = await this._req('POST', '/api/leaderboard/ranking', { gameInfoId, rankKey, limit });
    if (!Array.isArray(data)) return [];
    return data.map((r, i) => ({
      rank: i + 1,
      username: r.username ?? r.userName ?? r.playerName ?? '?',
      score: r.score ?? r.value ?? r.rankValue ?? null,
      ...(r.nickname ? { nickname: r.nickname } : {}),
    }));
  }
}
