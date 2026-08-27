// 鱼塘 agent 智能体 —— 文件分享(sendup.cc 三步上传)
// 与 web.mjs 共用 runPython: 走代理, 自动用 Python requests, 与本地工具目录隔离。
//
// 设计: agent 把"聊天中产生的文件内容"以文件形式发出去 ——
//   - LLM 爬到/总结出一篇文章 → 整理成 .md → 发分享链接
//   - LLM 生成截图/图表 → 发 PNG/JPG 链接 (is_binary=true + base64)
//   - LLM 整理代码/数据 → 发 .py/.csv/.json 链接
// 默认按文件名扩展名猜 MIME; 文本 UTF-8, 二进制 base64。
//
// sendup.cc 协议 (三步):
//   1) POST https://sendup.cc/api_get_upload_url.php  →  presigned_url / r2_key / upload_token
//   2) PUT  <presigned_url>  body=<file bytes>       →  Cloudflare R2 直传
//   3) POST https://sendup.cc/api_save_upload.php    →  生成可分享链接
// 安全: Python 沙箱禁环境变量/主机名/CPU 等探测; 文件大小/存在性由 JS 层把关。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { runPython } from './python-runner.mjs';

const API_GET_URL = 'https://sendup.cc/api_get_upload_url.php';
const API_SAVE = 'https://sendup.cc/api_save_upload.php';

