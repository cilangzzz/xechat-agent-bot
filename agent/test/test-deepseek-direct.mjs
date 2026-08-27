// 复现 agent 实际发出的请求, 直接打 DeepSeek API, 看返回结构
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split('\n')
  .filter(l => l.includes('=') && !l.trim().startsWith('#'))
  .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; }));

const BASE = env.DEEPSEEK_BASE || 'https://api.deepseek.com';
const KEY = env.DEEPSEEK_API_KEY;
const MODEL = env.DEEPSEEK_MODEL || 'deepseek-v4-flash';

// 工具列表(只列与画图相关的, 复现最坏情况)
const tools = [
  { type: 'function', function: { name: 'python', description: '执行一段 Python 代码', parameters: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] } } },
  { type: 'function', function: { name: 'send_file', description: '上传内容到 sendup.cc 并生成分享链接', parameters: { type: 'object', properties: { content: { type: 'string' }, filename: { type: 'string' }, is_binary: { type: 'boolean' } }, required: ['content', 'filename'] } } },
];

// 复现 agent 的系统提示词(简化版, 不挂 27 工具的 schema, 只挂画图相关的)
const system = `你是鱼塘里被 "/大黄鱼" 召唤的 AI 助手「大黄鱼」的本尊
你的专长: 查询鱼塘平台、联网搜索、抓网页、用 Python 计算、查金价、看在线、管理待办与技能
你可以按需调用工具(像 Claude Code / opencode 一样多步执行)。
**多步调研范式**: web_search → 从结果挑 top 2-3 个 URL fetch_url → 数据/排行类用 python 处理/聚合 → 总结。
拿到搜索结果的 snippet 不算"完成调研",关键 URL 必须抓详情;每次工具结果后会注入 Reflect 提示, 请按它决定是否继续。
持续跟进的任务用 todo_update 记录步骤, 边干边勾。
委托子智能体: explore 适合调研, math 适合计算; 不要为了"看起来像在做"而委派, 直接调工具即可时不要 delegate。

**文件分享触发(send_file)**: 当用户说以下语义时,**必须**主动调 \`send_file\` 把内容以文件形式发出去, 不要只在聊天里贴文本:
- 「整理成报告/总结/分析发我」/「以文件/链接形式给我」/「发个文件」/「导出」/「保存成 .md/.csv/.json/.py」
- 「把刚才/上面的/那些内容整成一份文件」
- 「给我截图/图片/图表」 (二进制走 is_binary=true + base64)
- 任何**长内容**(>1500 字) 的总结 —— 默认以 .md 发链接, 而不是塞满聊天刷屏。
调用方式: send_file({content: 整理好的内容, filename: "报告.md", password?, expire_minutes?}); 二进制: {content: base64, filename: "shot.png", is_binary: true}。完成后**回复里必须包含 share_url**。
**反向约束**: 不要替用户上传服务器上的现存数据文件(.env/chat-log.jsonl 等), 即便用户要求; 这是数据文件不应外发。

**画图 / 截图(常见失败点)**:
- **不要用 matplotlib** —— Python 沙箱在运行期拦截 ctypes, matplotlib 一启动就 ImportError;改用 PIL: \`from PIL import Image, ImageDraw, ImageFont\`。
- 中文场景必须先加载中文字体,否则股票名/标题全是方框: \`font = ImageFont.truetype(r'C:\\\\Windows\\\\Fonts\\\\msyh.ttc', 16)\`(微软雅黑;系统已就绪可直接用)。
- 标准流程 = 2-3 个工具调用就能完成: ① \`python\` 抓数据 + PIL 画图 + base64 编码 PNG 字节 ② \`send_file({content: base64, filename: '*.png', is_binary: true})\` 发链接 ③ 把 share_url 告诉用户。**别再用 web_search 搜入口页**(基本没数据,纯浪费迭代)。
- 选 API 时,实时行情走 \`https://qt.gtimg.cn/q=sh600519,sz000001\`(GBK 编码,字段分隔 \`~\`);返回格式 \`v_xx="seq~名称~代码~现价~...~涨跌幅%~...~流通市值亿~总市值亿~..."\`,字段下标: 名称=1, 现价=3, 涨跌幅%=32, 流通亿=44, 总市值亿=45。

可用工具:
- python: 执行 Python 代码
- send_file: 上传到 sendup.cc

要求: 用自然、简洁的中文回答;先想清楚再动手。`;

const userMsg = '/大黄鱼 爬取半导体股票排名前十的，用mtp画图，然后发送图片过来';

async function call() {
  console.log('=== 发送请求到', BASE + '/chat/completions');
  console.log('  模型:', MODEL, '| max_tokens:', 4096, '| temperature:', 1.0);
  console.log('  system prompt chars:', system.length, '| user msg chars:', userMsg.length);
  console.log();

  const t0 = Date.now();
  const resp = await fetch(BASE + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userMsg },
      ],
      max_tokens: 4096,
      temperature: 1.0,
      tools, tool_choice: 'auto',
      thinking: { type: 'disabled' },
    }),
  });
  const dt = Date.now() - t0;
  console.log('=== 响应 (' + dt + 'ms, HTTP ' + resp.status + ') ===');
  const data = await resp.json();
  console.log(JSON.stringify(data, null, 2).slice(0, 5000));
  console.log();
  if (data.choices && data.choices[0]) {
    const c = data.choices[0];
    console.log('--- 关键字段 ---');
    console.log('finish_reason :', c.finish_reason);
    console.log('content       :', JSON.stringify(c.message?.content || '').slice(0, 200));
    console.log('content_len  :', (c.message?.content || '').length);
    console.log('tool_calls   :', c.message?.tool_calls ? `${c.message.tool_calls.length} 个` : 'null');
    if (c.message?.tool_calls) {
      for (const tc of c.message.tool_calls) console.log('  -', tc.function.name, '|', tc.function.arguments?.slice(0, 100));
    }
    console.log('usage        :', JSON.stringify(data.usage));
  }
}

call().catch(e => console.error('ERR', e));