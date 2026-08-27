// 鱼塘 agent 智能体 —— Xechat 平台 API 客户端
// 查询鱼塘(lesscoding.net)常用功能: 游戏列表 / 游戏详情 / 排行榜。
// 客户端 API 基址: https://dld.lesscoding.net/api/ (无需鉴权, 与注册接口同前缀;
// 注意: manager-api-docs.json 里写的 /xeManager 前缀实际未部署, 真实可用的是 /api/)。
// fetchFn 可注入, 便于离线测试(不产生真实外网流量)。
export class XechatApi {
  constructor({
    base = 'https://dld.lesscoding.net',
    timeoutMs = 12000,
    fetchFn,
    log = () => {},
    // —— 鉴权/上传(可选; upload_image 工具会用到)——
    username = '',
    password = '',
    authPath = '/api/user/login',
    uploadPath = '/api/file/upload',
    maxUploadBytes = 50 * 1024 * 1024,
  } = {}) {
    this.base = base.replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
    this.fetchFn = fetchFn || globalThis.fetch;
    this.log = log;
    this.username = username;
    this.password = password;
    this.authPath = authPath;
    this.uploadPath = uploadPath;
    this.maxUploadBytes = maxUploadBytes;
    this.token = null; // 登录后填入
  }

  /** 是否已登录(有 token) */
  isLoggedIn() { return !!this.token; }

  /** 登录: POST {authPath}, 返回并缓存 token。username/password 为空时抛错。 */
  async login({ username, password } = {}) {
    const u = username || this.username;
    const p = password || this.password;
    if (!u || !p) throw new Error('XechatApi.login 缺少 username/password(在构造时配置或显式传入)');
    const data = await this._req('POST', this.authPath, { username: u, password: p });
    const token = data && (data.token || data.accessToken || data.access_token);
    if (!token) throw new Error('登录响应无 token 字段');
    this.token = token;
    return token;
  }

  /** 必要时自动登录(给上传工具调用) */
  async _ensureLogin() {
    if (this.token) return this.token;
    return await this.login();
  }

  async _req(method, path, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const baseHeaders = body !== undefined ? { 'Content-Type': 'application/json' } : {};
      const headers = this.token
        ? { ...baseHeaders, Authorization: `Bearer ${this.token}` }
        : baseHeaders;
      const resp = await this.fetchFn(this.base + path, {
        method,
        signal: controller.signal,
        headers,
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

  /** 鱼塘服务器列表 (GET /api/server/list, 公开接口), 返回启用中的鱼塘服务器(名称/地址/端口/版本) */
  async serverList() {
    const data = await this._req('GET', '/api/server/list');
    const list = Array.isArray(data) ? data : (data && data.records) || [];
    return list.map((r) => ({
      id: r.id,
      name: r.name,
      ip: r.ip,
      port: r.port,
      version: r.version,
      status: r.status,
      enabled: r.status === 1, // 1 = 启用中
      sort: r.sort,
      remark: r.remark,
    }));
  }

  /** 上传文件到平台 (multipart/form-data, POST {uploadPath}, 需鉴权)。
   *  content: 文本传 UTF-8 字符串; 二进制先 base64, 传 isBinary=true
   *  bizType: user_avatar(头像) / game_icon(游戏图标) / game_pkg(游戏包), 按 MD5 去重
   *  需先登录(或自动 login)。返回 {id, fileName, filePath, fileSize, mimeType, bizType, md5Str} */
  async uploadFile({ content, filename, bizType = 'user_avatar', isBinary = false, mimeType } = {}) {
    if (!filename) throw new Error('uploadFile 需要 filename');
    if (typeof content !== 'string') throw new Error('uploadFile content 必须是字符串(文本直接传, 二进制先 base64)');
    const bytes = isBinary
      ? Buffer.from(content, 'base64')
      : Buffer.from(content, 'utf8');
    if (bytes.length > this.maxUploadBytes) {
      throw new Error(`文件过大: ${bytes.length} > ${this.maxUploadBytes}(调 maxUploadBytes / 上限)`);
    }
    await this._ensureLogin();
    // 手动构造 multipart/form-data (避免依赖 fetch 的 FormData 处理, 让任意 fetch 实现都能用)
    const boundary = '----XechatApiBoundary' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const mime = mimeType || (isBinary ? 'application/octet-stream' : 'text/plain;charset=utf-8');
    const safeFilename = String(filename).replace(/[\r\n"]/g, '_');
    const parts = [];
    parts.push(Buffer.from(`--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${safeFilename}"\r\n` +
      `Content-Type: ${mime}\r\n\r\n`, 'utf8'));
    parts.push(bytes);
    parts.push(Buffer.from(`\r\n--${boundary}\r\n` +
      `Content-Disposition: form-data; name="bizType"\r\n\r\n` +
      `${bizType}\r\n` +
      `--${boundary}--\r\n`, 'utf8'));
    const body = Buffer.concat(parts);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const resp = await this.fetchFn(this.base + this.uploadPath, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': String(body.length),
        },
        body,
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      if (data.code !== 200) throw new Error(data.message || `业务码 ${data.code}`);
      const file = data.data || {};
      return {
        id: file.id,
        fileName: file.fileName,
        filePath: file.filePath,
        fileSize: file.fileSize,
        mimeType: file.mimeType,
        bizType: file.bizType,
        md5: file.md5Str,
        view_url: `${this.base}/api/file/view/${file.id}`,
        download_url: `${this.base}/api/file/download/${file.id}`,
      };
    } finally { clearTimeout(timer); }
  }
}
