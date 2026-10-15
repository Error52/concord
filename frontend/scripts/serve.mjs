// Development server without Docker/nginx: serves dist/ (SPA fallback) and proxies
// /api (HTTP + WebSocket gateway) to the backend and /livekit to the SFU.
//   BACKEND=http://localhost:4000 LIVEKIT=http://localhost:7880 PORT=5173 node scripts/serve.mjs
import http from 'node:http';
import net from 'node:net';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';

const PORT = Number(process.env.PORT ?? 5173);
const HOST = process.env.HOST ?? '127.0.0.1';
const BACKEND = new URL(process.env.BACKEND ?? 'http://localhost:4000');
const LIVEKIT = new URL(process.env.LIVEKIT ?? 'http://localhost:7880');
// Only enable behind a loopback HTTPS proxy that sanitizes X-Forwarded-For.
const TRUST_PROXY = process.env.FRONTEND_TRUST_PROXY === '1';
const ROOT = path.resolve('dist');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.map': 'application/json', '.woff2': 'font/woff2' };

function target(url) {
  if (url.startsWith('/api/') || url === '/api') return { host: BACKEND, path: url };
  if (url.startsWith('/livekit')) return { host: LIVEKIT, path: url.replace(/^\/livekit/, '') || '/' };
  return null;
}

function upstreamHeaders(req) {
  const headers = { ...req.headers };
  const peer = req.socket.remoteAddress ?? '';
  const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer);
  const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',').at(-1)?.trim();
  headers['x-forwarded-for'] = TRUST_PROXY && loopback && forwarded && net.isIP(forwarded) ? forwarded : peer;
  delete headers.forwarded;
  if (!(TRUST_PROXY && loopback)) {
    delete headers['x-forwarded-proto'];
    delete headers['x-forwarded-host'];
  }
  return headers;
}

const server = http.createServer(async (req, res) => {
  const t = target(req.url ?? '/');
  if (t) {
    const p = http.request(
      { hostname: t.host.hostname, port: t.host.port, path: t.path, method: req.method, headers: upstreamHeaders(req) },
      (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      },
    );
    p.on('error', () => {
      if (res.headersSent) res.destroy();
      else res.writeHead(502).end();
    });
    req.pipe(p);
    return;
  }
  let clean;
  try { clean = decodeURIComponent((req.url ?? '/').split('?')[0]); }
  catch { return res.writeHead(400).end('Invalid URL'); }
  let file = path.resolve(ROOT, '.' + clean);
  const relative = path.relative(ROOT, file);
  if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) return res.writeHead(403).end();
  try {
    if (!(await stat(file)).isFile()) throw new Error('dir');
  } catch {
    if (clean.startsWith('/assets/')) return res.writeHead(404).end();
    file = path.join(ROOT, 'index.html');
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
  const stream = createReadStream(file);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
});

// WebSocket upgrades: raw TCP tunnel to the upstream.
server.on('upgrade', (req, socket, head) => {
  const t = target(req.url ?? '/');
  if (!t) return socket.destroy();
  const up = net.connect(Number(t.host.port), t.host.hostname, () => {
    const headers = Object.entries(upstreamHeaders(req)).map(([k, v]) => `${k}: ${v}`).join('\r\n');
    up.write(`${req.method} ${t.path} HTTP/1.1\r\n${headers}\r\n\r\n`);
    up.write(head);
    socket.pipe(up).pipe(socket);
  });
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
  socket.on('close', () => up.destroy());
  up.on('close', () => socket.destroy());
});

server.listen(PORT, HOST, () => console.log(`Concord dev server on http://localhost:${PORT} → ${BACKEND.href}`));
