// 走代理查出口 IP
import net from 'node:net';
const s = net.connect(7897, '127.0.0.1');
let buf = Buffer.alloc(0);
let tunneled = false;
s.on('connect', () => s.write('CONNECT api.ipify.org:80 HTTP/1.1\r\nHost: api.ipify.org\r\n\r\n'));
s.on('data', (d) => {
  buf = Buffer.concat([buf, d]);
  if (!tunneled) {
    const i = buf.indexOf('\r\n\r\n');
    if (i < 0) return;
    if (!buf.toString('latin1', 0, i).includes(' 200 ')) { console.log('connect fail'); s.destroy(); return; }
    tunneled = true;
    buf = buf.slice(i + 4);
    s.write('GET / HTTP/1.1\r\nHost: api.ipify.org\r\nConnection: close\r\n\r\n');
    return;
  }
  const text = buf.toString('utf8');
  // 去掉 header, 取 body
  const bodyIdx = text.indexOf('\r\n\r\n');
  if (bodyIdx > 0) {
    const body = text.slice(bodyIdx + 4).trim();
    console.log('代理出口 IP:', body || '(空)');
  } else {
    console.log('raw:', text.slice(0, 300));
  }
  s.destroy();
});
s.on('error', (e) => console.log('err:', e.message));