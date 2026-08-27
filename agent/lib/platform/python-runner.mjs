// 鱼塘 agent 智能体 —— Python 执行器
// 供两个用途共用:
//   1) `python` 工具: 让 LLM 用 python 做计算/数据处理 (参考 Claude Code 的 Bash 工具)
//   2) 网络工具 (web.mjs): 用 python requests 走代理抓取网页/搜索/金价
// 安全约束: 强制超时、输出上限、在沙箱目录里运行 (文件读写不污染 agent 目录)。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_OUTPUT = 50 * 1024; // stdout+stderr 合计上限 50KB

// —— 运行期安全 prelude (第二道防线, 静态审计可能被字符串拼接/编码绕过) ——
// 注入到用户代码之前:
//   1) 包装 builtins.__import__, 拦截危险模块导入(subprocess/psutil/ctypes/...)
//   2) 函数脱敏: os/shutil 危险函数、socket 探测函数、platform 本机信息函数 → 调用即抛 PermissionError
// 注意: requests 依赖链需要 import socket(email.utils), 因此 socket 不禁导入、只禁探测函数。
const PY_SAFETY_PRELUDE = `
import builtins as _yb
_orig_import = _yb.__import__
_YB_BLOCKED = {'subprocess','psutil','commands','netifaces','ctypes','winreg','multiprocessing','pty','ftplib','telnetlib','paramiko'}
def _yb_safe_import(name, *a, **k):
    _r = name.split('.')[0]
    if _r in _YB_BLOCKED:
        raise ImportError('[安全策略] 禁止导入模块: ' + _r)
    return _orig_import(name, *a, **k)
_yb.__import__ = _yb_safe_import
def _yb_deny(*_a, **_k):
    raise PermissionError('[安全策略] 该操作已被禁止')
try:
    import os as _yb_os
    for _fn in ('system','popen','spawnl','spawnlp','spawnv','spawnvp','execl','execle','execlp','execv','execve','execvp','remove','rmdir','unlink','chmod','chown'):
        if hasattr(_yb_os, _fn): setattr(_yb_os, _fn, _yb_deny)
    # 环境变量属服务器信息, 清空标量(防 __dict__/getenv 绕过读取 API key 等) —— requests 显式传 proxies, 不依赖环境变量
    setattr(_yb_os, 'environ', {})
except Exception: pass
try:
    import shutil as _yb_sh
    for _fn in ('rmtree','move','copy','copyfile','copytree'):
        if hasattr(_yb_sh, _fn): setattr(_yb_sh, _fn, _yb_deny)
except Exception: pass
try:
    import socket as _yb_sk
    for _fn in ('gethostname','getfqdn','sethostname'):
        if hasattr(_yb_sk, _fn): setattr(_yb_sk, _fn, _yb_deny)
except Exception: pass
try:
    import platform as _yb_pl
    for _fn in ('node','system','machine','processor','release','version','uname','platform','architecture'):
        if hasattr(_yb_pl, _fn): setattr(_yb_pl, _fn, _yb_deny)
except Exception: pass
try:
    import urllib.request as _yb_ur
    for _fn in ('urlretrieve',):
        if hasattr(_yb_ur, _fn): setattr(_yb_ur, _fn, _yb_deny)
except Exception: pass
`.trim() + '\n';

/**
 * 执行一段 python 代码。
 * @param {string} code python 代码 (print 输出到 stdout)
 * @param {object} opts { timeoutMs, cmd(默认 python), cwd(默认临时沙箱目录), env, maxOutput(默认50KB) }
 * @returns {Promise<{stdout, stderr, exitCode, timedOut}>}
 */
