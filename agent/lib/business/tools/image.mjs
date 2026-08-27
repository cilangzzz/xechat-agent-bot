// agent 工具 —— AI 图片生成 (MiniMax image-01, 文生图 / 图生图)
// 参考 H:\Documents\software-dev-ai-workflow\0.0-通用skill\docs-minimax-docs\图片生成.md
//
// 设计: **一站式生成 + 上传**, 直接把 view_url 回给 LLM。
//   旧版尝试返回 base64 让 LLM 再调 upload_image, 但 100~400KB 的 base64 经过 LLM context
//   会触发输出截断 + 上下文污染, 实测 LLM 会"丢失"传成空参数。
//   现在: generate_image 内部调 ctx.api.uploadFile, 只回 view_url/download_url 给 LLM, LLM 只需贴聊天。
import { defineTool } from '../../foundation/tool-core.mjs';

export function buildImageTools(ctx) {
  return [
    defineTool({
      id: 'generate_image',
      description: `调用 MiniMax image-01 生成图片(文生图 / 图生图), **自动上传到鱼塘**并返回 view_url, LLM 拿到后直接把 URL 贴聊天即可, 不需要再调 upload_image。

**何时使用**
- 用户说"画一张/生成一张/画图/做个图/配张图/示意图/封面/头像/上传图片"
- 用户给一段描述要可视化(如"配张赛博朋克风的城市夜景"——描述里给细节越多效果越好)
- 配图/封面/演示场景图

**何时不用**
- 要精确数据图表/统计图 —— 用 compute (python matplotlib) 算 + 画, 再 upload_image
- 截图/UI 复用 —— 用 compute (python PIL) 或外部截图工具
- 没配 MINIMAX_API_KEY(.env 留空即不可用, 会返回明确错误)
- 没注入 ctx.api(管理端 HTTP API 客户端, agent 启动时已注入)

**输入**: prompt 必填(中文英文均可); aspect_ratio 选填(默认 "1:1"); reference_image_url 选填(图生图, http(s) URL)。

**返回**: {success, view_url, download_url, fileName, fileSize, mime_type, model, aspect_ratio, hint} 或 {error}`,
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: '图片描述(必填, 越详细越好, 中文或英文均可)' },
          aspect_ratio: { type: 'string', description: '比例, 默认 "1:1"。常用: 1:1 / 16:9 / 4:3 / 3:2 / 2:3 / 3:4 / 9:16 / 21:9' },
          reference_image_url: { type: 'string', description: '图生图参考图 URL(http(s)), 选填; 提供时走 image-to-image 保留主体' },
          model: { type: 'string', description: '模型名, 默认 "image-01"' },
        },
        required: ['prompt'],
      },
      budget: 180000, // 120s 默认超时 + 60s 余量, 图片生成耗时波动大 (20-90s 常见)
      run: async ({ prompt, aspect_ratio, reference_image_url, model }, extra) => {
        const img = ctx.minimaxImage;
        const api = ctx.api;
        if (!img) return { error: 'MiniMax 图片生成未初始化 (ctx.minimaxImage 缺失, 检查 agent.mjs 是否正确注入)' };
        if (!img.enabled) return { error: 'MiniMax API Key 未配置(.env 设 MINIMAX_API_KEY)' };
        if (!api || !api.uploadFile) return { error: 'XechatApi 未注入(无法上传生成的图片到鱼塘)' };

        if (extra.status) extra.status('生成图片中…');
        // 1) 调 MiniMax 生成 base64
        let gen;
        try {
          gen = await img.generate({
            prompt: String(prompt),
            aspectRatio: aspect_ratio || undefined,
            referenceImageUrl: reference_image_url || undefined,
            model: model || undefined,
          });
        } catch (e) {
          return { error: `生成异常: ${e.message || e}` };
        }
        if (!gen.success) return { error: `生成失败: ${gen.error || '未知'}`, raw: gen.raw };

        // 2) 上传到鱼塘 (一站式, 不把 base64 经 LLM context)
        // 上传本身仅几秒, 不发 extra.status 避免给聊天刷 💭 噪声;
        // LLM 拿到返回后发 markdown 即可, 不需要中间状态
        const ts = Date.now();
        const aspectTag = (gen.aspect_ratio || '1x1').replace(':', 'x');
        const filename = `gen-${ts}-${aspectTag}.jpeg`;
        let up;
        try {
          up = await api.uploadFile({
            content: gen.primary,
            filename,
            isBinary: true,
            bizType: 'user_avatar',  // 与 upload_image 默认一致, 走 MD5 去重
            mimeType: gen.mime_type || 'image/jpeg',
          });
        } catch (e) {
          // 上传失败但图已生成: 返回 base64 让 LLM 知道; LLM 可重试或人工介入
          return {
            success: false,
            generated: true,
            error: `生成成功但上传失败: ${e.message || e}`,
            hint: '可以让用户重试, 或人工到服务器取图',
          };
        }
        // uploadFile 失败时返回 { error }, 成功时返回 { id, fileName, view_url, ... }
        if (!up || up.error) {
          return {
            success: false,
            generated: true,
            error: `生成成功但上传失败: ${up && up.error ? up.error : '未知'}`,
            stage: up && up.stage,
            hint: '可以让用户重试, 或人工到服务器取图',
          };
        }
        return {
          success: true,
          view_url: up.view_url,
          download_url: up.download_url,
          fileName: up.fileName || filename,
          fileSize: up.fileSize,
          mime_type: gen.mime_type || 'image/jpeg',
          model: gen.model,
          aspect_ratio: gen.aspect_ratio,
          hint: '把 view_url 直接发到聊天即可(<a href="..." target="_blank">图片</a> 或 markdown ![](url))',
        };
      },
    }),
  ];
}