// 鱼塘 agent 智能体 —— 联网工具 (走代理)
// Node 原生 fetch 不支持 HTTP 代理, 而鱼塘外网需要经代理(7897)访问;
// 因此网络请求统一用 python requests 走代理执行 (用户已授权联网+python)。
// 提供: httpGet(抓URL) / webSearch(Bing搜索) / goldPrice(金价)
import { runPython } from './python-runner.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

function proxyEnv(proxy) {
  if (!proxy || !proxy.port) return '';
  return `proxies={'http':'http://${proxy.host}:${proxy.port}','https':'http://${proxy.host}:${proxy.port}'}`;
}

/** GET 抓取一个 URL, 返回 {status, text} (最多 300KB)。自动处理 GBK/GB2312 等非 UTF-8 站点编码。
 *  请求失败时返回 {status:-1, error: 简短原因}, 不把整段 Traceback 泄漏给模型(避免其反复重试同类型失败)。 */
export async function httpGet(url, { proxy, timeoutMs = 15000, headers = {} } = {}) {
  const proxyStr = proxy && proxy.port ? `http://${proxy.host}:${proxy.port}` : null;
  const secs = Math.max(5, Math.floor(timeoutMs / 1000));
  const code = [
    'import requests, json',
    `proxy = ${JSON.stringify(proxyStr)}`,
    `headers = ${JSON.stringify({ 'User-Agent': UA, Accept: '*/*', ...headers })}`,
    'proxies = {"http": proxy, "https": proxy} if proxy else None',
    'try:',
    '    r = requests.get(' + JSON.stringify(url) + ', headers=headers, timeout=' + secs + ', proxies=proxies)',
    '    raw = r.content',
    '    enc = r.encoding',
    "    if not enc or enc.lower() in ('iso-8859-1', 'ascii'):",
    "        enc = r.apparent_encoding or 'utf-8'",
    '    try:',
    "        text = raw.decode(enc, 'replace')",
    '    except LookupError:',
    "        text = raw.decode('utf-8', 'replace')",
    "    print(json.dumps({'status': r.status_code, 'text': text[:300000]}, ensure_ascii=False))",
    'except Exception as e:',
    "    print(json.dumps({'status': -1, 'error': type(e).__name__ + ': ' + str(e)[:160]}, ensure_ascii=False))",
  ].join('\n');
  const res = await runPython(code, { timeoutMs, maxOutput: 400 * 1024 }); // 网页可能很大, 放宽输出上限
  const last = res.stdout.trim().split('\n').filter(Boolean).slice(-1)[0];
  if (res.exitCode !== 0 && !last) {
    throw new Error('抓取失败: ' + (res.stderr || res.stdout).slice(0, 200));
  }
  try { return JSON.parse(last); }
  catch (e) { throw new Error('解析响应失败: ' + last.slice(0, 120)); }
}

/** Bing 网页搜索 (RSS 模式, 更稳定), 返回 [{title, url, snippet}] */
export async function webSearch(query, { proxy, timeoutMs = 15000, maxResults = 6 } = {}) {
  const q = encodeURIComponent(query);
  // format=rss 走 RSS 输出更稳定; mkt=zh-CN 强制中文市场提升相关性
  const url = `https://www.bing.com/search?q=${q}&format=rss&mkt=zh-CN&setlang=zh-hans`;
  // 走代理偶发限流/网络错误, 重试一次
  let text, status;
  try {
    ({ status, text } = await httpGet(url, { proxy, timeoutMs }));
  } catch (e) {
    ({ status, text } = await httpGet(url, { proxy, timeoutMs }));
  }
  if (status !== 200) throw new Error('搜索 HTTP ' + status);
  const unescape = (s) => String(s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#0*39;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/&#0*0183;/g, '·');
  const results = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(text)) && results.length < maxResults) {
    const it = m[1];
    const title = (it.match(/<title>(.*?)<\/title>/) || [])[1];
    const link = (it.match(/<link>(.*?)<\/link>/) || [])[1];
    const desc = (it.match(/<description>(.*?)<\/description>/) || [])[1];
    if (!title || !link) continue;
    results.push({
      title: unescape(title).trim(),
      url: unescape(link).trim(),
      snippet: unescape(desc).replace(/<[^>]+>/g, '').trim().slice(0, 300),
    });
  }
  if (!results.length) throw new Error('搜索无结果(可能被反爬, 请稍后重试或换关键词)');
  return results;
}

/** 今日金价: gold-api.com (国际 XAU 现货 + 人民币折算) */
export async function goldPrice({ proxy, timeoutMs = 15000 } = {}) {
  const { status, text } = await httpGet('https://api.gold-api.com/price/XAU', { proxy, timeoutMs });
  if (status !== 200) throw new Error('金价 HTTP ' + status);
  let d; try { d = JSON.parse(text); } catch (e) { throw new Error('金价解析失败'); }
  const usdPerOz = Number(d.price);
  const exchange = Number(d.exchangeRate) || 6.7; // XAU 返回的是 USD, 人民币需换算
  // 人民币报价: 走 XAU/CNY 更准, 这里再取一次
  let cnyPerOz = null, updatedAt = d.updatedAt;
  try {
    const r2 = await httpGet('https://api.gold-api.com/price/XAU/CNY', { proxy, timeoutMs });
    const d2 = JSON.parse(r2.text);
    cnyPerOz = Number(d2.price);
    updatedAt = d2.updatedAt || updatedAt;
  } catch (e) { cnyPerOz = usdPerOz * exchange; }
  const TROY_OZ_G = 31.1035;
  return {
    usdPerOz: Math.round(usdPerOz * 100) / 100,
    cnyPerOz: Math.round(cnyPerOz * 100) / 100,
    cnyPerGram: Math.round((cnyPerOz / TROY_OZ_G) * 100) / 100, // 元/克
    exchangeRate: exchange,
    updatedAt,
  };
}