export function runPython(code, { timeoutMs = 15000, cmd = 'python', cwd, env, maxOutput = MAX_OUTPUT } = {}) {
  return new Promise((resolve) => {
    let sandbox = cwd;
    let createdSandbox = false;
    if (!sandbox) {
      sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'yutang-py-'));
      createdSandbox = true;
    }
    const child = spawn(cmd, ['-c', PY_SAFETY_PRELUDE + code], {
      cwd: sandbox,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', ...env },
      windowsHide: true,
    });
    let out = '';
    let err = '';
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill('SIGKILL'); } catch (e) {}
      resolve({ stdout: out, stderr: err + '\n[超时] python 执行超过 ' + timeoutMs + 'ms 已终止', exitCode: -1, timedOut: true });
    }, timeoutMs);

    child.stdout.on('data', (d) => { out = appendCap(out, d, maxOutput); });
    child.stderr.on('data', (d) => { err = appendCap(err, d, maxOutput); });
    child.on('error', (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ stdout: out, stderr: err + '\n[错误] ' + e.message, exitCode: -2, timedOut: false });
    });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (createdSandbox) { try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch (e) {} }
      resolve({ stdout: out, stderr: err, exitCode: code, timedOut: false });
    });
  });
}

function appendCap(buf, chunk, maxOutput) {
  const s = buf + chunk.toString('utf8');
  return s.length > maxOutput ? s.slice(0, maxOutput) + '\n...[输出超限截断]' : s;
}

// —— Python 安全护栏: 静态审计 (与运行期 prelude 双层防护) ——
// 命中任一危险模式直接拒绝执行。注意: 正常数学计算/数据处理/文本处理不会触碰这些模式, 无需担心误伤。
// bypassable: 'font' 表示该规则在 ImageFont.truetype 加载字体场景可放行(用于画中文图)。
export const PY_BLOCK_RE = [
  // 1) 执行系统命令
  { re: /subprocess|os\.system|os\.popen|os\.exec|Popen|spawn\s*\(|shell\s*=\s*True|commands\./i, why: '执行系统命令' },
  // 2) 动态执行(绕过静态审计的常见手段: eval/exec/__import__/compile)
  { re: /\bexec\s*\(|\beval\s*\(|__import__|compile\s*\(/i, why: '动态执行代码(可能绕过安全限制)' },
  // 3) 探测服务器信息(环境变量/平台/网络/硬件)
  { re: /os\.environ|os\.getenv|os\.uname|os\.getlogin|os\.name\b|platform\.|socket\.|psutil|gethostname|getfqdn|uuid\.getnode|cpu_count|virtual_memory|disk_usage|netifaces/, why: '探测服务器信息' },
  // 4) 破坏性系统/文件操作
  { re: /shutil\.(rmtree|move|copy)|os\.(remove|rmdir|unlink)|taskkill|shutdown|reboot|reg\s+(add|delete|edit)|net\s+user/i, why: '破坏性系统操作' },
  // 5) 读取敏感文件 (硬黑名单, 字体加载也不能放行)
  { re: /\/etc\/passwd|\/etc\/shadow|\.env["']/i, why: '读取敏感文件' },
  // 5b) 访问 Windows 系统目录(可被 PIL truetype 加载系统字体时绕过)
  { re: /C:\\Windows/i, why: '访问系统目录', bypassable: 'font' },
  // 6) 下载/写盘大文件(占带宽/磁盘)
  { re: /urlretrieve|\.download\s*\(/i, why: '下载文件到本地' },
];

/** 静态审计: 返回被拒原因(why) 或 '' 通过。ImageFont.truetype 加载 TTF/TTC/OTF 字体时白名单 bypassable:'font' 规则 */
export function pythonBlockReason(src) {
  // 白名单: 仅放行 PIL ImageFont.truetype 加载 TTF/TTC/OTF 字体这一种场景(用于画中文图);
  // 其它 ctypes / subprocess / 探测系统信息 等规则不受影响, 沙箱底线保留。
  const isFontLoad = /\bImageFont\s*\.\s*truetype\s*\(/i.test(src)
    && /\.(ttf|ttc|otf)\b/i.test(src);
  const hit = PY_BLOCK_RE.find((b) => {
    if (isFontLoad && b.bypassable === 'font') return false;
    return b.re.test(src);
  });
  return hit ? hit.why : '';
}
