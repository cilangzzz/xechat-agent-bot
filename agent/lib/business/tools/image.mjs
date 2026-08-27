// agent 工具 —— AI 图片生成 (MiniMax image-01, 文生图 / 图生图)
// 参考 H:\Documents\software-dev-ai-workflow\0.0-通用skill\docs-minimax-docs\图片生成.md
//
// 典型流程:
//   generate_image(prompt)                          → 拿到 image_base64
//   upload_image(content=base64, is_binary=true)    → 拿 view_url
//   把 view_url 贴到聊天
import { defineTool } from '../../foundation/tool-core.mjs';

export function buildImageTools(ctx) {
  return [
    defineTool({
      id: 'generate_image',
      description: `调用 MiniMax image-01 生成图片(文生图 / 图生图)。返回 base64 图片数据, **不会**直接发到聊天; 需要用户能看到时, 再调 upload_image 把 base64 上传拿 view_url。
**何时使用**
- 用户说"画一张/生成一张/画图/做个图/配张图/示意图/封面/头像"
- 用户给一段描述要可视化(如"配张赛博朋克风的城市夜景"——描述里给细节越多效果越好)
- 配图/封面/演示场景图(场景/概念/插画)

**何时不用**
- 要精确数据图表/统计图 —— 用 compute (python matplotlib) 算 + 画, 再 upload_image
- 截图/UI 复用 —— 用 compute (python PIL) 或外部截图工具
- 没配 MINIMAX_API_KEY(.env 留空即不可用, 会返回明确错误)

**输入**: prompt 必填(中文英文均可); aspect_ratio 选填(默认 "1:1"); reference_image_url 选填(图生图, http(s) URL)。

**返回**: {success, count, mime_type, model, aspect_ratio, primary(主图 base64), image_base64(数组), raw_status, hint} 或 {error}`,
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
      budget: 90000, // 60s 超时 + 余量, 图片生成耗时较大
      run: async ({ prompt, aspect_ratio, reference_image_url, model }, extra) => {
        const img = ctx.minimaxImage;
        if (!img) return { error: 'MiniMax 图片生成未初始化 (ctx.minimaxImage 缺失, 检查 agent.mjs 是否正确注入)' };
        if (!img.enabled) return { error: 'MiniMax API Key 未配置(.env 设 MINIMAX_API_KEY)' };
        if (extra.status) extra.status('生成图片中…');
        try {
          const r = await img.generate({
            prompt: String(prompt),
            aspectRatio: aspect_ratio || undefined,
            referenceImageUrl: reference_image_url || undefined,
            model: model || undefined,
          });
          if (!r.success) return { error: `生成失败: ${r.error || '未知'}`, raw: r.raw };
          return {
            success: true,
            count: r.count,
            mime_type: r.mime_type,
            model: r.model,
            aspect_ratio: r.aspect_ratio,
            primary: r.primary,           // 主图 base64, 给 upload_image 直接用
            image_base64: r.image_base64, // 完整数组
            raw_status: r.raw_status,
            hint: '用 upload_image(content=<primary>, filename=xxx.jpeg, is_binary=true) 上传到鱼塘拿到 view_url, 再贴聊天',
          };
        } catch (e) {
          return { error: `生成异常: ${e.message || e}` };
        }
      },
    }),
  ];
}