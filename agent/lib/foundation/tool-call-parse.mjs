// 鱼塘 agent 智能体 —— 泄漏工具调用文本解析 (模型鲁棒性兜底)
// 场景: 部分模型偶尔把"工具调用"输出成纯文本(Anthropic XML `<tool_calls>`/`<invoke>`,
// 或 OpenAI 风格 JSON `{"name","arguments"})而不是走函数调用机制, 最终被当成聊天回复发出去。
// 这里负责:
//   - extractToolCallFromText(): 从文本中识别并解析成可执行的工具调用数组;
//   - stripLeakedToolCallText(): 把泄漏的工具调用块从文本里剥掉(防发给用户乱码)。

const RE_TOOL_CALLS = /<tool_calls>([\s\S]*?)<\/tool_calls>/i;
const RE_INVOKE = /<invoke\s+name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/invoke>/gi;
const RE_PARAM = /<parameter\s+name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/parameter>/gi;
const RE_JSON_TOOLCALL = /\{\s*"(?:name|tool)"\s*:\s*"([^"]+)"\s*,\s*"(?:arguments|input)"\s*:\s*([\s\S]*?)\s*\}/g;

/**
 * 从一段模型文本里识别"工具调用被写成文本"的情况。
 * @param {string} text 模型输出的 content
 * @param {Set<string>|null} knownTools 当前可用工具名集合(用于确认可恢复; null=不校验)
 * @returns {{markers:boolean, calls:Array<{name:string, arguments:string}>}|null}
 *   null = 完全没有工具调用标记(正常聊天文本);
 *   markers=true 但 calls=[] 表示有标记但解析不出(可能被截断);
 *   calls 里的 arguments 是 JSON 字符串。
 */
export function extractToolCallFromText(text, knownTools = null) {
  const src = String(text || '');
  if (!src) return null;
  // 剥 markdown 代码块围栏
  const s = src.replace(/```(?:xml|json)?\s*/gi, '').replace(/```/g, '');
  let markers = false;
  const calls = [];

  // 1) Anthropic XML: <tool_calls><invoke name="X"><parameter name="k">v</parameter>...</invoke></tool_calls>
  if (/<tool_calls>/i.test(s) || /<invoke\s+name=/i.test(s)) {
    markers = true;
    const outer = s.match(RE_TOOL_CALLS);
    const block = (outer && outer[1]) || s;
    const invRe = new RegExp(RE_INVOKE.source, 'gi');
    let m;
    while ((m = invRe.exec(block))) {
      const name = m[1].trim();
      const args = {};
      const paramRe = new RegExp(RE_PARAM.source, 'gi');
      let p;
      while ((p = paramRe.exec(m[2]))) {
        let v = p[2].trim();
        try { v = JSON.parse(v); } catch {}
        args[p[1].trim()] = v;
      }
      calls.push({ name, arguments: JSON.stringify(args) });
    }
  }

  // 2) OpenAI 风格 JSON: {"name":"X","arguments":{...}} / {"tool":"X","input":{...}}
  if (!calls.length && /\{\s*"(?:name|tool)"\s*:\s*"/.test(s)) {
    markers = true;
    const jsonRe = new RegExp(RE_JSON_TOOLCALL.source, 'gi');
    let m;
    while ((m = jsonRe.exec(s))) {
      const name = m[1];
      let args = {};
      try { args = JSON.parse(m[2]); } catch {}
      calls.push({ name, arguments: JSON.stringify(args) });
    }
  }

  if (!markers) return null;
  if (!calls.length) return { markers: true, calls: [] };
  // 只保留已知工具(防误判用户聊天里正好提到工具名; 传了 knownTools 就过滤, 空集=无可执行)
  if (knownTools) {
    const known = calls.filter((c) => knownTools.has(c.name));
    if (known.length) return { markers: true, calls: known };
    return { markers: true, calls: [] };
  }
  return { markers: true, calls };
}

/** 把泄漏的工具调用块从文本中剥掉, 返回剩余文本(可能为空)。同时处理未闭合(被截断)的块。 */
export function stripLeakedToolCallText(text) {
  let s = String(text || '');
  // 先剥代码块围栏, 便于后续 tag 匹配
  s = s.replace(/```(?:xml|json)?\s*/gi, '').replace(/```/g, '');
  // <tool_calls>...</tool_calls> 或未闭合截断到行尾
  s = s.replace(/<tool_calls>[\s\S]*?(?:<\/tool_calls>|$)/gi, '');
  // <invoke name=...>...</invoke> 或未闭合截断到行尾
  s = s.replace(/<invoke\s+name=["'][^"']*["'][^>]*>[\s\S]*?(?:<\/invoke>|$)/gi, '');
  // OpenAI 风格 JSON 工具调用(可带尾随内容, 保守到闭合花括号)
  s = s.replace(/\{\s*"(?:name|tool)"\s*:\s*"[^"]+"\s*,\s*"(?:arguments|input)"\s*:[\s\S]*?\}/g, '');
  // 残留的 <tool_calls> 开标签或残缺 XML
  s = s.replace(/<tool_calls>\s*/gi, '').replace(/<\/?tool_calls>/gi, '').replace(/<\/?invoke[^>]*>/gi, '');
  return s.replace(/\s{2,}/g, ' ').trim();
}