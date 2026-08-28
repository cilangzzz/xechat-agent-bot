// 真实环境联调 —— 鱼塘平台 /api/file/upload 接口
// 流程: 读 .env → 登录(/api/user/login) → 上传(/api/file/upload) → 校验 view_url
//
// 跑法 (在 agent/ 目录):
//   node test/verify-upload-live.mjs
//
// 不改任何生产代码, 只做一次端到端验证。失败时打印完整诊断信息。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// —— 1) 读 .env ——
const envFile = path.join(__dirname, '..', '.env');
if (!fs.existsSync(envFile)) {
  console.error('❌ .env 不存在, 无法联调');
  process.exit(1);
}
for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
  if (!m) continue;
  const [, k, v] = m;
  if (process.env[k] === undefined) process.env[k] = v;
}

const BASE = process.env.XE_API_BASE || 'https://dld.lesscoding.net';
const USERNAME = process.env.XECHAT_API_USERNAME || '';
const PASSWORD = process.env.XECHAT_API_PASSWORD || '';
const AUTH_PATH = process.env.XE_API_AUTH_PATH || '/api/user/login';
const UPLOAD_PATH = process.env.XE_API_UPLOAD_PATH || '/api/file/upload';

console.log('═══════════════════════════════════════════════════════');
console.log('🐟  鱼塘 upload 接口联调 (真实环境)');
console.log('═══════════════════════════════════════════════════════');
console.log(`  base        : ${BASE}`);
console.log(`  username    : ${USERNAME || '(空!)'}`);
console.log(`  auth_path   : ${AUTH_PATH}`);
console.log(`  upload_path : ${UPLOAD_PATH}`);
console.log('');

if (!USERNAME || !PASSWORD) {
  console.error('❌ .env 缺 XECHAT_API_USERNAME/PASSWORD, 不能联调');
  process.exit(1);
}

const UPLOAD_TIMEOUT = 60000; // 鱼塘服务端上传 + MD5 + 落盘实测 20-40s
const API_TIMEOUT = 30000;
const LOGIN_TIMEOUT = 15000;

async function fetchJson(method, url, headers = {}, body, timeoutMs = API_TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method,
      signal: controller.signal,
      headers,
      body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
    });
    const text = await resp.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) {}
    return { status: resp.status, ok: resp.ok, json, text: text.slice(0, 800) };
  } finally { clearTimeout(timer); }
}

// ═══════════════════════════════════════════════════
// Step 1: 登录
// ═══════════════════════════════════════════════════
console.log('─── Step 1: 登录拿 token ───');
const t0 = Date.now();
let loginResp;
try {
  loginResp = await fetchJson('POST', BASE + AUTH_PATH,
    { 'Content-Type': 'application/json' },
    { username: USERNAME, password: PASSWORD },
    LOGIN_TIMEOUT);
} catch (e) {
  console.error(`❌ 登录网络错误: ${e.message || e}`);
  process.exit(2);
}
console.log(`  HTTP ${loginResp.status}  (${Date.now() - t0}ms)`);
if (!loginResp.ok) {
  console.error('❌ 登录 HTTP 非 2xx');
  console.error(loginResp.text);
  process.exit(2);
}
if (!loginResp.json) {
  console.error('❌ 登录响应非 JSON');
  console.error(loginResp.text);
  process.exit(2);
}
console.log(`  响应 code : ${loginResp.json.code}`);
console.log(`  响应 msg  : ${loginResp.json.message || '(无)'}`);
if (loginResp.json.code !== 200) {
  console.error('❌ 登录业务码非 200');
  process.exit(2);
}
const token = loginResp.json.data?.token || loginResp.json.data?.accessToken || loginResp.json.data?.access_token;
if (!token) {
  console.error('❌ 响应里没 token 字段');
  console.error('  data:', loginResp.json.data);
  process.exit(2);
}
console.log(`  ✅ token   : ${token.slice(0, 12)}…  (${token.length} chars)`);
console.log('');

