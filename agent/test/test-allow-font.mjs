import { createRegistry } from '../lib/business/tools/index.mjs';
const reg = createRegistry({
  startTime: Date.now(), sessions: null, pondState: null,
  proxy: {}, python: {}, web: {}, memory: null, skills: {}, todo: {},
  subagentDepth: 1, ws: null, scheduler: null, roomLog: {},
  chatLog: null, sendup: null,
});

const cases = [
  { expect: '放行', name: 'truetype msyh.ttc',
    code: `from PIL import ImageFont\nfont = ImageFont.truetype(r'C:\\Windows\\Fonts\\msyh.ttc', 16)\nprint('font size=', font.size)` },
  { expect: '拦截', name: 'open C:\\Windows\\System32',
    code: `f = open(r'C:\\Windows\\System32\\drivers\\etc\\hosts', 'rb')\nprint(f.read())` },
  { expect: '拦截', name: 'truetype .dll',
    code: `from PIL import ImageFont\nfont = ImageFont.truetype(r'C:\\Windows\\System32\\evil.dll', 16)\nprint(font.size)` },
  { expect: '拦截', name: 'truetype .env',
    code: `from PIL import ImageFont\nfont = ImageFont.truetype('/root/.env"x.ttf', 16)\nprint(font.size)` },
  { expect: '拦截', name: 'truetype 无扩展名',
    code: `from PIL import ImageFont\nfont = ImageFont.truetype(r'C:\\Windows\\Fonts\\msyh', 16)\nprint(font.size)` },
  { expect: '拦截', name: 'truetype /etc/passwd',
    code: `from PIL import ImageFont\nfont = ImageFont.truetype('/etc/passwd.ttf', 16)\nprint(font.size)` },
  { expect: '拦截', name: 'ctypes',
    code: `import ctypes\nprint('hacked')` },
  { expect: '放行', name: 'truetype /tmp',
    code: `from PIL import ImageFont\nfont = ImageFont.truetype('/tmp/arial.ttf', 16)\nprint(font.size)` },
];

for (const c of cases) {
  process.stdout.write(`\n=== [应${c.expect}] ${c.name} ===\n`);
  const r = await reg.dispatch('python', { code: c.code });
  if (r.blocked) console.log('  → 静态拦截:', r.error);
  else if (r.error) console.log('  → 错误:', r.error);
  else {
    console.log('  → exitCode:', r.exitCode);
    if (r.stdout) console.log('  → stdout :', r.stdout.slice(0, 200));
    if (r.stderr) console.log('  → stderr :', r.stderr.slice(0, 400));
  }
}