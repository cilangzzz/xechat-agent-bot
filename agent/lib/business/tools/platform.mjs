// agent 工具 —— 鱼塘平台 (走 XechatApi: 游戏 / 详情 / 排行 / 服务器列表 / 文件上传)
// 依赖 ctx.api (lib/platform/xechat-api.mjs)
import { defineTool } from '../../foundation/tool-core.mjs';

export function buildPlatformTools(ctx) {
  return [
    defineTool({
      id: 'games',
      description: '查询鱼塘游戏列表(可带关键字过滤), 返回每个游戏的名字/版本/是否上线/分类/playUrl',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '按游戏名(英文或中文)模糊过滤, 可选' },
          size: { type: 'integer', description: '返回条数, 默认 10' },
        },
      },
      run: async ({ keyword = '', size = 10 }) => {
        const list = await ctx.api.gameList({ size, keyword });
        return { total: list.length, games: list.map((g) => ({
          name: g.name, zhName: g.zhName, version: g.version, online: g.online,
          categories: g.categories, playUrl: g.playUrl,
        })) };
      },
    }),
    defineTool({
      id: 'game_detail',
      description: '查询某个游戏的详细信息(传 id 或英文名), 返回中文名/版本/描述/分类/播放与下载地址',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'integer', description: '游戏 id (优先)' },
          name: { type: 'string', description: '游戏英文名' },
        },
      },
      run: async ({ id, name }) => {
        if (id === undefined && !name) return { error: '需要 id 或 name 参数' };
        return await ctx.api.gameDetail(id ?? name);
      },
    }),
    defineTool({
      id: 'leaderboard',
      description: '查询某个游戏的排行榜(需要游戏id), 返回排名/用户名/分数',
      parameters: {
        type: 'object',
        properties: {
          gameInfoId: { type: 'integer', description: '游戏 id, 必填' },
          limit: { type: 'integer', description: '返回条数, 默认 10' },
        },
      },
      run: async ({ gameInfoId, limit = 10 }) => {
        if (gameInfoId === undefined) return { error: '需要 gameInfoId 参数' };
        return { count: 0, ranking: await ctx.api.leaderboard({ gameInfoId, limit }) };
      },
    }),
    defineTool({
      id: 'server_list',
      description: '查询鱼塘平台当前启用的服务器(鱼塘)列表: 名称/地址(ip)/端口/版本。用户问"有哪些鱼塘/几个鱼塘/怎么连鱼塘"时用。',
      parameters: { type: 'object', properties: {} },
      run: async () => {
        const list = await ctx.api.serverList();
        return {
          total: list.length,
          servers: list.map((s) => ({
            name: s.name, ip: s.ip, port: s.port, version: s.version,
            enabled: s.enabled, remark: s.remark,
          })),
        };
      },
    }),
    defineTool({
      id: 'upload_image',
      description: `把 agent 在聊天里产生的内容(截图/图表等二进制, 或文本 .md/.csv 等)上传到鱼塘平台 /api/file/upload(走 multipart/form-data, 需登录)。
**核心语义**: 传 **content(内容)**,不是 file_path(本地路径)。图片/二进制先 base64 编码再传 is_binary=true;文本直接传 UTF-8。

**何时使用**
- LLM 生成截图/图表(PNG/JPG, base64 后传) → 拿 markdown 字段贴聊天(见下)
- LLM 整理的长内容 / 代码片段 / 数据 → 上传后给下载链接
- 用户说"发我一份文件/把刚才整理成文件"

**何时不用**
- 内容 > 上限(默认 50MB, XE_API_MAX_UPLOAD_BYTES 调)
- 私密文件(密码/密钥/.env/chat-log.jsonl 等) → 反向约束, 不要上传
- 没配 XECHAT_API_USERNAME/PASSWORD(管理员需在 .env 填)

**返回**:
- 图片(is_binary=true + 图片 MIME): {success, view_url, markdown, ...} — **把 markdown 字段(如 \`![图片](https://...)\`)原样发到聊天**, 鱼塘 webview 会内联渲染图片, 不要自己再构造 <a href> 或别的格式
- 文本/其它: {success, view_url, download_url, link, ...} — 把 link 字段(\`[filename](download_url)\`)发到聊天, 用户点下载`,
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: '文件内容: 文本传 UTF-8; 二进制(截图等)先编码成 base64 + is_binary=true' },
          filename: { type: 'string', description: '文件名, 含扩展名(如 "screenshot.png"/"分析.md"), 必填' },
          is_binary: { type: 'boolean', description: 'content 是否是 base64 编码的二进制(默认 false = UTF-8 文本)' },
          bizType: { type: 'string', enum: ['user_avatar', 'game_icon', 'game_pkg'], description: '业务类型: user_avatar=头像(MD5 去重), game_icon=游戏图标, game_pkg=游戏包。默认 user_avatar' },
          mime_type: { type: 'string', description: '可选: 强制 MIME(如 "image/png"), 不传按 filename 扩展名猜' },
        },
        required: ['content', 'filename'],
      },
      budget: 8000,
      run: async ({ content, filename, is_binary, bizType, mime_type }, extra) => {
        const api = ctx.api;
        if (!api) return { error: 'XechatApi 未注入(tools.mjs ctx.api)' };
        let r;
        try {
          r = await api.uploadFile({
            content: String(content || ''),
            filename: String(filename),
            isBinary: !!is_binary,
            bizType: bizType || 'user_avatar',
            mimeType: mime_type || undefined,
          });
        } catch (e) {
          return { error: '上传失败: ' + (e.message || e) };
        }
        const isImage = !!(is_binary && (
          /^image\//.test(mime_type || '')
          || /^image\//.test(r.mimeType || '')
          || /^image\//.test(guessMime(filename))
        ));
        const fn = String(filename || '');
        if (isImage && r.view_url) {
          return {
            success: true,
            ...r,
            markdown: `![${fn}](${r.view_url})`,   // 预格式化的 markdown 图片, LLM 原样发到聊天
            link: `[${fn}](${r.view_url})`,
            render_hint: 'image',
          };
        }
        return {
          success: true,
          ...r,
          link: `[${fn}](${r.download_url || r.view_url})`,  // 非图片用 markdown 链接
          render_hint: 'file',
        };
      },
    }),
  ];
}

// 简易 MIME 探测 (与 sendup.mjs 同款, 避免循环依赖)
const MIME_BY_EXT = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml',
};
function guessMime(filename) {
  const m = /\.([a-z0-9]+)$/i.exec(String(filename || ''));
  return (m && MIME_BY_EXT['.' + m[1].toLowerCase()]) || '';
}