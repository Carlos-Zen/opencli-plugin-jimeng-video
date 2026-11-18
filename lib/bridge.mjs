// 即梦网页桥接服务：把 ArcReel 等工具的「提交 + 轮询」视频生成 API 请求，转成 opencli jimeng video 网页操作。
//   node bridge.mjs --lib <素材库目录> --port 17891 --host 127.0.0.1
//
// 协议（与 arcreel/jimeng-web-bridge.json 声明式端点定义配套）：
//   POST /v1/jimeng/videos        {model, prompt, duration, aspect_ratio, resolution, first_frame, last_frame, refs[], audios[]}
//                                  → {task_id, status}
//   GET  /v1/jimeng/videos/:id    → {task_id, status: queued|processing|completed|failed, video_url, error, duration, record_id}
//   GET  /v1/jimeng/files/:id/video.mp4?sig=…   生成结果（无需令牌，靠签名）
//   兼容 ArcReel 内置「V2 Video Generations」：POST /v2/video/generations、GET /v2/video/generations?generation_id=
//
// 安全与积分：所有接口需 Bearer 令牌；网页操作全局串行；相同请求 30 分钟内重复提交返回原任务；
// 提交途中服务重启的任务直接判失败，绝不自动重交（避免重复扣积分）。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as L from './library.js';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const LIB = path.resolve(arg('lib', L.resolveLibraryDir()));
const CFG = { ...L.DEFAULT_BRIDGE, ...(L.readConfig().bridge || {}) };
const PORT = Number(arg('port', CFG.port));
const HOST = arg('host', CFG.host);
const TOKEN = CFG.token;
// 测试用：网页上只 dry-run（上传 + 填写，不点生成），然后把该已有任务当作生成结果，免费跑通全链路
const REPLAY = arg('replay-record', '');
const REPLAY_IMAGE = arg('replay-image-record', '');
const STATE_DIR = path.join(LIB, L.DIRS.system, 'bridge');
const JOBS_DIR = path.join(STATE_DIR, 'jobs');
const JOBS_FILE = path.join(STATE_DIR, 'jobs.json');
const FILES_DIR = path.join(STATE_DIR, 'files');
const POLL_MS = 15000;
const MAX_RUN_MS = 90 * 60 * 1000;
const DEDUP_MS = 30 * 60 * 1000;
const MAX_BODY = 300 * 1024 * 1024;

if (!TOKEN) { console.error('bridge token missing: run `opencli jimeng bridge token`'); process.exit(1); }
L.ensureLibrary(LIB);
fs.mkdirSync(JOBS_DIR, { recursive: true });
fs.mkdirSync(FILES_DIR, { recursive: true });
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ───────────────────────── job store ─────────────────────────

