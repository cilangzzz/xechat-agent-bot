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
