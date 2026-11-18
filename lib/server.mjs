// 即梦素材库本地管理服务：node server.mjs --lib <素材库目录> --port <端口>
// 只监听 127.0.0.1；页面为 lib/ui/index.html（固定一份，数据通过 API 读取）。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as L from './library.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const LIB = path.resolve(arg('lib', L.resolveLibraryDir()));
const PORT = Number(arg('port', L.DEFAULT_PORT));
const UI = path.join(HERE, 'ui', 'index.html');
const clients = new Set();
const HOST_RE = new RegExp(`^(127\\.0\\.0\\.1|localhost|\\[::1\\]):${PORT}$`, 'i');
const MIME = {
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.m4v': 'video/mp4',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.flac': 'audio/flac',
  '.json': 'application/json; charset=utf-8',
};

L.ensureLibrary(LIB);
const log = (...a) => console.log(new Date().toISOString(), ...a);
const httpErr = (status, message) => Object.assign(new Error(message), { status });

function sendJson(res, code, obj) {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': b.length, 'cache-control': 'no-store' });
  res.end(b);
}
function broadcast(evt) {
  const line = `data: ${JSON.stringify(evt)}\n\n`;
  for (const c of clients) { try { c.write(line); } catch { /* ignore */ } }
}
const changed = (extra = {}) => broadcast({ type: 'changed', ...extra });

async function readBody(req) {
  let s = '';
  for await (const chunk of req) {
    s += chunk;
    if (s.length > 1_000_000) throw httpErr(413, 'body too large');
  }
  if (!s) return {};
  try { return JSON.parse(s); } catch { throw httpErr(400, 'invalid JSON'); }
}

function serveFile(req, res, file) {
  let st;
  try { st = fs.statSync(file); } catch { return sendJson(res, 404, { ok: false, error: 'not found' }); }
  if (!st.isFile()) return sendJson(res, 404, { ok: false, error: 'not found' });
  const headers = { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'accept-ranges': 'bytes', 'cache-control': 'no-cache' };
  let start = 0;
  let end = st.size - 1;
  let code = 200;
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (m && (m[1] || m[2])) {
    if (m[1] === '') { start = Math.max(0, st.size - Number(m[2])); }
    else { start = Number(m[1]); if (m[2] !== '') end = Math.min(Number(m[2]), st.size - 1); }
    if (start > end || start >= st.size) { res.writeHead(416, { 'content-range': `bytes */${st.size}` }); return res.end(); }
    code = 206;
    headers['content-range'] = `bytes ${start}-${end}/${st.size}`;
  }
  headers['content-length'] = st.size ? end - start + 1 : 0;
  res.writeHead(code, headers);
  if (req.method === 'HEAD' || !st.size) return res.end();
  const stream = fs.createReadStream(file, { start, end });
  stream.pipe(res);
  res.on('close', () => stream.destroy()); // 尽快释放文件句柄（Windows 上归档需要 rename）
}

async function route(req, res) {
  if (!HOST_RE.test(String(req.headers.host || ''))) return sendJson(res, 403, { ok: false, error: 'forbidden host' });
  const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = u.pathname;
  const method = req.method;
  const isRead = method === 'GET' || method === 'HEAD';
  // 写操作要求自定义头：浏览器跨站请求无法携带（会触发未放行的 CORS 预检）
  if (!isRead && req.headers['x-jimeng-library'] !== '1') return sendJson(res, 403, { ok: false, error: 'missing x-jimeng-library header' });

  if (isRead && (p === '/' || p === '/index.html')) {
    const html = fs.readFileSync(UI);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(html);
  }
  if (p === '/api/ping') return sendJson(res, 200, { ok: true, app: L.APP_ID, lib: LIB, pid: process.pid, port: PORT, schemaVersion: L.SCHEMA_VERSION });
  if (p === '/api/items' && isRead) {
    return sendJson(res, 200, { ok: true, lib: LIB, stats: L.libraryStats(LIB), items: L.listItems(LIB).map(L.publicItem) });
  }
  if (p === '/api/events' && isRead) {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    clients.add(res);
    const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch { /* ignore */ } }, 25000);
    req.on('close', () => { clearInterval(hb); clients.delete(res); });
    return undefined;
  }
  if (p === '/api/notify' && method === 'POST') {
    const b = await readBody(req);
    broadcast({ type: 'added', ids: Array.isArray(b.ids) ? b.ids : [] });
    return sendJson(res, 200, { ok: true, clients: clients.size });
  }
  let mm = /^\/api\/items\/([^/]+)$/.exec(p);
  if (mm && method === 'PATCH') {
    const it = L.updateItem(LIB, decodeURIComponent(mm[1]), await readBody(req));
    changed();
    return sendJson(res, 200, { ok: true, item: L.publicItem(it) });
  }
  mm = /^\/api\/items\/([^/]+)\/(archive|restore|purge|reveal)$/.exec(p);
  if (mm && method === 'POST') {
    const r = L.applyAction(LIB, mm[2], [decodeURIComponent(mm[1])]);
    if (mm[2] !== 'reveal') changed();
    if (r.errors.length) throw httpErr(400, r.errors.map((e) => e.error).join('; '));
    return sendJson(res, 200, { ok: true, ...r });
  }
  if (p === '/api/batch' && method === 'POST') {
    const b = await readBody(req);
    if (!['archive', 'restore', 'purge', 'update'].includes(b.action)) throw httpErr(400, 'unsupported action');
    const r = L.applyAction(LIB, b.action, Array.isArray(b.ids) ? b.ids : [], b.patch);
    changed();
    return sendJson(res, 200, { ok: true, ...r });
  }
  if (p === '/api/archive/empty' && method === 'POST') {
    const ids = L.listItems(LIB).filter((m) => m.status === 'archived').map((m) => m.id);
    const r = L.applyAction(LIB, 'purge', ids);
    changed();
    return sendJson(res, 200, { ok: true, ...r });
  }
  if (p === '/api/reveal-library' && method === 'POST') {
    L.revealPath(path.join(LIB, 'library.json'));
    return sendJson(res, 200, { ok: true });
  }
  if (p === '/api/shutdown' && method === 'POST') {
    sendJson(res, 200, { ok: true });
    log('shutdown requested');
    setTimeout(() => process.exit(0), 100);
    return undefined;
  }
  if (p.startsWith('/media/') && isRead) {
    const rel = decodeURIComponent(p.slice('/media/'.length));
    const abs = path.resolve(LIB, rel);
    if (!abs.startsWith(LIB + path.sep) || /(^|[\\/])\.system([\\/]|$)/.test(rel)) return sendJson(res, 403, { ok: false, error: 'forbidden' });
    return serveFile(req, res, abs);
  }
  return sendJson(res, 404, { ok: false, error: 'not found' });
}

const server = http.createServer((req, res) => {
  route(req, res).catch((e) => {
    if (!e.status) log('error', req.method, req.url, e.stack || e);
    if (!res.headersSent) sendJson(res, e.status || 500, { ok: false, error: String(e.message || e) });
    else res.end();
  });
});
server.on('error', (e) => { log('listen error', e.code || e.message); process.exit(1); });
server.listen(PORT, '127.0.0.1', () => {
  fs.writeFileSync(path.join(LIB, L.DIRS.system, 'server.json'), JSON.stringify({ port: PORT, pid: process.pid, lib: LIB, startedAt: new Date().toISOString() }, null, 2));
  log(`jimeng library server on http://127.0.0.1:${PORT} lib=${LIB}`);
});