let jobs = {};
try { jobs = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8')); } catch { jobs = {}; }
for (const j of Object.values(jobs)) {
  if (j.status === 'submitting') {
    j.status = 'failed';
    j.error = '桥接服务在提交途中重启，为避免重复扣积分不会自动重交；请到即梦网页确认该任务是否已提交';
  }
}
function persist() {
  const tmp = `${JOBS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(jobs, null, 2));
  fs.renameSync(tmp, JOBS_FILE);
}
persist();

// ───────────────────────── opencli runner (global serial lock) ─────────────────────────

let lock = Promise.resolve();
const serial = (fn) => { const p = lock.then(fn, fn); lock = p.catch(() => {}); return p; };

let opencliMain = null;
try { opencliMain = fileURLToPath(import.meta.resolve('@jackwener/opencli')); } catch { /* fallback below */ }

function runOpencli(args, timeoutMs) {
  return new Promise((resolve) => {
    const full = [...args, '-f', 'json'];
    const child = opencliMain && fs.existsSync(opencliMain)
      ? spawn(process.execPath, [opencliMain, ...full], { windowsHide: true })
      : spawn('opencli', full, { windowsHide: true, shell: process.platform === 'win32' });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => { child.kill(); }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      const start = out.indexOf('{');
      let json = null;
      if (start >= 0) { try { json = JSON.parse(out.slice(start)); } catch { /* not json */ } }
      if (json && json.ok) resolve({ ok: true, data: json.data });
      else {
        const e = json?.error;
        resolve({ ok: false, error: e ? `${e.message || e.code}${e.hint ? `（${e.hint}）` : ''}` : (err || out || `opencli exited ${code}`).trim().slice(0, 1500) });
      }
    });
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: String(e.message || e) }); });
  });
}

// ───────────────────────── input materialisation ─────────────────────────

const EXT = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif', 'image/bmp': '.bmp',
  'audio/mpeg': '.mp3', 'audio/mp3': '.mp3', 'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/wave': '.wav', 'audio/mp4': '.m4a',
  'audio/aac': '.aac', 'audio/ogg': '.ogg', 'audio/flac': '.flac', 'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm',
};

async function materialize(value, dir, stem, fallbackExt) {
  if (!value || typeof value !== 'string') return null;
  let buf;
  let mime = '';
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(value);
  if (m) {
    mime = (m[1] || '').toLowerCase();
    buf = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8');
  } else if (/^https?:\/\//i.test(value)) {
    const r = await fetch(value);
    if (!r.ok) throw new Error(`下载素材失败 HTTP ${r.status}: ${value.slice(0, 80)}`);
    mime = (r.headers.get('content-type') || '').split(';')[0].toLowerCase();
    buf = Buffer.from(await r.arrayBuffer());
  } else {
    buf = Buffer.from(value, 'base64');
  }
  if (!buf.length) return null;
  const file = path.join(dir, `${stem}${EXT[mime] || fallbackExt}`);
  fs.writeFileSync(file, buf);
  return file;
}

/** ArcReel 的提示词已是 `<名称>@图片N` 写法；把没有对应素材的 @ 引用降为纯文本，避免插件报错。 */
function sanitizePrompt(prompt, counts) {
  return String(prompt || '')
    .replace(/@\[/g, '[')
    .replace(/@(图片|视频|音频|素材)(\d+)/g, (all, kind, n) => {
      const max = { 图片: counts.image, 视频: counts.video, 音频: counts.audio, 素材: counts.image + counts.video + counts.audio }[kind];
      return Number(n) >= 1 && Number(n) <= max ? all : `${kind}${n}`;
    });
}

async function prepareImageJob(id, body) {
  const dir = path.join(JOBS_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  const refs = Array.isArray(body.refs) ? body.refs.filter(Boolean) : [];
  const upload = [];
  for (let i = 0; i < refs.length; i++) {
    const f = await materialize(refs[i], dir, `img${i + 1}`, '.png');
    if (f) upload.push(f);
  }
  if (upload.length > 10) throw new Error(`参考图共 ${upload.length} 张，超过上限 10 张`);
  // ArcReel 的图片提示词用「图N」指代参考图；即梦网页用 @图片N，补成可点选的引用
  let prompt = String(body.prompt || '').replace(/(^|[^@\w])图(\d+)(?![\d片])/g, (all, pre, n) => (Number(n) >= 1 && Number(n) <= upload.length ? `${pre}@图片${n}` : all));
  prompt = sanitizePrompt(prompt, { image: upload.length, video: 0, audio: 0 });
  if (!prompt.trim()) throw new Error('prompt 为空');
  return { dir, mode: '图片生成', prompt, upload };
}

async function prepareJob(id, body) {
  const dir = path.join(JOBS_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  const refs = Array.isArray(body.refs) ? body.refs.filter(Boolean) : [];
  const audios = Array.isArray(body.audios) ? body.audios.filter(Boolean) : [];
  const files = [];
  for (let i = 0; i < refs.length; i++) files.push(await materialize(refs[i], dir, `img${i + 1}`, '.png'));
  const first = await materialize(body.first_frame, dir, 'first_frame', '.png');
  const last = await materialize(body.last_frame, dir, 'last_frame', '.png');
  const audioFiles = [];
  for (let i = 0; i < audios.length; i++) audioFiles.push(await materialize(audios[i], dir, `audio${i + 1}`, '.mp3'));
  const images = files.filter(Boolean);
  const auds = audioFiles.filter(Boolean);

  let mode = '全能参考';
  let prompt = String(body.prompt || '');
  let upload;
  if (!images.length && !auds.length && (first || last)) {
    // 只有首/尾帧：走即梦「首尾帧」模式（该模式输入框不支持 @ 引用）
    mode = '首尾帧';
    upload = [first, last].filter(Boolean);
    prompt = sanitizePrompt(prompt, { image: 0, video: 0, audio: 0 });
  } else {
    upload = [...images];
    const lead = [];
    if (first) { upload.push(first); lead.push(`首帧画面：@图片${upload.length}`); }
    if (last) { upload.push(last); lead.push(`尾帧画面：@图片${upload.length}`); }
    upload.push(...auds);
    if (lead.length) prompt = `${lead.join('；')}。\n${prompt}`;
    prompt = sanitizePrompt(prompt, { image: images.length + (first ? 1 : 0) + (last ? 1 : 0), video: 0, audio: auds.length });
  }
  if (upload.length > 12) throw new Error(`素材共 ${upload.length} 个，超过即梦上限 12 个`);
  if (!prompt.trim()) throw new Error('prompt 为空');
  return { dir, mode, prompt, upload };
}

// ───────────────────────── worker ─────────────────────────

const libFile = (j) => (j.kind === 'image' ? j.imagePath : j.videoPath) && fs.existsSync(j.kind === 'image' ? j.imagePath : j.videoPath);

/** 图片任务完成：下载第一张图到 .system/bridge/files/，由桥接服务带签名提供下载 */
async function finishImage(j, rows) {
  const st = rows[0]?.status;
  if (st === 'failed') {
    j.status = 'failed';
    j.error = `即梦生成失败: ${rows[0].fail_msg || 'unknown'}（record ${j.record_id}）`;
  } else if (st === 'succeeded' && rows.some((x) => x.video_url)) {
    const url = rows.find((x) => x.video_url).video_url;
    try {
      const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://jimeng.jianying.com/' } });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const ct = (resp.headers.get('content-type') || '').toLowerCase();
      const file = path.join(FILES_DIR, `${j.id}${ct.includes('jpeg') ? '.jpg' : ct.includes('webp') ? '.webp' : '.png'}`);
      fs.writeFileSync(file, Buffer.from(await resp.arrayBuffer()));
      j.imagePath = file;
    } catch (e) {
      j.saveError = String(e.message || e);
      j.remoteUrl = url;
    }
    j.status = 'completed';
    j.completedAt = new Date().toISOString();
    try { for (const f of fs.readdirSync(j.dir)) fs.unlinkSync(path.join(j.dir, f)); fs.rmdirSync(j.dir); } catch { /* ignore */ }
    log('completed', j.id, 'image record', j.record_id, j.imagePath || `save error: ${j.saveError}`);
  } else if (Date.now() - Date.parse(j.submittedAt) > MAX_RUN_MS) {
    j.status = 'failed';
    j.error = `生成超时（record ${j.record_id}）`;
  }
  j.lastPollAt = new Date().toISOString();
  persist();
}

async function submitJob(j) {
  j.status = 'submitting';
  j.submittingAt = new Date().toISOString();
  persist();
  const isImage = j.kind === 'image';
  const replay = isImage ? REPLAY_IMAGE : REPLAY;
  const args = isImage
    ? ['jimeng', 'image', j.prompt, '--count', '1', '--wait', 'false', '--timeout', '300', '--workspace', 'new']
    : ['jimeng', 'video', j.prompt, '--mode', j.mode, '--wait', 'false', '--save', 'false', '--open-ui', 'false', '--timeout', '600', '--workspace', 'new'];
  if (j.upload.length) args.push('--files', JSON.stringify(j.upload));
  if (j.model) args.push('--model', j.model);
  if (j.aspect_ratio && j.mode !== '首尾帧') args.push('--ratio', j.aspect_ratio);
  if (j.resolution) args.push('--resolution', j.resolution);
  if (j.duration && !isImage) args.push('--duration', String(j.duration));
  if (Number(CFG.maxCredits) > 0) args.push('--max-credits', String(CFG.maxCredits));
  if (replay) args.push('--dry-run');
  log('submit', j.id, j.mode, `files=${j.upload.length}`, `model=${j.model || '(current)'}`);
  const r = await runOpencli(args, 11 * 60 * 1000);
  const row = r.ok ? (Array.isArray(r.data) ? r.data[0] : r.data) : null;
  if (row?.warnings?.length) log('warnings', j.id, row.warnings.join('; '));
  if (replay && row?.status === 'dry-run') {
    row.record_id = replay;
    j.dry_run_prompt = row.prompt;
    log('replay mode: dry-run ok, using record', replay, 'filled prompt =', JSON.stringify(row.prompt).slice(0, 400));
  }
  if (!r.ok || !row?.record_id) {
    j.status = 'failed';
    j.error = `提交失败: ${r.error || '未返回 record_id'}`;
    log('submit failed', j.id, j.error);
  } else {
    j.status = 'submitted';
    j.record_id = String(row.record_id);
    j.workspace_id = row.workspace_id || null;
    j.credits = row.credits ?? null;
    j.generation = { model: row.model, mode: row.mode, ratio_resolution: row.ratio_resolution, duration: row.duration, credits: row.credits };
    j.submittedAt = new Date().toISOString();
    log('submitted', j.id, 'record', j.record_id, 'credits', j.credits);
  }
  persist();
}

async function pollJob(j) {
  const r = await runOpencli(['jimeng', 'video-status', j.record_id, '--timeout', '120', ...(j.kind === 'image' ? ['--kind', 'image'] : [])], 3 * 60 * 1000);
  if (r.ok && j.kind === 'image') return finishImage(j, Array.isArray(r.data) ? r.data : [r.data]);
  if (!r.ok) {
    j.lastPollError = r.error;
    if (Date.now() - Date.parse(j.submittedAt) > MAX_RUN_MS) { j.status = 'failed'; j.error = `生成超时（record ${j.record_id}）`; }
    persist();
    return;
  }
  const rows = Array.isArray(r.data) ? r.data : [r.data];
  const st = rows[0]?.status;
  if (st === 'failed') {
    j.status = 'failed';
    j.error = `即梦生成失败: ${rows[0].fail_msg || 'unknown'}（record ${j.record_id}）`;
  } else if (st === 'succeeded' && rows.some((x) => x.video_url)) {
    const [ratio, resolution] = String(j.generation?.ratio_resolution || '').split(/\s+/);
    const files = j.upload.map((p) => {
      const name = path.basename(p);
      const ext = path.extname(name).toLowerCase();
      const kind = ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac'].includes(ext) ? 'audio' : ['.mp4', '.mov', '.webm'].includes(ext) ? 'video' : 'image';
      return { path: p, name, label: path.basename(name, ext), kind, size: fs.statSync(p).size };
    });
    try {
      const items = await L.saveToLibrary(LIB, {
        recordId: j.record_id,
        workspaceId: j.workspace_id,
        createdAt: j.submittedAt,
        prompt: j.prompt,
        promptRaw: j.prompt_raw,
        project: CFG.project || 'ArcReel',
        tags: ['ArcReel'],
        references: files,
        generation: { model: j.generation?.model || j.model, mode: j.mode, ratio: ratio || j.aspect_ratio || '', resolution: resolution || j.resolution || '', duration: j.generation?.duration || (j.duration ? `${j.duration}s` : ''), credits: j.credits },
        videos: rows.filter((x) => x.video_url).map((x) => ({ url: x.video_url, cover: x.cover_url, width: x.width, height: x.height })),
        source: 'arcreel-bridge',
      });
      j.items = items.map((x) => x.id);
      j.videoPath = items[0]?.videoPath || null;
      L.showInUi(LIB, items.filter((x) => !x.duplicate).map((x) => x.id), { open: false }).catch(() => {});
    } catch (e) {
      j.saveError = String(e.message || e);
      j.remoteUrl = rows.find((x) => x.video_url).video_url; // 入库失败时退回即梦签名链接
    }
    j.status = 'completed';
    j.completedAt = new Date().toISOString();
    try { for (const f of fs.readdirSync(j.dir)) fs.unlinkSync(path.join(j.dir, f)); fs.rmdirSync(j.dir); } catch { /* ignore */ }
    log('completed', j.id, 'record', j.record_id, j.saveError ? `save error: ${j.saveError}` : j.videoPath);
  } else if (Date.now() - Date.parse(j.submittedAt) > MAX_RUN_MS) {
    j.status = 'failed';
    j.error = `生成超时（record ${j.record_id}）`;
  }
  j.lastPollAt = new Date().toISOString();
  persist();
}

let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    for (const j of Object.values(jobs).filter((x) => x.status === 'queued').sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      await serial(() => submitJob(j).catch((e) => { j.status = 'failed'; j.error = String(e.message || e); persist(); }));
    }
    const now = Date.now();
    for (const j of Object.values(jobs).filter((x) => x.status === 'submitted')) {
      if (j.lastPollAt && now - Date.parse(j.lastPollAt) < POLL_MS) continue;
      await serial(() => pollJob(j).catch((e) => { j.lastPollError = String(e.message || e); persist(); }));
    }
  } finally {
    ticking = false;
  }
}
setInterval(() => { tick(); }, 3000);

// ───────────────────────── HTTP ─────────────────────────

const sign = (id) => crypto.createHmac('sha256', TOKEN).update(id).digest('hex').slice(0, 32);
const safeEq = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

function send(res, code, obj) {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': b.length, 'cache-control': 'no-store' });
  res.end(b);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw Object.assign(new Error('request too large'), { status: 413 });
    chunks.push(c);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw Object.assign(new Error('invalid JSON'), { status: 400 }); }
}

async function createJob(body, kind = 'video') {
  const hash = crypto.createHash('sha1').update(kind + JSON.stringify(body)).digest('hex');
  const dup = Object.values(jobs).find((j) => j.hash === hash && j.status !== 'failed' && Date.now() - Date.parse(j.createdAt) < DEDUP_MS);
  if (dup) { log('dedup', dup.id); return dup; }
  const id = `jb_${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;
  const prep = kind === 'image' ? await prepareImageJob(id, body) : await prepareJob(id, body);
  const j = {
    id, kind, hash, status: 'queued', createdAt: new Date().toISOString(),
    model: String(body.model || (kind === 'image' ? CFG.defaultImageModel : CFG.defaultModel) || '').trim(),
    prompt_raw: String(body.prompt || ''),
    prompt: prep.prompt, mode: prep.mode, upload: prep.upload, dir: prep.dir,
    aspect_ratio: body.aspect_ratio ? String(body.aspect_ratio) : '',
    resolution: body.resolution ? String(body.resolution).toLowerCase() : '',
    duration: Number(body.duration) || 0,
  };
  jobs[id] = j;
  persist();
  log('queued', id, j.mode, `files=${j.upload.length}`);
  setImmediate(tick);
  return j;
}

function view(j, req) {
  const status = { queued: 'queued', submitting: 'processing', submitted: 'processing', completed: 'completed', failed: 'failed' }[j.status] || 'processing';
  let mediaUrl = null;
  const isImage = j.kind === 'image';
  if (j.status === 'completed') {
    mediaUrl = libFile(j) ? `http://${req.headers.host}/v1/jimeng/files/${j.id}/${isImage ? 'image' : 'video.mp4'}?sig=${sign(j.id)}` : (j.remoteUrl || null);
  }
  const queuedAhead = j.status === 'queued' ? Object.values(jobs).filter((x) => x.status === 'queued' && x.createdAt < j.createdAt).length : 0;
  return {
    task_id: j.id, id: j.id, kind: j.kind || 'video', status,
    ...(isImage ? { image_url: mediaUrl } : { video_url: mediaUrl }),
    error: j.status === 'failed' ? j.error : null,
    duration: j.duration || null, record_id: j.record_id || null, credits: j.credits ?? null, queued_ahead: queuedAhead,
    library_items: j.items || [],
  };
}

function serveVideo(req, res, j) {
  const file = j.kind === 'image' ? j.imagePath : j.videoPath;
  const st = fs.statSync(file);
  const ext = path.extname(file).toLowerCase();
  const type = j.kind === 'image' ? (ext === '.jpg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png') : 'video/mp4';
  const headers = { 'content-type': type, 'accept-ranges': 'bytes' };
  let start = 0;
  let end = st.size - 1;
  let code = 200;
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (m && (m[1] || m[2])) {
    if (m[1] === '') start = Math.max(0, st.size - Number(m[2]));
    else { start = Number(m[1]); if (m[2]) end = Math.min(Number(m[2]), st.size - 1); }
    code = 206;
    headers['content-range'] = `bytes ${start}-${end}/${st.size}`;
  }
  headers['content-length'] = end - start + 1;
  res.writeHead(code, headers);
  if (req.method === 'HEAD') return res.end();
  const s = fs.createReadStream(file, { start, end });
  s.pipe(res);
  res.on('close', () => s.destroy());
  return undefined;
}

async function route(req, res) {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = u.pathname.replace(/\/+$/, '');

  if (p === '/v1/jimeng/ping') return send(res, 200, { ok: true, app: 'jimeng-bridge', lib: LIB, pid: process.pid, port: PORT, replay: REPLAY || null, replay_image: REPLAY_IMAGE || null });

  let m = /^\/v1\/jimeng\/files\/([\w-]+)\/(?:video\.mp4|image)$/.exec(p);
  if (m && (req.method === 'GET' || req.method === 'HEAD')) {
    const j = jobs[m[1]];
    if (!j || !safeEq(u.searchParams.get('sig') || '', sign(m[1])) || !libFile(j)) return send(res, 404, { error: 'not found' });
    return serveVideo(req, res, j);
  }

  const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!safeEq(auth, TOKEN)) return send(res, 401, { error: 'invalid or missing bridge token (Authorization: Bearer …)' });

  if (p === '/v1/jimeng/videos' && req.method === 'POST') {
    const j = await createJob(await readJson(req));
    return send(res, 200, view(j, req));
  }
  if (p === '/v1/jimeng/images' && req.method === 'POST') {
    const j = await createJob(await readJson(req), 'image');
    return send(res, 200, view(j, req));
  }
  m = /^\/v1\/jimeng\/(?:videos|images)\/([\w-]+)$/.exec(p);
  if (m && req.method === 'GET') {
    const j = jobs[m[1]];
    return j ? send(res, 200, view(j, req)) : send(res, 404, { error: `task ${m[1]} not found` });
  }
  if (p === '/v1/jimeng/videos' && req.method === 'GET') {
    return send(res, 200, { data: Object.values(jobs).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100).map((j) => ({ ...view(j, req), created_at: j.createdAt, mode: j.mode, model: j.model, prompt: j.prompt_raw.slice(0, 120) })) });
  }
  // ArcReel 内置「V2 Video Generations」兼容
  if (p === '/v2/video/generations' && req.method === 'POST') {
    const b = await readJson(req);
    const j = await createJob({ model: b.model, prompt: b.prompt, duration: b.duration, aspect_ratio: b.aspect_ratio, resolution: b.resolution, first_frame: b.image_url, last_frame: b.last_image_url, refs: b.image_urls });
    const v = view(j, req);
    return send(res, 200, { ...v, generation_id: j.id });
  }
  if (p === '/v2/video/generations' && req.method === 'GET') {
    const j = jobs[u.searchParams.get('generation_id') || ''];
    if (!j) return send(res, 404, { error: 'generation not found' });
    const v = view(j, req);
    return send(res, 200, { ...v, generation_id: j.id, video: v.video_url ? { url: v.video_url } : null });
  }
  if (p === '/v1/jimeng/shutdown' && req.method === 'POST') {
    send(res, 200, { ok: true });
    setTimeout(() => process.exit(0), 100);
    return undefined;
  }
  return send(res, 404, { error: 'not found' });
}

const server = http.createServer((req, res) => {
  route(req, res).catch((e) => {
    if (!e.status) log('error', req.method, req.url, e.stack || e);
    if (!res.headersSent) send(res, e.status || 400, { error: String(e.message || e) });
    else res.end();
  });
});
server.on('error', (e) => { log('listen error', e.code || e.message); process.exit(1); });
server.listen(PORT, HOST, () => {
  fs.writeFileSync(path.join(STATE_DIR, 'server.json'), JSON.stringify({ port: PORT, host: HOST, pid: process.pid, lib: LIB, startedAt: new Date().toISOString() }, null, 2));
  log(`jimeng bridge on http://${HOST}:${PORT} lib=${LIB} maxCredits=${CFG.maxCredits || 0}${REPLAY ? ` REPLAY=${REPLAY}（测试模式，不会真实提交）` : ''}`);
  tick();
});
