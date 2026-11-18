// 即梦素材库（Jimeng video library）— 纯 Node 实现，不依赖 opencli，供 CLI 命令与本地服务共用。
//
// 目录规范（schema: jimeng-video-library v1）:
//   <库>/library.json                         素材库标识与版本
//   <库>/README.md                            规范说明（自动生成）
//   <库>/videos/<项目>/<时间>_<标题>_<任务ID>-<序号>/{video.mp4, cover.jpg, meta.json}   在库素材
//   <库>/archive/<项目>/<同名文件夹>/            已移除（归档）素材，结构与 videos 相同
//   <库>/refs/<sha1>.<ext>                     生成时使用的参考素材（按内容去重，多个视频共享）
//   <库>/.system/{server.json, server.log, activity.jsonl}   服务状态、日志、操作记录
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const APP_ID = 'jimeng-library';
export const SCHEMA = 'jimeng-video-library';
export const SCHEMA_VERSION = 1;
export const DEFAULT_PORT = 17890;
export const DEFAULT_PROJECT = '未分类';
export const DIRS = { videos: 'videos', archive: 'archive', refs: 'refs', system: '.system' };
const ROOT_OF = { active: DIRS.videos, archived: DIRS.archive };
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.join(os.homedir(), '.opencli', 'jimeng-video.json');

// ───────────────────────── config ─────────────────────────

export function expandHome(p) {
  if (!p) return p;
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(1));
  return p;
}
export function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
}
export function writeConfig(patch) {
  const c = { ...readConfig(), ...patch };
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2));
  return c;
}
export const configPath = () => CONFIG_FILE;
export function defaultLibraryDir() {
  return path.join(os.homedir(), 'Videos', 'JimengLibrary');
}
/** 优先级: 参数 > 环境变量 JIMENG_LIBRARY > ~/.opencli/jimeng-video.json > ~/Videos/JimengLibrary */
export function resolveLibraryDir(override) {
  const v = (override && String(override).trim()) || process.env.JIMENG_LIBRARY || readConfig().libraryDir || defaultLibraryDir();
  return path.resolve(expandHome(v));
}