// 按扩展名猜 mime(覆盖常见文本/图片/压缩包; 其它兜底 octet-stream)
const MIME_BY_EXT = {
  '.txt': 'text/plain', '.md': 'text/markdown', '.markdown': 'text/markdown',
  '.json': 'application/json', '.xml': 'application/xml', '.yaml': 'application/yaml', '.yml': 'application/yaml',
  '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css',
  '.js': 'application/javascript', '.ts': 'application/typescript', '.py': 'text/x-python',
  '.csv': 'text/csv', '.log': 'text/plain', '.tsv': 'text/tab-separated-values',
  '.pdf': 'application/pdf',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp',
  '.zip': 'application/zip', '.rar': 'application/x-rar-compressed', '.7z': 'application/x-7z-compressed',
  '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.webm': 'video/webm',
};
export function guessMimeType(filename) {
  const ext = path.extname(filename || '').toLowerCase();
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

/**
 * 把 agent 产生的内容上传到 sendup.cc 并返回分享链接。
 * @param {string|Buffer} content 文件内容 (string=UTF-8 文本, 或 base64 字符串当 is_binary=true)
 * @param {object} opts {
 *   filename: string,               // 必填, 文件名(含扩展名, 用于推断 MIME 与展示文件名)
 *   mimeType?: string,             // 强制 MIME, 默认按扩展名猜
 *   isBinary?: boolean,            // content 是否是 base64 编码的二进制, 默认 false
 *   password?: string,             // 访问密码, 留空=无密码
 *   expireMinutes?: number|string, // 链接有效期(分钟), 默认 1440(24h)
 *   lang?: string,                 // 默认 zh-cn
 *   proxy?: {host,port}, timeoutMs?: number, maxBytes?: number, log?: fn
 * }
 */
export async function uploadContent(content, opts = {}) {
  const {
    filename, mimeType,
    isBinary = false,
    password = '', expireMinutes = '1440', lang = 'zh-cn',
    proxy, timeoutMs = 90000,
    maxBytes = 50 * 1024 * 1024,
    log = () => {},
  } = opts;

  if (!filename || typeof filename !== 'string') throw new Error('缺少文件名(filename)');
  if (!/^[\w\-. -￿]+$/.test(filename)) throw new Error('文件名包含非法字符');
  if (content === undefined || content === null) throw new Error('缺少文件内容(content)');

  // 1) 把 content 解码成 bytes
  const buf = isBinary
    ? Buffer.from(String(content), 'base64')
    : Buffer.from(String(content), 'utf8');
  if (buf.length === 0) throw new Error('内容为空, 无法上传');
  if (buf.length > maxBytes) {
    throw new Error(`内容过大(${(buf.length / 1024 / 1024).toFixed(2)}MB), 上限 ${(maxBytes / 1024 / 1024).toFixed(1)}MB`);
  }

  const mime = mimeType || guessMimeType(filename);
  log(`[sendup] 上传准备: ${filename} (${buf.length}B, ${mime}${isBinary ? ', base64' : ''})`);

  // 2) 写到临时文件 (Python 沙箱从绝对路径读)
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yutang-sendup-'));
  const tmpPath = path.join(tmpDir, path.basename(filename));
  try {
    fs.writeFileSync(tmpPath, buf);

    // 3) 走 sendup.cc 三步 (Python 一脚本跑完)
    const proxyUrl = proxy && proxy.port ? `http://${proxy.host}:${proxy.port}` : null;
    const code = [
      'import requests, json, sys',
      'proxy = ' + JSON.stringify(proxyUrl),
      'proxies = {"http": proxy, "https": proxy} if proxy else None',
      'try:',
      '    filepath = ' + JSON.stringify(tmpPath),
      '    filename = ' + JSON.stringify(path.basename(filename)),
      '    filesize = ' + buf.length,
      '    mime_type = ' + JSON.stringify(mime),
      '    password = ' + JSON.stringify(password),
      '    expire_minutes = ' + JSON.stringify(String(expireMinutes)),
      '    lang = ' + JSON.stringify(lang),
      // 1) 拿预签名 URL
      '    r1 = requests.post(' + JSON.stringify(API_GET_URL) + ',',
      '        data={"filename": filename, "filesize": filesize, "mime_type": mime_type},',
      '        proxies=proxies, timeout=30)',
      '    try: j1 = r1.json()',
      '    except Exception: j1 = {"success": False, "error": "非 JSON 响应: " + r1.text[:200]}',
      '    if not j1.get("success"):',
      '        print(json.dumps({"success": False, "stage": "get_url", "status": r1.status_code, "error": j1}, ensure_ascii=False))',
      '        sys.exit(0)',
      '    presigned_url = j1["presigned_url"]',
      '    r2_key = j1["r2_key"]',
      '    upload_token = j1["upload_token"]',
      // 2) PUT 到 R2
      '    with open(filepath, "rb") as f:',
      '        r2 = requests.put(presigned_url, data=f,',
      '            headers={"Content-Type": mime_type}, proxies=proxies, timeout=180)',
      '    if r2.status_code not in (200, 201, 204):',
      '        print(json.dumps({"success": False, "stage": "put_file", "status": r2.status_code,',
      '            "error": (r2.text or "")[:200]}, ensure_ascii=False))',
      '        sys.exit(0)',
      // 3) 落 metadata 拿分享链接
      '    r3 = requests.post(' + JSON.stringify(API_SAVE) + ',',
      '        data={"r2_key": r2_key, "original_filename": filename, "file_size": filesize,',
      '            "mime_type": mime_type, "upload_token": upload_token,',
      '            "password": password, "expire_minutes": expire_minutes, "lang": lang},',
      '        proxies=proxies, timeout=30)',
      '    try: j3 = r3.json()',
      '    except Exception: j3 = {"raw_text": r3.text[:300]}',
      '    share_url = (j3.get("url") or j3.get("share_url") or j3.get("download_url")',
      '        or (j3.get("data") or {}).get("url") or (j3.get("data") or {}).get("share_url"))',
      '    print(json.dumps({"success": True, "stage": "saved",',
      '        "share_url": share_url, "original_filename": filename, "file_size": filesize,',
      '        "mime_type": mime_type, "expires_at": j3.get("expires_at") or j3.get("expire_at"),',
      '        "raw": j3}, ensure_ascii=False))',
      'except Exception as e:',
      '    print(json.dumps({"success": False, "stage": "exception",',
      '        "error": type(e).__name__ + ": " + str(e)[:200]}, ensure_ascii=False))',
    ].join('\n');

    const res = await runPython(code, { timeoutMs, cmd: 'python', maxOutput: 100 * 1024 });
    const last = res.stdout.trim().split('\n').filter(Boolean).slice(-1)[0];
    if (res.exitCode !== 0 && !last) {
      throw new Error('sendup 执行失败: ' + (res.stderr || res.stdout).slice(0, 200));
    }
    let parsed;
    try { parsed = JSON.parse(last); }
    catch (e) { throw new Error('解析 sendup 响应失败: ' + (last || res.stdout).slice(0, 200)); }
    log(`[sendup] 结果: ${JSON.stringify(parsed).slice(0, 200)}`);
    return parsed;
  } finally {
    // 4) 清理临时文件 (无论成功失败)
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }
}