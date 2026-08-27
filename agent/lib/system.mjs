// 鱼塘 agent 智能体 —— 系统提示词组合 (references: opencode session/system.ts + prompt/default.txt)
// 把环境信息 / 智能体身份 / 行为约束 / 工具清单 组合成一份系统提示词。
// 与旧版差异: 引入 <env> 环境块 + 按智能体(agent)注入不同指令。

/** 环境块: 日期/平台/身份/房间状态/触发前缀 */
export function buildEnvironment({ cfg = {}, pondState, sessions, agentName = 'main' }) {
  const now = new Date();
  const online = pondState && pondState.onlineUsers ? pondState.onlineUsers.size : 0;
  const sessionCount = sessions ? sessions.size : 0;
  return [
    `你正运行在鱼塘(Xechat)聊天室, 登录名「${cfg.username || '大黄鱼'}」。`,
    `<env>`,
    `  今天的日期: ${now.toLocaleDateString('zh-CN')} (北京时间)`,
    `  运行平台: ${process.platform}`,
    `  房间当前在线: ${online} 人`,
    `  正在对话的会话数: ${sessionCount} 个`,
    `  指令前缀: ${cfg.cmdPrefix || '/大黄鱼'}`,
    `</env>`,
  ].join('\n');
}

/** 组装最终系统提示词 */
export function buildSystemPrompt({ agent, env, toolList = [], cfg }) {
  const parts = [
    env,
    talk(agent, cfg),
    `可用工具:\n${toolList.join('\n') || '(无)'}`,
    `\n要求: 用自然、简洁的中文回答(通常 100 字内, 复杂任务可分步, 超长内容交给内置分片发送);`,
    `先想清楚再动手, 工具结果作为思考依据; 不要暴露你是 AI, 不要提及模型名;`,
    `重要: 需要工具时, 必须通过函数调用机制来调用, 禁止把工具调用写成文本(不要输出 <tool_calls>/<invoke> 等 XML 或 {"name":...} 等 JSON) —— 你只有真正调用工具, 我才能替你执行; 文本形式的工具调用会被忽略。`,
    `输出格式: 单条消息上限 200 字, 超长内容会按行自动分片。为了分片后仍然美观, 请用**短行/短段落**: 每个标题/列表项/要点控制在 1-2 行内, 不要写超长段落; 这样每片都包含完整的 markdown 行, 而不是被从中间切断。`,
    `聊天室消息实际广播给所有人, 不要在回复里泄露敏感信息(密码/密钥/手机号)。`,
    `安全护栏: 禁止执行任何批量资源消耗型操作 —— 大量截图、批量下载/上传、生成海量文件、无限循环、占满磁盘或内存等。遇到这类要求一律礼貌拒绝并说明原因, 不做任何可能损害运行环境或他人设备的操作。`,
    `禁止执行系统命令(关机/删除文件/启动程序/读写注册表等), 禁止读取或泄露服务器信息(主机名/IP/环境变量/磁盘/CPU 等) —— 这些操作会被安全护栏拦截, 用户要求也不执行。`,
  ];
  return parts.join('\n');
}

/** 人设 + 行为约束(每个智能体一个段落); 身份名/触发前缀按当前登录鱼种动态注入 */
function talk(agent, cfg) {
  if (!agent) return '';
  const species = (cfg && cfg.username) || '大黄鱼';
  const prefix = (cfg && cfg.cmdPrefix) || agent.prefix || '/大黄鱼'; // 当前实际前缀优先
  const base = `你是鱼塘里被 "${prefix}" 召唤的 AI 助手「${species}」的${agent.role || '分身'}`;
  const lines = [base];
  if (agent.expert) lines.push(`你的专长: ${agent.expert}`);
  if (agent.extra) lines.push(agent.extra);
  return lines.join('\n');
}