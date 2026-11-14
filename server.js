/* 小事打卡 · 单端口服务：静态文件 + 同源反代 Supabase
 *
 * 为什么需要它：Supabase 的域名在国内移动网络下经常连不上（手机报 Failed to fetch），
 * 而本站域名是通的。于是让浏览器只跟本站说话，由这台服务器去访问 Supabase。
 *
 *   /            → 静态文件（index.html、app.js、vendor/…）
 *   /sb/xxx      → 转发到 https://<项目>.supabase.co/xxx
 *
 * 部署要求：监听 PORT、绑定 0.0.0.0（平台只暴露一个端口）。
 * 不引入任何 npm 依赖，只用 Node 内置模块。
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const UPSTREAM = process.env.SUPABASE_HOST || 'mtkuieogemgpdvacphhs.supabase.co';
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8'
};

function proxy(req, res) {
  const target = req.url.slice(3) || '/'; // '/sb/auth/v1/health' → '/auth/v1/health'
  const headers = Object.assign({}, req.headers);
  delete headers.host;
  delete headers['content-length'];
  // 不让上游压缩：Node 这里只是原样转发，不解压。
  // 若透传 gzip，又删掉 content-encoding，浏览器会拿到一堆乱码（PostgREST 的 JSON 会挂）。
  delete headers['accept-encoding'];
  // 平台 Edge 会改写 Authorization 头，所以前端把 token 放在自定义头里带过来，这里还原。
  if (headers['x-sb-auth']) {
    headers.authorization = headers['x-sb-auth'];
    delete headers['x-sb-auth'];
  }
  headers.host = UPSTREAM;

  const upstream = https.request(
    { host: UPSTREAM, port: 443, path: target, method: req.method, headers: headers },
    (ur) => {
      const h = Object.assign({}, ur.headers);
      delete h['content-length'];
      delete h['transfer-encoding'];
      res.writeHead(ur.statusCode || 502, h);
      ur.pipe(res);
    }
  );

  upstream.on('error', (err) => {
    res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'proxy_failed', message: err.message }));
  });

  req.pipe(upstream);
}

function serveStatic(req, res) {
  let rel = decodeURIComponent((req.url || '/').split('?')[0].split('#')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';

  const full = path.normalize(path.join(ROOT, rel));
  if (!full.startsWith(ROOT)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('forbidden');
  }

  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('not found');
    }
    const ext = path.extname(full).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    const cache = ext === '.html' || ext === '.js' || ext === '.css'
      ? 'no-cache'
      : 'public, max-age=86400';
    res.writeHead(200, { 'content-type': type, 'cache-control': cache, 'content-length': st.size });
    fs.createReadStream(full).pipe(res);
  });
}

http
  .createServer((req, res) => {
    if (req.url && req.url.startsWith('/sb/')) return proxy(req, res);
    return serveStatic(req, res);
  })
  .listen(PORT, '0.0.0.0', () => {
    console.log('[server] listening on ' + PORT + ', upstream=' + UPSTREAM);
  });
