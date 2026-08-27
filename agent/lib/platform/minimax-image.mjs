// 鱼塘 agent 智能体 —— MiniMax 图片生成 (image-01, 文生图 / 图生图)
// 参考: H:\Documents\software-dev-ai-workflow\0.0-通用skill\docs-minimax-docs\图片生成.md
//
// 接口:
//   POST https://api.minimaxi.com/v1/image_generation
//   Authorization: Bearer ${MINIMAX_API_KEY}
//   body:
//     { "model": "image-01",
//       "prompt": "<text>",
//       "aspect_ratio": "1:1" | "16:9" | "4:3" | "3:2" | "2:3" | "3:4" | "9:16" | "21:9" | ...,
//       "response_format": "base64" | "url",
//       "subject_reference": [ { "type": "character", "image_file": "<url>" } ]  // 可选, 图生图
//     }
//   response:
//     { "data": { "image_base64": ["..."] | "image_urls": ["..."] } }
//     或 { "base_resp": { "status_code": non-2xx, "status_msg": "..." } } 表示错误
//
// 实现: 走 Node 原生 fetch(>=18), 不用 python 沙箱 ——
//   python-runner.mjs 的 prelude 会清空 os.environ, 无法传 API key;
//   MiniMax (api.minimaxi.com) 国内可直连, 默认不走代理。
// 返回 image_base64 数组; 工具层负责传给 upload_image 上传到鱼塘。

const DEFAULT_BASE = 'https://api.minimaxi.com';
const DEFAULT_MODEL = 'image-01';
// 常见比例 (官方文档示例只列了 16:9; 这里给常用值供 LLM 选择, 实际传字符串原样转发)
const ASPECT_RATIOS = ['1:1', '16:9', '4:3', '3:2', '2:3', '3:4', '9:16', '21:8'];

/**
 * 构造 MiniMax 图片生成客户端
 * @param {object} opts
 * @param {string} [opts.apiKey]      Bearer token (MINIMAX_API_KEY)
 * @param {string} [opts.base]        API 前缀, 默认 https://api.minimaxi.com
 * @param {number} [opts.timeoutMs]   请求超时(毫秒), 默认 60s
 * @param {object} [opts.proxy]       预留: 未来可接入代理 (当前 MiniMax 国内直连, 未使用)
 * @param {function} [opts.log]       日志
 */
export function createImageGenerator(opts = {}) {
  const apiKey = opts.apiKey || '';
  const base = (opts.base || DEFAULT_BASE).replace(/\/+$/, '');
  const timeoutMs = Number(opts.timeoutMs) || 60000;
  const log = opts.log || (() => {});

  return {
    enabled: !!apiKey,
    base,
    model: DEFAULT_MODEL,
    aspectRatios: ASPECT_RATIOS,

    /**
     * 生成图片 (文生图 / 图生图)
     * @param {object} args
     * @param {string} args.prompt              文本描述 (必填, 非空)
     * @param {string} [args.aspectRatio]       比例, 默认 "1:1"
     * @param {string} [args.referenceImageUrl] 图生图参考图 URL (http(s))
     * @param {string} [args.model]            模型名, 默认 image-01
     * @returns {Promise<{success, image_base64?, mime_type?, count, model, aspect_ratio, raw?, error?}>}
     */
    async generate({ prompt, aspectRatio, referenceImageUrl, model } = {}) {
      if (!apiKey) return { success: false, error: 'MiniMax API Key 未配置(.env MINIMAX_API_KEY)' };
      const text = String(prompt || '').trim();
      if (!text) return { success: false, error: '需要 prompt(文本描述)' };

      const payload = {
        model: String(model || DEFAULT_MODEL),
        prompt: text,
        aspect_ratio: String(aspectRatio || '1:1'),
        response_format: 'base64',
      };
      if (referenceImageUrl) {
        const url = String(referenceImageUrl).trim();
        if (!/^https?:\/\//i.test(url)) return { success: false, error: 'referenceImageUrl 必须为 http(s) URL' };
        payload.subject_reference = [{ type: 'character', image_file: url }];
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        let resp;
        try {
          resp = await fetch(`${base}/v1/image_generation`, {
            method: 'POST',
            signal: controller.signal,
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify(payload),
          });
        } catch (e) {
          const why = e.name === 'AbortError' ? `超时(${timeoutMs}ms)` : `网络错误`;
          return { success: false, error: `请求失败: ${why} — ${e.message || e}` };
        }
        let body = null;
        try { body = await resp.json(); } catch (_) { body = null; }
        if (!body) {
          const raw = await resp.text().catch(() => '');
          return { success: false, error: `响应非 JSON (HTTP ${resp.status})`, raw: raw.slice(0, 500) };
        }
        if (resp.status >= 400) {
          const br = body.base_resp || {};
          return {
            success: false,
            error: `MiniMax API 返回 HTTP ${resp.status}: ${br.status_msg || body.message || ''}`.trim(),
            raw: body,
          };
        }
        const data = body.data || {};
        const list = Array.isArray(data.image_base64) ? data.image_base64 : [];
        if (!list.length) {
          return { success: false, error: 'MiniMax 返回空图片数组', raw: body };
        }
        return {
          success: true,
          image_base64: list,          // 数组 (通常 1 张)
          primary: list[0],            // 主图, 方便工具层直接取
          mime_type: 'image/jpeg',     // MiniMax 默认输出 JPEG (官方示例写 .jpeg)
          count: list.length,
          model: payload.model,
          aspect_ratio: payload.aspect_ratio,
          raw_status: resp.status,
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}