// agent 工具注册表 —— 聚合入口 (lib/business/tools/)
// 每个分类单独一个文件(state / compute / web / platform / image / game /
// delegate / todo / memory / skills / scheduler / chat / probe), 各自导出 buildXxxTools(ctx)
// 返回 defineTool 对象数组。本文件只做组装, 不写业务。
import { ToolRegistry } from '../../foundation/tool-core.mjs';
import { buildStateTools } from './state.mjs';
import { buildComputeTools } from './compute.mjs';
import { buildWebTools } from './web.mjs';
import { buildPlatformTools } from './platform.mjs';
import { buildGameTools } from './game.mjs';
import { buildDelegateTools } from './delegate.mjs';
import { buildTodoTools } from './todo.mjs';
import { buildMemoryTools } from './memory.mjs';
import { buildSkillsTools } from './skills.mjs';
import { buildSchedulerTools } from './scheduler.mjs';
import { buildChatTools } from './chat.mjs';
import { buildProbeTools } from './probe.mjs';
import { buildImageTools } from './image.mjs';

export { ToolRegistry };

/** 构造并注册全部内置工具 (按分类分别构造, 全部注入同一个 ToolRegistry) */
export function createRegistry(registryCtx = {}) {
  const ctx = registryCtx;
  const reg = new ToolRegistry(ctx);

  for (const t of buildStateTools(ctx)) reg.register(t);
  for (const t of buildComputeTools(ctx)) reg.register(t);
  for (const t of buildWebTools(ctx)) reg.register(t);
  for (const t of buildPlatformTools(ctx)) reg.register(t);
  for (const t of buildGameTools(ctx)) reg.register(t);
  for (const t of buildDelegateTools(ctx)) reg.register(t);
  for (const t of buildTodoTools(ctx)) reg.register(t);
  for (const t of buildMemoryTools(ctx)) reg.register(t);
  for (const t of buildSkillsTools(ctx)) reg.register(t);
  for (const t of buildSchedulerTools(ctx)) reg.register(t);
  for (const t of buildChatTools(ctx)) reg.register(t);
  for (const t of buildProbeTools(ctx)) reg.register(t);
  for (const t of buildImageTools(ctx)) reg.register(t);

  // 已废弃: send_file (由 upload_image 替代)。代码保留在 git 历史里;
  // 如确需 password/expiry 等 sendup.cc 特性, 可在未来重新从 git history 提取。

  return reg;
}