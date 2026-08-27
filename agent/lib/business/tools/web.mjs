// agent 工具 —— 联网 (Bing 搜索 / URL 抓取 / 金价)
// 依赖 ctx.web / ctx.proxy, lib/platform/web.mjs (动态加载)
import { defineTool } from '../../foundation/tool-core.mjs';

export function buildWebTools(ctx) {
  return [
    defineTool({
      id: 'web_search',
      description: '在互联网上搜索信息(Bing), 返回相关网页的标题/链接/摘要。用于查询新闻、价格、百科等实时信息。',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: '搜索关键词, 中文即可' } },
        required: ['query'],
      },
      budget: 6000,
      run: async ({ query }) => {
        if (!ctx.web?.enabled) return { error: '联网功能已关闭(DISABLE_WEB=1)' };
        const { webSearch } = await import('../../platform/web.mjs');
        const res = await webSearch(String(query || ''), { proxy: ctx.proxy, timeoutMs: ctx.web?.timeoutMs || 15000 });
        return { count: res.length, results: res };
      },
    }),
    defineTool({
      id: 'fetch_url',
      description: '抓取指定 URL 的网页内容(纯文本), 用于读取某篇文章/页面详情。',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: '完整 URL' } },
        required: ['url'],
      },
      budget: 6000,
      run: async ({ url }) => {
        if (!ctx.web?.enabled) return { error: '联网功能已关闭(DISABLE_WEB=1)' };
        const { httpGet } = await import('../../platform/web.mjs');
        const r = await httpGet(String(url || ''), { proxy: ctx.proxy, timeoutMs: ctx.web?.timeoutMs || 15000 });
        const text = String(r.text || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        return { status: r.status, text: text.slice(0, 4000) };
      },
    }),
    defineTool({
      id: 'gold_price',
      description: '查询今日国际金价(美元/盎司)与人民币金价(元/盎司、元/克), 实时数据。',
      parameters: { type: 'object', properties: {} },
      run: async () => {
        if (!ctx.web?.enabled) return { error: '联网功能已关闭(DISABLE_WEB=1)' };
        const { goldPrice } = await import('../../platform/web.mjs');
        return await goldPrice({ proxy: ctx.proxy, timeoutMs: ctx.web?.timeoutMs || 15000 });
      },
    }),
  ];
}