// ═══════════════════════════════════════════════════
// Step 2: 上传文本 (UTF-8, .md)
// ═══════════════════════════════════════════════════
console.log('─── Step 2: 上传文本 (UTF-8) ───');
const textContent = `# upload 接口联调报告

生成时间: ${new Date().toISOString()}
用户名: ${USERNAME}

## 验证项
- [x] 登录拿 token
- [ ] 上传文本 (.md)
- [ ] 上传图片 (.png)
- [ ] view_url 可访问
`;
const boundary = '----XechatVerifyBoundary' + Date.now().toString(36);
function buildMultipart({ content, filename, mime, isBase64 = false, bizType = 'user_avatar' }) {
  // 始终当作二进制字节传, 避免 multipart 内部把 UTF-8 拆 chunk 后 server 端 base64 解码不出
  const bytes = isBase64 ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf8');
  const parts = [];
  parts.push(Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${filename.replace(/[\r\n"]/g, '_')}"\r\n` +
    `Content-Type: ${mime}\r\n\r\n`,
    'utf8'));
  parts.push(bytes);
  parts.push(Buffer.from(
    `\r\n--${boundary}\r\n` +
    `Content-Disposition: form-data; name="bizType"\r\n\r\n` +
    `${bizType}\r\n` +
    `--${boundary}--\r\n`,
    'utf8'));
  return Buffer.concat(parts);
}

async function uploadOnce({ label, content, filename, mime, isBase64, bizType }) {
  console.log(`\n  → ${label}`);
  const body = buildMultipart({ content, filename, mime, isBase64, bizType });
  const t = Date.now();
  let r;
  try {
    r = await fetchJson('POST', BASE + UPLOAD_PATH, {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': String(body.length),
    }, body, UPLOAD_TIMEOUT);
  } catch (e) {
    console.error(`    ❌ 网络错误: ${e.message || e}`);
    return null;
  }
  console.log(`    HTTP ${r.status}  (${Date.now() - t}ms, ${body.length} bytes)`);
  if (!r.json) {
    console.error(`    ❌ 响应非 JSON: ${r.text.slice(0, 200)}`);
    return null;
  }
  console.log(`    code: ${r.json.code}  msg: ${r.json.message || '(无)'}`);
  if (r.json.code !== 200) {
    console.error(`    ❌ 业务码非 200`);
    return null;
  }
  const file = r.json.data || {};
  const viewUrl = `${BASE}/api/file/view/${file.id}`;
  const downloadUrl = `${BASE}/api/file/download/${file.id}`;
  console.log(`    ✅ id        : ${file.id}`);
  console.log(`       fileName  : ${file.fileName}`);
  console.log(`       fileSize  : ${file.fileSize}`);
  console.log(`       mimeType  : ${file.mimeType}`);
  console.log(`       bizType   : ${file.bizType}`);
  console.log(`       md5       : ${file.md5Str || file.md5 || '(无)'}`);
  console.log(`       view_url  : ${viewUrl}`);
  console.log(`       dl_url    : ${downloadUrl}`);
  return { id: file.id, viewUrl, downloadUrl, ...file };
}

// Case A: 文本 .md
const upMd = await uploadOnce({
  label: 'A. UTF-8 文本 .md (user_avatar)',
  content: textContent,
  filename: `verify-${Date.now()}.md`,
  mime: 'text/markdown;charset=utf-8',
  bizType: 'user_avatar',
});

// Case B: 文本 .txt, 走默认 octet-stream (模拟 sendup.mjs)
const upTxt = await uploadOnce({
  label: 'B. UTF-8 文本 .txt (game_icon)',
  content: '这是一段中文 + 一些 emoji 🎉🔥\n\n第二行\n第三行',
  filename: `verify-${Date.now()}.txt`,
  mime: 'text/plain;charset=utf-8',
  bizType: 'game_icon',
});

// Case C: 二进制 PNG (1x1 透明像素)
const tinyPng = Buffer.from([
  0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNG signature
  0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
  0x89, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x44, 0x41,
  0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00,
  0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE,
  0x42, 0x60, 0x82,
]);
const upPng = await uploadOnce({
  label: 'C. 二进制 PNG (1x1 透明, base64)',
  content: tinyPng.toString('base64'),
  filename: `verify-${Date.now()}.png`,
  mime: 'image/png',
  isBase64: true,
  bizType: 'user_avatar',
});

console.log('\n═══════════════════════════════════════════════════════');
console.log('📊 总结');
console.log('═══════════════════════════════════════════════════════');
const ok = (r) => r && r.id ? '✅' : '❌';
console.log(`  ${ok(upMd)}  文本 .md`);
console.log(`  ${ok(upTxt)} 文本 .txt`);
console.log(`  ${ok(upPng)} 图片 PNG`);

// ═══════════════════════════════════════════════════
// Step 3: 用生成的 view_url 反查 /api/file/view
// ═══════════════════════════════════════════════════
if (upMd) {
  console.log('\n─── Step 3: 验证 view_url 可访问 ───');
  console.log(`  → ${upMd.viewUrl}`);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT);
    const r = await fetch(upMd.viewUrl, { method: 'HEAD', signal: controller.signal });
    clearTimeout(timer);
    console.log(`    HTTP ${r.status}, Content-Type: ${r.headers.get('content-type')}, Content-Length: ${r.headers.get('content-length')}`);
    if (r.ok) console.log('    ✅ view_url 可访问');
    else console.log('    ❌ view_url 不可访问');
  } catch (e) {
    console.log(`    ❌ 访问失败: ${e.message || e}`);
  }
}

// ═══════════════════════════════════════════════════
// Step 4: 通过 XechatApi.uploadFile 走完整流程 (确保 7 层包装也 OK)
// ═══════════════════════════════════════════════════
console.log('\n─── Step 4: XechatApi.uploadFile (完整包装层) ───');
const { XechatApi } = await import('../lib/platform/xechat-api.mjs');
// 注意: 构造时要把 .env 里的鉴权信息传进去(脚本场景)
const api = new XechatApi({
  base: BASE,
  timeoutMs: UPLOAD_TIMEOUT,
  username: USERNAME,
  password: PASSWORD,
  authPath: AUTH_PATH,
  uploadPath: UPLOAD_PATH,
});
console.log('  → 调 uploadFile (会自动 login + 上传)');
try {
  const t = Date.now();
  const r = await api.uploadFile({
    content: '# wrapper 联调\n\n测试 XechatApi.uploadFile 包装层',
    filename: `verify-wrapper-${Date.now()}.md`,
    bizType: 'user_avatar',
  });
  console.log(`  ✅ uploadFile 成功 (${Date.now() - t}ms)`);
  console.log(`     id        : ${r.id}`);
  console.log(`     fileName  : ${r.fileName}`);
  console.log(`     view_url  : ${r.view_url}`);
  console.log(`     dl_url    : ${r.download_url}`);
} catch (e) {
  console.error(`  ❌ uploadFile 失败: ${e.message || e}`);
}

console.log('\n✅ 联调结束');
