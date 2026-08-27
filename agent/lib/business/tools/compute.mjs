// agent 工具 —— 计算 (Python 沙箱执行, 静态+运行期双层护栏)
// 依赖 ctx.python, lib/platform/python-runner.mjs
import { defineTool } from '../../foundation/tool-core.mjs';
import { runPython, pythonBlockReason } from '../../platform/python-runner.mjs';

export function buildComputeTools(ctx) {
  return [
    defineTool({
      id: 'python',
      description: '执行一段 Python 代码做计算/数据处理/脚本, print 输出即结果。可用于数学计算、数据整理、文本处理等。超时自动终止。安全限制: 禁止执行系统命令(subprocess/os.system 等)、禁止读取服务器信息(环境变量/主机名/平台/网络/CPU等)、禁止破坏性文件操作, 命中会被拦截。',
      parameters: {
        type: 'object',
        properties: { code: { type: 'string', description: '要执行的 Python 代码, 用 print 输出结果' } },
        required: ['code'],
      },
      budget: 4000,
      run: async ({ code }) => {
        const src = String(code || '');
        const why = pythonBlockReason(src);
        if (why) {
          return { exitCode: -1, error: `⛔ 代码包含被禁止的操作(${why}), 已拒绝执行。`, blocked: true };
        }
        const r = await runPython(src, { timeoutMs: ctx.python?.timeoutMs || 15000, cmd: ctx.python?.cmd || 'python' });
        return { exitCode: r.exitCode, timedOut: r.timedOut, stdout: r.stdout.trim().slice(0, 4000), stderr: r.stderr.trim().slice(0, 2000) };
      },
    }),
  ];
}