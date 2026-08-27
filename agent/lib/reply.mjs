// 鱼塘 agent 智能体 —— 统一回复发送器(支持 markdown 友好分片)
// 所有对外消息(正式回答 / 💭思考结果 / 工具执行提示)都必须走这里:
//   内部判断内容是否超过 maxLen(服务端实测单条上限 200 字符),
//   超长按"markdown 友好"拆分多条连续消息发送(续段带 ↪ 前缀):
//     1) 优先在**行边界**切(整行装不下才换片), 避免把 ## 标题 / - 列表项 / 段落 从中间切断;
//     2) 单行超长(URL、连续无空格)时, 在**可读标点/空格**边界切(不切碎中文词 / emoji);
//     3) emoji 代理对按码点切, 永不拆散。
//   拼接回原文: 去掉每片(除首片)开头的 ↪ 前缀, 等于原 content。
export function makeReplySender({ send, maxLen = 200, chunkDelayMs = 600 }) {
  const CONT_PREFIX = '↪ ';
  const CONT_PREFIX_LEN = Array.from(CONT_PREFIX).length;

  /**
   * @param {string|number} content 要发送的内容
   * @param {any} to 接收者(透传给 send)
   */
  async function sendReply(content, to) {
    const text = String(content == null ? '' : content);
    if (!text) return; // 空内容不发
    const pieces = splitForMarkdown(text, maxLen);
    for (let i = 0; i < pieces.length; i++) {
      const chunk = pieces[i];
      const wire = i > 0 ? CONT_PREFIX + chunk : chunk;
      await send(wire, to);
      if (i < pieces.length - 1 && chunkDelayMs > 0) await sleep(chunkDelayMs);
    }
  }

  return sendReply;
}

/** 把一段文本切成若干 ≤ maxLen 的片段(不含前缀, 按行优先, 不切碎 markdown)。
 *  算法: 按行贪心装片; 行间 \n 通过"cur + '\\n' + line"自然嵌入; 收尾一片时若原文本中该片最后一行
 *  后面还有行(还有 \n), 给该片补尾 \n, 保证 `pieces.join('')` 精确还原原文本。 */
export function splitForMarkdown(text, maxLen = 200) {
  const CONT_PREFIX_LEN = Array.from('↪ ').length;
  const lines = String(text).split('\n');
  const pieces = [];
  let cur = '';
  const budget = (idx) => Math.max(1, idx === 0 ? maxLen : maxLen - CONT_PREFIX_LEN);

  // 推入当前片; moreFollows=true 表示原文本中 cur 最后一行后面还有行 → 补尾 \n
  const pushCur = (moreFollows) => {
    if (!cur) return;
    pieces.push(moreFollows ? cur + '\n' : cur);
    cur = '';
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const more = i < lines.length - 1;
    const candidate = cur ? cur + '\n' + line : line;
    if (codePointLen(candidate) <= budget(pieces.length)) { cur = candidate; continue; }
    // 装不下当前行 → 收尾已有片(后面还有行, 补 \n)
    pushCur(true);
    // 超长行: 在可读标点处切成多片
    let rest = line;
    while (rest) {
      const b = budget(pieces.length);
      if (codePointLen(rest) <= b) { cur = rest; break; }
      const cut = findReadableCut(rest, b);
      pieces.push(cut);
      rest = codePointSlice(rest, codePointLen(cut));
    }
  }
  pushCur(false);
  return pieces;
}

/** 按码点长度(emoji 代理对视为 1) */
function codePointLen(s) {
  return Array.from(s).length;
}

function codePointSlice(s, startCp) {
  return Array.from(s).slice(startCp).join('');
}

/** 软边界字符(优先在标点/空格处切, 避免切碎中文/英文单词)。优先向后靠的"宽"边界。 */
const SOFT_BOUNDARY = new Set([
  ' ', '　', '\t',
  '、', '。', '，', ',', '；', ';', '：', ':', '！', '!', '？', '?',
  '/', '\\', '|', '—', '–', '-', '_',
  ')', '）', ']', '】', '}', '》', '>', '`',
]);

/**
 * 在不超过 budget 码点长度内, 找一个尽量靠后且是软边界的切点。
 * 若行内有空格/标点, 切在边界之后(把边界字符放前一片); 否则按码点硬切。
 */
function findReadableCut(s, budget) {
  const chars = Array.from(s);
  if (chars.length <= budget) return s;
  // 从后往前找: 优先 [边界字符] 然后 [边界字符+1] 是字母/数字的情况(避免"abc |")
  // 简化: 找 [0, budget) 中最后一个"软边界"字符的位置
  const limit = Math.min(budget, chars.length);
  let cut = -1;
  for (let i = limit - 1; i >= 1; i--) {
    if (SOFT_BOUNDARY.has(chars[i])) { cut = i + 1; break; } // 把边界字符留给前一片
  }
  if (cut <= 0) cut = budget; // 找不到, 硬切
  return chars.slice(0, cut).join('');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));