// ───────────────────────── fs helpers ─────────────────────────

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
function writeJsonAtomic(file, obj) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  renameRetry(tmp, file);
}
function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
/** Windows 上文件被播放器/杀软短暂占用时 rename 会 EPERM/EBUSY，重试几次 */
function renameRetry(src, dest) {
  for (let i = 0; ; i++) {
    try { fs.renameSync(src, dest); return; } catch (e) {
      if (i >= 15 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      sleepSync(200);
    }
  }
}
export function sanitizeName(name, max = 60) {
  let s = String(name ?? '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim();
  s = s.slice(0, max).replace(/[. ]+$/g, '');
  if (!s) s = '_';
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(s)) s = `_${s}`;
  return s;
}
function uniqueDir(dir) {
  if (!fs.existsSync(dir)) return dir;
  for (let i = 2; ; i++) if (!fs.existsSync(`${dir}~${i}`)) return `${dir}~${i}`;
}
function removeIfEmpty(dir) { try { if (!fs.readdirSync(dir).length) fs.rmdirSync(dir); } catch { /* ignore */ } }
function moveDir(src, dest) {
  dest = uniqueDir(dest);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  renameRetry(src, dest);
  removeIfEmpty(path.dirname(src));
  return dest;
}
const pad = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const toPosix = (p) => p.split(path.sep).join('/');

// ───────────────────────── library bootstrap ─────────────────────────

const LIBRARY_README = `# 即梦素材库

本目录由 [opencli-plugin-jimeng-video](https://github.com/Carlos-Zen/opencli-plugin-jimeng-video) 管理。
打开管理页面：\`opencli jimeng library\`

## 目录规范

\`\`\`
library.json                  素材库标识（schema / 版本 / 创建时间）
videos/<项目>/<生成时间>_<标题>_<任务ID>-<序号>/
    video.mp4                 生成的视频
    cover.jpg                 封面（可能缺失）
    meta.json                 标注与生成上下文（见下）
archive/<项目>/<同名文件夹>/     已移除的素材（归档），结构与 videos 相同；可在管理页恢复或永久删除
refs/<sha1>.<扩展名>            生成时上传的参考素材，按内容去重，被多个视频共享
.system/server.json           本地管理服务（端口、进程）
.system/server.log            服务日志
.system/activity.jsonl        操作记录：入库 / 编辑 / 归档 / 恢复 / 永久删除
\`\`\`

## meta.json 主要字段

| 字段 | 说明 |
|------|------|
| id | \`<任务ID>-<序号>\`，全库唯一 |
| title / project / tags / note / rating / favorite | 标注：标题、项目、标签、备注、评分(0-5)、收藏 —— 可在管理页编辑 |
| autoTags | 根据生成上下文自动生成的标签（模型、模式、比例、时长、参考类型、主体） |
| status | active（在库）/ archived（已归档），与所在根目录一致 |
| prompt / promptRaw | 提交时的提示词（@[标签] 表示引用）/ 命令行原始输入 |
| references | 参考素材：label、kind(image/video/audio)、file(refs/…)、原文件名 |
| subjects | 引用的资产库主体 |
| generation | model / mode / ratio / resolution / duration / credits / workspaceId |
| createdAt / savedAt / archivedAt | 生成时间 / 入库时间 / 归档时间 |

请通过管理页修改项目、归档或删除；在资源管理器中手工移动文件夹也可以（只要放在 videos/ 或 archive/ 下的 <项目>/ 里），管理页刷新后即可识别。
`;

export function ensureLibrary(lib) {
  for (const d of Object.values(DIRS)) fs.mkdirSync(path.join(lib, d), { recursive: true });
  const info = path.join(lib, 'library.json');
  if (!fs.existsSync(info)) {
    writeJsonAtomic(info, { schema: SCHEMA, schemaVersion: SCHEMA_VERSION, createdAt: new Date().toISOString() });
  } else {
    const j = readJson(info);
    if (j && j.schema && j.schema !== SCHEMA) throw new Error(`${lib} 不是即梦素材库（schema=${j.schema}）`);
  }
  const readme = path.join(lib, 'README.md');
  if (!fs.existsSync(readme)) fs.writeFileSync(readme, LIBRARY_README);
  return lib;
}

export function logActivity(lib, entry) {
  try {
    fs.appendFileSync(path.join(lib, DIRS.system, 'activity.jsonl'), `${JSON.stringify({ t: new Date().toISOString(), ...entry })}\n`);
  } catch { /* ignore */ }
}

// ───────────────────────── titles & tags ─────────────────────────

export function makeTitle(prompt) {
  const t = String(prompt || '')
    .replace(/@\[[^\]]*\]/g, ' ')
    .replace(/@(图片|视频|音频|素材)\d+/g, ' ')
    .replace(/\[(图片|视频|音频)\d+\]/g, ' ')
    .replace(/【[^】]*】/g, ' ')
    .replace(/[*#>`_~|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const first = t.split(/[。！？!?\n；;，,：:]/).map((s) => s.trim()).find((s) => s.length >= 2) || t;
  return first.slice(0, 24) || '未命名';
}

export function normTags(list) {
  const arr = Array.isArray(list) ? list : String(list || '').split(/[,，、;；]/);
  return [...new Set(arr.map((s) => String(s).trim().slice(0, 30)).filter(Boolean))].slice(0, 50);
}

function buildAutoTags({ generation = {}, references = [], subjects = [], prompt = '', source = 'video' }) {
  const tags = [];
  if (generation.model) tags.push(generation.model.replace(/^即梦\s*/, ''));
  if (generation.mode) tags.push(generation.mode);
  if (generation.ratio) tags.push(generation.ratio);
  if (generation.resolution) tags.push(generation.resolution);
  if (generation.duration) tags.push(String(generation.duration).replace(/s?$/, 's'));
  const kinds = new Set(references.map((r) => r.kind));
  // 导入的历史任务没有素材文件，从提示词中的 [图片1] / @视频1 等占位推断
  for (const [re, k] of [[/[[@]图片d+/, 'image'], [/[[@]视频d+/, 'video'], [/[[@]音频d+/, 'audio']]) if (re.test(prompt)) kinds.add(k);
  if (kinds.has('image')) tags.push('图片参考');
  if (kinds.has('video')) tags.push('视频参考');
  if (kinds.has('audio')) tags.push('音频参考');
  if (subjects.length) tags.push('主体参考', ...subjects);
  if (!kinds.size && !subjects.length && source === 'video') tags.push('文生视频');
  return normTags(tags);
}

// ───────────────────────── references (refs/) ─────────────────────────

async function sha1File(file) {
  const h = crypto.createHash('sha1');
  await pipeline(fs.createReadStream(file), h);
  return h.digest('hex');
}

/** files: [{path, name, label, kind, size}] → 复制到 refs/<sha1>.<ext>（已存在则复用） */
async function storeRefs(lib, files) {
  const out = [];
  for (const f of files || []) {
    try {
      const sha1 = await sha1File(f.path);
      const ext = path.extname(f.path).toLowerCase();
      const rel = `${DIRS.refs}/${sha1.slice(0, 20)}${ext}`;
      const abs = path.join(lib, rel);
      if (!fs.existsSync(abs)) await fsp.copyFile(f.path, abs);
      out.push({ label: f.label, kind: f.kind, name: f.name, size: f.size, sha1, file: rel });
    } catch (e) {
      out.push({ label: f.label, kind: f.kind, name: f.name, size: f.size, file: null, error: String(e.message || e) });
    }
  }
  return out;
}

export function gcRefs(lib) {
  const used = new Set();
  for (const it of listItems(lib)) for (const r of it.references || []) if (r.file) used.add(r.file);
  let removed = 0;
  for (const f of fs.readdirSync(path.join(lib, DIRS.refs))) {
    if (!used.has(`${DIRS.refs}/${f}`)) { try { fs.unlinkSync(path.join(lib, DIRS.refs, f)); removed++; } catch { /* ignore */ } }
  }
  return removed;
}

// ───────────────────────── save ─────────────────────────

async function downloadTo(src, dest) {
  const tmp = `${dest}.part`;
  if (!/^https?:/i.test(src)) {
    await fsp.copyFile(src, tmp);
  } else {
    const resp = await fetch(src, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://jimeng.jianying.com/' } });
    if (!resp.ok || !resp.body) throw new Error(`HTTP ${resp.status}`);
    await pipeline(Readable.fromWeb(resp.body), fs.createWriteStream(tmp));
  }
  renameRetry(tmp, dest);
}

/**
 * 把一次生成的结果存入素材库。
 * ctx: { recordId, submitId, workspaceId, createdAt(秒/ms/ISO), prompt, promptRaw, title, project, tags,
 *        references:[parseFiles 结果], subjects:[名称], generation:{...}, videos:[{url, cover, width, height, duration}], source }
 * 同一 <任务ID>-<序号> 已在库（含归档）时不会重复下载。
 */
export async function saveToLibrary(lib, ctx) {
  ensureLibrary(lib);
  const existing = new Map(listItems(lib).map((m) => [m.id, m]));
  const project = cleanProject(ctx.project);
  const created = toDate(ctx.createdAt);
  const baseTitle = (ctx.title && String(ctx.title).trim()) || makeTitle(ctx.promptRaw || ctx.prompt);
  const videos = (ctx.videos || []).filter((v) => v && v.url);
  const pending = videos.map((v, i) => ({ v, id: `${ctx.recordId}-${i + 1}`, index: i + 1 })).filter((x) => !existing.has(x.id));
  const references = pending.length ? await storeRefs(lib, ctx.references) : [];
  const subjects = normTags(ctx.subjects || []);
  const generation = ctx.generation || {};
  const autoTags = buildAutoTags({ generation, references, subjects, prompt: `${ctx.promptRaw || ''}
${ctx.prompt || ''}`, source: ctx.source });
  const results = [];
  for (const x of videos.map((v, i) => ({ id: `${ctx.recordId}-${i + 1}` }))) {
    if (existing.has(x.id)) results.push({ ...publicItem(existing.get(x.id)), duplicate: true });
  }
  for (const { v, id, index } of pending) {
    const title = videos.length > 1 ? `${baseTitle} #${index}` : baseTitle;
    const folder = sanitizeName(`${stamp(created)}_${baseTitle}_${id}`, 90);
    const dir = uniqueDir(path.join(lib, DIRS.videos, sanitizeName(project), folder));
    fs.mkdirSync(dir, { recursive: true });
    try {
      await downloadTo(v.url, path.join(dir, 'video.mp4'));
    } catch (e) {
      fs.rmSync(dir, { recursive: true, force: true });
      removeIfEmpty(path.dirname(dir));
      throw new Error(`视频下载失败 (${id}): ${e.message || e}`);
    }
    let cover = null;
    if (v.cover) { try { await downloadTo(v.cover, path.join(dir, 'cover.jpg')); cover = 'cover.jpg'; } catch { /* 封面可缺失 */ } }
    const meta = {
      schema: SCHEMA,
      schemaVersion: SCHEMA_VERSION,
      id,
      recordId: String(ctx.recordId),
      submitId: ctx.submitId || null,
      index,
      total: videos.length,
      title,
      project,
      tags: normTags(ctx.tags),
      autoTags,
      note: '',
      rating: 0,
      favorite: false,
      status: 'active',
      createdAt: created.toISOString(),
      savedAt: new Date().toISOString(),
      updatedAt: null,
      archivedAt: null,
      prompt: ctx.prompt || '',
      promptRaw: ctx.promptRaw || '',
      references,
      subjects,
      generation: { ...generation, workspaceId: ctx.workspaceId || generation.workspaceId || null },
      video: {
        file: 'video.mp4',
        width: v.width || null,
        height: v.height || null,
        duration: v.duration || null,
        size: fs.statSync(path.join(dir, 'video.mp4')).size,
      },
      cover,
      source: ctx.source || 'video',
    };
    writeJsonAtomic(path.join(dir, 'meta.json'), meta);
    logActivity(lib, { action: 'saved', id, dir: toPosix(path.relative(lib, dir)) });
    results.push({ ...publicItem({ ...meta, _dir: dir, _rel: toPosix(path.relative(lib, dir)) }), duplicate: false });
  }
  return results;
}

function toDate(v) {
  if (v == null || v === '') return new Date();
  if (typeof v === 'number') return new Date(v < 1e12 ? v * 1000 : v);
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}
export function cleanProject(p) {
  const s = String(p ?? '').replace(/[\\/:*?"<>|\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  return s || DEFAULT_PROJECT;
}

// ───────────────────────── query ─────────────────────────

export function listItems(lib) {
  const out = [];
  for (const [status, root] of Object.entries(ROOT_OF)) {
    const rootAbs = path.join(lib, root);
    let projects = [];
    try { projects = fs.readdirSync(rootAbs, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { continue; }
    for (const p of projects) {
      let folders = [];
      try { folders = fs.readdirSync(path.join(rootAbs, p.name), { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { continue; }
      for (const f of folders) {
        const dir = path.join(rootAbs, p.name, f.name);
        const meta = readJson(path.join(dir, 'meta.json'));
        if (!meta || meta.schema !== SCHEMA || !meta.id) continue;
        meta.status = status; // 所在根目录为准
        meta._dir = dir;
        meta._rel = `${root}/${p.name}/${f.name}`;
        meta._missing = !fs.existsSync(path.join(dir, meta.video?.file || 'video.mp4'));
        out.push(meta);
      }
    }
  }
  return out;
}

export function publicItem(m) {
  const { _dir, ...rest } = m;
  return { ...rest, path: _dir, videoPath: _dir ? path.join(_dir, m.video?.file || 'video.mp4') : null };
}

function findItem(lib, id) {
  const it = listItems(lib).find((m) => m.id === id);
  if (!it) throw Object.assign(new Error(`素材不存在: ${id}`), { status: 404 });
  return it;
}

function strip(m) { const { _dir, _rel, _missing, ...meta } = m; return meta; }

// ───────────────────────── mutations ─────────────────────────

export function updateItem(lib, id, patch = {}) {
  const it = findItem(lib, id);
  const meta = strip(it);
  if ('title' in patch) meta.title = String(patch.title ?? '').trim().slice(0, 200) || meta.title;
  if ('note' in patch) meta.note = String(patch.note ?? '').slice(0, 5000);
  if ('rating' in patch) meta.rating = Math.max(0, Math.min(5, Math.round(Number(patch.rating) || 0)));
  if ('favorite' in patch) meta.favorite = Boolean(patch.favorite);
  if ('tags' in patch) meta.tags = normTags(patch.tags);
  if (patch.addTags) meta.tags = normTags([...(meta.tags || []), ...normTags(patch.addTags)]);
  if (patch.removeTags) {
    const rm = new Set(normTags(patch.removeTags));
    meta.tags = (meta.tags || []).filter((t) => !rm.has(t));
    meta.autoTags = (meta.autoTags || []).filter((t) => !rm.has(t));
  }
  let dir = it._dir;
  if ('project' in patch) {
    const np = cleanProject(patch.project);
    if (np !== meta.project) {
      dir = moveDir(dir, path.join(lib, ROOT_OF[it.status], sanitizeName(np), path.basename(dir)));
      meta.project = np;
    }
  }
  meta.updatedAt = new Date().toISOString();
  writeJsonAtomic(path.join(dir, 'meta.json'), meta);
  logActivity(lib, { action: 'updated', id, fields: Object.keys(patch) });
  return { ...meta, _dir: dir, _rel: toPosix(path.relative(lib, dir)) };
}

function setStatus(lib, it, status) {
  const meta = strip(it);
  const dest = moveDir(it._dir, path.join(lib, ROOT_OF[status], sanitizeName(meta.project), path.basename(it._dir)));
  meta.status = status;
  meta.archivedAt = status === 'archived' ? new Date().toISOString() : null;
  writeJsonAtomic(path.join(dest, 'meta.json'), meta);
  logActivity(lib, { action: status === 'archived' ? 'archived' : 'restored', id: meta.id, dir: toPosix(path.relative(lib, dest)) });
}

/** action: archive | restore | purge | update | reveal */
export function applyAction(lib, action, ids, patch) {
  const byId = new Map(listItems(lib).map((m) => [m.id, m]));
  const done = [];
  const errors = [];
  for (const id of ids || []) {
    const it = byId.get(id);
    if (!it) { errors.push({ id, error: '不存在' }); continue; }
    try {
      if (action === 'archive') { if (it.status === 'active') setStatus(lib, it, 'archived'); }
      else if (action === 'restore') { if (it.status === 'archived') setStatus(lib, it, 'active'); }
      else if (action === 'purge') {
        if (it.status !== 'archived') throw new Error('只能永久删除已归档的素材，请先归档');
        fs.rmSync(it._dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
        removeIfEmpty(path.dirname(it._dir));
        logActivity(lib, { action: 'purged', id, title: it.title });
      } else if (action === 'update') updateItem(lib, id, patch || {});
      else if (action === 'reveal') revealPath(path.join(it._dir, it.video?.file || 'video.mp4'));
      else throw new Error(`未知操作 ${action}`);
      done.push(id);
    } catch (e) {
      errors.push({ id, error: String(e.message || e) });
    }
  }
  if (action === 'purge' && done.length) gcRefs(lib);
  return { done, errors };
}

export function libraryStats(lib) {
  const items = listItems(lib);
  const sum = (list) => list.reduce((s, m) => s + (m.video?.size || 0), 0);
  const active = items.filter((m) => m.status === 'active');
  const archived = items.filter((m) => m.status === 'archived');
  return { active: active.length, archived: archived.length, activeBytes: sum(active), archivedBytes: sum(archived), projects: [...new Set(active.map((m) => m.project))].length };
}

// ───────────────────────── OS helpers ─────────────────────────

const DETACHED = { detached: true, stdio: 'ignore', windowsHide: true };
export function openUrl(url) {
  let child;
  if (process.platform === 'win32') child = spawn('rundll32', ['url.dll,FileProtocolHandler', url], DETACHED);
  else if (process.platform === 'darwin') child = spawn('open', [url], DETACHED);
  else child = spawn('xdg-open', [url], DETACHED);
  child.on('error', () => {});
  child.unref();
}
export function revealPath(p) {
  let child;
  if (process.platform === 'win32') child = spawn('explorer.exe', [`/select,"${p}"`], { ...DETACHED, windowsVerbatimArguments: true });
  else if (process.platform === 'darwin') child = spawn('open', ['-R', p], DETACHED);
  else child = spawn('xdg-open', [path.dirname(p)], DETACHED);
  child.on('error', () => {});
  child.unref();
}

// ───────────────────────── local server management ─────────────────────────

const samePath = (a, b) => {
  const n = (p) => path.resolve(String(p || '')).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
};

async function ping(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(1200) });
    const j = await r.json();
    return j && j.app === APP_ID ? j : { foreign: true };
  } catch (e) {
    return e?.name === 'TimeoutError' ? { foreign: true } : null; // null = 端口空闲
  }
}

export function readServerInfo(lib) {
  return readJson(path.join(lib, DIRS.system, 'server.json'));
}

/** 确保该素材库的管理服务在运行（常驻、全局唯一），返回 { url, port, started } */
export async function ensureServer(lib, { port } = {}) {
  ensureLibrary(lib);
  const info = readServerInfo(lib);
  if (info?.port) {
    const p = await ping(info.port);
    if (p?.app === APP_ID && samePath(p.lib, lib)) return { url: `http://127.0.0.1:${info.port}`, port: info.port, started: false };
  }
  const base = Number(port || readConfig().port || DEFAULT_PORT);
  for (let p = base; p < base + 20; p++) {
    const r = await ping(p);
    if (r?.app === APP_ID && samePath(r.lib, lib)) return { url: `http://127.0.0.1:${p}`, port: p, started: false };
    if (r) continue; // 被其它素材库或其它程序占用
    const log = fs.openSync(path.join(lib, DIRS.system, 'server.log'), 'a');
    const child = spawn(process.execPath, [path.join(HERE, 'server.mjs'), '--lib', lib, '--port', String(p)], {
      detached: true, stdio: ['ignore', log, log], windowsHide: true,
    });
    child.unref();
    fs.closeSync(log);
    for (let i = 0; i < 30; i++) {
      await new Promise((res) => setTimeout(res, 200));
      const ok = await ping(p);
      if (ok?.app === APP_ID && samePath(ok.lib, lib)) return { url: `http://127.0.0.1:${p}`, port: p, started: true };
      if (child.exitCode != null) break;
    }
  }
  throw new Error(`无法启动素材库管理服务，请查看 ${path.join(lib, DIRS.system, 'server.log')}`);
}

export async function stopServer(lib) {
  const info = readServerInfo(lib);
  if (!info?.port) return false;
  const p = await ping(info.port);
  if (!(p?.app === APP_ID && samePath(p.lib, lib))) return false;
  await fetch(`http://127.0.0.1:${info.port}/api/shutdown`, { method: 'POST', headers: { 'x-jimeng-library': '1' } }).catch(() => {});
  return true;
}

/**
 * 通知管理页有新素材。已有页面打开 → 页面实时刷新并高亮；没有页面 → 打开浏览器。
 */
export async function showInUi(lib, ids = [], { open = true, port } = {}) {
  const srv = await ensureServer(lib, { port });
  let clients = 0;
  try {
    const r = await fetch(`${srv.url}/api/notify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-jimeng-library': '1' },
      body: JSON.stringify({ ids }),
    });
    clients = (await r.json()).clients || 0;
  } catch { /* ignore */ }
  const url = ids.length ? `${srv.url}/?focus=${encodeURIComponent(ids.join(','))}` : `${srv.url}/`;
  const opened = Boolean(open) && clients === 0;
  if (opened) openUrl(url);
  return { url, opened, liveClients: clients };
}
