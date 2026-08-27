// 本地端到端测试: 抓半导体市值前10 → PIL 画条形图 → sendup.cc 上传 → 打印分享链接
// 验证三件事: 1) 腾讯 API 拉数据 2) PIL 画图(无 ctypes) 3) send_file 二进制流程
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { uploadContent } from '../lib/platform/sendup.mjs';

const PYTHON = process.env.PYTHON_CMD || 'python';
const PNG_PATH = 'C:\\Users\\sysadmin\\AppData\\Local\\Temp\\semicon_chart.png';

// 半导体龙头候选(覆盖设计/制造/设备/材料/封测)
const CODES = [
  '688981', '688256', '688041', '002371', '603501', '688012', '002129',
  '600703', '600745', '688008', '300223', '688120', '688126', '600460',
  '002156', '603986', '002185', '300316', '600584', '688981',
];

const pyCode = `
import urllib.request, ssl, json, sys, re, os
ctx = ssl.create_default_context()
codes = ${JSON.stringify(CODES)}
prefixed = ['sh' + c if c.startswith('6') else 'sz' + c for c in codes]
url = 'https://qt.gtimg.cn/q=' + ','.join(prefixed)
req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0)'})
with urllib.request.urlopen(req, timeout=10, context=ctx) as r:
    data = r.read().decode('gbk', errors='replace')

# 解析: v_sh688981="1~中芯国际~688981~126.28~1.72~1081004984707~..."
rows = []
for line in data.strip().split('\\n'):
    m = re.search(r'v_(\\w+)="(.+)"', line)
    if not m: continue
    f = m.group(2).split('~')
    if len(f) < 46: continue
    try:
        name = f[1]
        price = float(f[3])
        pct = float(f[32])       # 涨跌幅 %
        circulation = float(f[44])  # 流通市值 (亿)
        mktcap = float(f[45])    # 总市值 (亿)
        rows.append((name, price, pct, mktcap, circulation))
    except: pass

# 按市值降序, 按名字去重
seen, top = set(), []
for r in sorted(rows, key=lambda x: -x[3]):
    if r[0] in seen: continue
    seen.add(r[0]); top.append(r)
top = top[:10]

print('TOP10 (name, price, pct%, mktcap_yi):', file=sys.stderr)
for i, (n, p, pc, c, cir) in enumerate(top, 1):
    print(f'  {i:>2}. {n:<10} 价{p:>8.2f} 涨跌{pc:>+6.2f}% 总市值{c:>9.0f}亿 流通{cir:>9.0f}亿', file=sys.stderr)

if not top:
    print('NO_DATA'); sys.exit(2)

# —— PIL 画条形图 ——
from PIL import Image, ImageDraw, ImageFont
W, H = 1000, 620
img = Image.new('RGB', (W, H), (252, 252, 252))
d = ImageDraw.Draw(img)
# 加载系统字体 (微软雅黑, 沙箱白名单放行 truetype); 找不到时回退默认字体
font = None
title_font = None
for font_path in (r'C:\\Windows\\Fonts\\msyh.ttc', r'C:\\Windows\\Fonts\\msyh.ttf', r'C:\\Windows\\Fonts\\simhei.ttf', r'C:\\Windows\\Fonts\\simsun.ttc'):
    try:
        font = ImageFont.truetype(font_path, 18)
        title_font = ImageFont.truetype(font_path, 22)
        break
    except: pass
if not font:
    font = ImageFont.load_default()
    title_font = font

# 标头
d.text((24, 16), 'A股半导体板块总市值前10  2026-08-27', fill=(40,40,40), font=title_font)
d.text((24, 46), '数据来源: 腾讯行情接口 qt.gtimg.cn', fill=(140,140,140), font=font)

max_cap = max(r[3] for r in top)
mx, my = 200, 80
bw_max = W - mx - 100
bh, gap = 38, 12
for i, (name, price, pct, cap, _) in enumerate(top):
    y = my + i * (bh + gap)
    bw = int((cap / max_cap) * bw_max)
    # 涨跌色: 涨 红, 跌 绿, 平 灰 (A股惯例)
    color = (220, 60, 60) if pct > 0 else ((60, 160, 80) if pct < 0 else (140, 140, 140))
    d.rectangle([mx, y, mx + bw, y + bh], fill=color)
    d.text((10, y + 11), f'{i+1:>2}. {name}', fill=(40,40,40), font=font)
    label = f'{cap/1e8:,.0f}亿  ({pct:+.2f}%)'
    d.text((mx + bw + 8, y + 11), label, fill=(80,80,80), font=font)

# X 轴
d.line([(mx, H - 36), (W - 30, H - 36)], fill=(180,180,180))
for f in [0.25, 0.5, 0.75, 1.0]:
    x = mx + int(bw_max * f)
    d.line([(x, H - 40), (x, H - 32)], fill=(180,180,180))
    d.text((x - 22, H - 28), f'{int(max_cap * f / 1e8):,}亿', fill=(140,140,140), font=font)

img.save(r'${PNG_PATH}', 'PNG')
print('SAVED', os.path.getsize(r'${PNG_PATH}'), r'${PNG_PATH}')
print('TOP_JSON', json.dumps([[n, f'{p:.2f}', f'{pc:.2f}', int(c)] for n,p,pc,c,_ in top], ensure_ascii=False))
`;

console.log('=== 步骤 1: Python 抓数据 + PIL 画图 ===');
const r1 = await new Promise((resolve, reject) => {
  const p = spawn(PYTHON, ['-c', pyCode], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  p.stdout.on('data', d => out += d);
  p.stderr.on('data', d => err += d);
  p.on('close', code => resolve({ code, out, err }));
});

console.log('exit code:', r1.code);
if (r1.err) console.log('stderr:\n' + r1.err);
if (r1.code !== 0) { console.log('✗ python 失败'); process.exit(1); }

const savedMatch = r1.out.match(/SAVED (\d+) (.+)/);
const topMatch = r1.out.match(/TOP_JSON (.+)/);
if (!savedMatch || !topMatch) { console.log('✗ 未解析到输出'); process.exit(1); }
const pngPath = savedMatch[2].trim();
const pngSize = parseInt(savedMatch[1]);
const top10 = JSON.parse(topMatch[1]);
console.log(`✓ PNG 已落盘: ${pngPath} (${pngSize} bytes)`);
console.log(`✓ TOP10: ${top10.length} 只`);

console.log('\n=== 步骤 2: sendup.cc 上传 (binary) ===');
const pngBuf = fs.readFileSync(pngPath);
const b64 = pngBuf.toString('base64');
console.log(`PNG buffer: ${pngBuf.length} bytes, base64: ${b64.length} chars`);

const r2 = await uploadContent(b64, {
  filename: '半导体前10.png',
  isBinary: true,
  proxy: { host: '127.0.0.1', port: 7897 },
  log: () => {},
});

if (!r2.success) {
  console.log('✗ 上传失败:', r2.error, '(stage:', r2.stage + ')');
  process.exit(1);
}
console.log('✓ 上传成功');
console.log('  share_url :', r2.share_url);
console.log('  filename  :', r2.original_filename);
console.log('  size      :', r2.file_size, 'bytes');
console.log('  mime      :', r2.mime_type);
console.log('  expires   :', r2.expires_at || '(default 24h)');

console.log('\n=== 总结 ===');
console.log('三步全过: 数据 ✓ 画图 ✓ 上传 ✓');