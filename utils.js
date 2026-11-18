// Shared helpers for the jimeng video plugin (no cli() registration here).
//
// Design: drive the real jimeng web UI (upload / @mention / settings / submit) so
// the submitted task is byte-for-byte what a human would produce in the browser,
// and only *read* results through the unsigned get_asset_list API.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ArgumentError, CommandExecutionError, TimeoutError, AuthRequiredError } from '@jackwener/opencli/errors';

export const DOMAIN = 'jimeng.jianying.com';
export const VIDEO_URL = 'https://jimeng.jianying.com/ai-tool/generate?type=video';
const API_QUERY = 'aid=513695&device_platform=web&region=cn&web_version=7.5.0&da_version=3.3.40&aigc_features=app_lip_sync';

export const STATUS_TEXT = { 50: 'succeeded', 30: 'failed' };

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.heic', '.heif', '.tif', '.tiff']);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.webm', '.m4v', '.avi', '.mkv', '.flv', '.3gp']);
const AUDIO_EXT = new Set(['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.wma']);
const KIND_CN = { image: '图片', video: '视频', audio: '音频' };

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function unwrap(payload) {
  if (payload && !Array.isArray(payload) && typeof payload === 'object' && 'session' in payload && 'data' in payload) {
    return payload.data;
  }
  return payload;
}

async function ev(page, fn, ...args) {
  return unwrap(await page.evaluate(fn, ...args));
}

export function expandHome(p) {
  if (!p) return p;
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(1));
  return p;
}

// ───────────────────────── argument parsing ─────────────────────────

/** --files "a.png,b.mp4" (also accepts ; or newline separators, or a JSON array). */
export function parseFiles(raw) {
  if (raw == null || String(raw).trim() === '') return [];
  const text = String(raw).trim();
  let list;
  if (text.startsWith('[')) {
    try { list = JSON.parse(text); } catch { throw new ArgumentError('--files JSON array is invalid'); }
  } else {
    list = text.split(/[,;\n]/);
  }
  list = list.map((s) => String(s).trim()).filter(Boolean);
  if (list.length > 12) throw new ArgumentError(`即梦最多支持 12 个参考素材，当前 ${list.length} 个`);
  const files = list.map((p, idx) => {
    const abs = path.resolve(expandHome(p));
    let st;
    try { st = fs.statSync(abs); } catch { throw new ArgumentError(`素材文件不存在: ${p}`); }
    if (!st.isFile() || st.size === 0) throw new ArgumentError(`素材不是有效文件: ${p}`);
    const ext = path.extname(abs).toLowerCase();
    const kind = IMAGE_EXT.has(ext) ? 'image' : VIDEO_EXT.has(ext) ? 'video' : AUDIO_EXT.has(ext) ? 'audio' : null;
    if (!kind) throw new ArgumentError(`不支持的素材类型 ${ext}: ${p}`, '图片: png/jpg/webp…  视频: mp4/mov/webm…  音频: mp3/wav/m4a…');
    return { index: idx + 1, path: abs, name: path.basename(abs), label: path.basename(abs, path.extname(abs)), kind, size: st.size };
  });
  const seen = new Map();
  for (const f of files) {
    if (seen.has(f.label)) {
      throw new ArgumentError(`素材文件名(不含扩展名)重复: "${f.label}"`, '即梦用文件名作为 @ 引用标签，请重命名以区分');
    }
    seen.set(f.label, f);
  }
  const counters = { image: 0, video: 0, audio: 0 };
  for (const f of files) f.kindIndex = ++counters[f.kind];
  return files;
}

/**
 * Prompt mini-syntax (mirrors what you'd pick in the web @ popup):
 *   @图片1 / @视频2 / @音频1   → Nth uploaded file of that kind (in --files order)
 *   @素材3                      → 3rd uploaded file overall
 *   @[名称]                     → a reference whose label is 名称 (uploaded file name w/o
 *                                 extension, or an existing 主体/subject in your asset library)
 *   @@                          → a literal "@"
 *   newline                     → new paragraph
 */
export function parsePrompt(prompt, files) {
  const segs = [];
  const re = /@@|@\[([^\]\n]+)\]|@(图片|视频|音频|素材)(\d+)/g;
  let last = 0;
  let m;
  const pushText = (t) => { if (t) segs.push({ type: 'text', text: t }); };
  while ((m = re.exec(prompt))) {
    pushText(prompt.slice(last, m.index));
    last = re.lastIndex;
    if (m[0] === '@@') { pushText('@'); continue; }
    if (m[1] != null) {
      const label = m[1].trim();
      const file = files.find((f) => f.label === label);
      segs.push({ type: 'mention', label, source: file ? 'upload' : 'any', token: m[0] });
      continue;
    }
    const kindCn = m[2];
    const n = Number(m[3]);
    let file;
    if (kindCn === '素材') file = files[n - 1];
    else {
      const kind = Object.keys(KIND_CN).find((k) => KIND_CN[k] === kindCn);
      file = files.find((f) => f.kind === kind && f.kindIndex === n);
    }
    if (!file) {
      throw new ArgumentError(`提示词中的 ${m[0]} 没有对应的上传素材`, `已上传: ${files.map((f) => `${KIND_CN[f.kind]}${f.kindIndex}=${f.name}`).join(', ') || '(无)'}`);
    }
    segs.push({ type: 'mention', label: file.label, source: 'upload', token: m[0] });
  }
  pushText(prompt.slice(last));
  // merge adjacent text segments (from @@)
  const merged = [];
  for (const s of segs) {
    const prev = merged[merged.length - 1];
    if (s.type === 'text' && prev && prev.type === 'text') prev.text += s.text;
    else merged.push({ ...s });
  }
  return merged;
}

// ───────────────────────── page bootstrap ─────────────────────────

export async function openGenerator(page, workspace) {
  const ws = String(workspace ?? '').trim();
  const byId = /^\d+$/.test(ws) && ws !== '0';
  const url = byId ? `${VIDEO_URL}&workspace=${ws}` : VIDEO_URL;
  await page.goto(url);
  await waitGenerator(page);
  // The avatar renders a moment after the generator panel; wait for it before concluding "logged out".
  let state = { login: false };
  for (let i = 0; i < 20 && !state.login; i++) {
    if (i) await sleep(500);
    state = await ev(page, () => ({ login: !!document.querySelector('#js-side-menu-entry-avatar-container'), url: location.href })).catch(() => ({ login: false }));
  }
  if (!state.login) {
    throw new AuthRequiredError(DOMAIN, '即梦未登录', '请先在 Chrome 中登录 https://jimeng.jianying.com');
  }
  if (ws && !byId && ws !== 'new' && ws !== '0') {
    const clicked = await ev(page, (title) => {
      const items = [...document.querySelectorAll('aside [role=button]')];
      const hit = items.find((e) => e.innerText.trim() === title);
      if (!hit) return { ok: false, titles: items.map((e) => e.innerText.trim()).filter(Boolean).slice(0, 30) };
      hit.click();
      return { ok: true };
    }, ws);
    if (!clicked.ok) throw new ArgumentError(`找不到会话 "${ws}"`, `可用会话: ${clicked.titles.join(' | ')}`);
    await sleep(2500);
    await waitGenerator(page);
  }
}

/**
 * The @-mention popup and TipTap focus are scheduled with requestAnimationFrame,
 * which Chrome pauses for hidden tabs. Make sure our tab is the visible one.
 */
export async function bringToFront(page) {
  if (typeof page.cdp === 'function') {
    await page.cdp('Page.bringToFront', {}).catch(() => undefined);
  }
  await sleep(300);
  let vis = await ev(page, () => document.visibilityState).catch(() => 'unknown');
  if (vis !== 'hidden') return vis;
  // Window is occluded/minimised: ask the extension to focus the window owning our tab.
  try {
    const pageUrl = await import.meta.resolve('@jackwener/opencli/browser/page');
    const { sendCommand } = await import(new URL('./daemon-client.js', pageUrl).href);
    const marker = `oc-jm-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const oldTitle = await ev(page, (m) => { const t = document.title; document.title = m; return t; }, marker);
    await sleep(300);
    const call = (chromeMethod, chromeArgs) => sendCommand('chrome-call', { surface: 'browser', chromeMethod, chromeArgs });
    try {
      const tabs = unwrap(await call('tabs.query', [{ title: marker }]));
      const list = Array.isArray(tabs) ? tabs : tabs?.result || [];
      const tab = list[0];
      if (tab) {
        await call('windows.update', [tab.windowId, { focused: true, state: 'normal' }]);
        await call('tabs.update', [tab.id, { active: true }]);
      }
    } finally {
      await ev(page, (t) => { document.title = t; return true; }, oldTitle);
    }
    await sleep(600);
    vis = await ev(page, () => document.visibilityState).catch(() => 'unknown');
  } catch { /* best effort */ }
  return vis;
}

async function waitGenerator(page, timeoutMs = 30000) {
  await bringToFront(page);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await ev(page, () => {
      const g = document.querySelector('[data-testid="dreamina.generator"]');
      return !!(g && g.querySelector('[role=combobox]'));
    }).catch(() => false);
    if (ok) return;
    await sleep(800);
  }
  throw new CommandExecutionError('即梦生成器面板未加载', '页面结构可能已变更，或网络较慢');
}

/** Record every /mweb/ JSON response the page itself receives (submit + its own polling). */
export async function installNetHook(page) {
  return ev(page, () => {
    if (window.__ocJmHook) { window.__ocJmNet = []; return 'reset'; }
    window.__ocJmNet = [];
    const rec = (url, body, text) => {
      try {
        if (!/\/mweb\//.test(String(url))) return;
        window.__ocJmNet.push({ t: Date.now(), url: String(url), req: typeof body === 'string' ? body.slice(0, 20000) : null, res: String(text).slice(0, 3000000) });
        if (window.__ocJmNet.length > 200) window.__ocJmNet.shift();
      } catch (e) { /* ignore */ }
    };
    const of = window.fetch;
    window.fetch = async function (input, init) {
      const resp = await of.apply(this, arguments);
      try {
        const url = typeof input === 'string' ? input : input && input.url;
        resp.clone().text().then((t) => rec(url, init && init.body, t)).catch(() => {});
      } catch (e) { /* ignore */ }
      return resp;
    };
    const oo = XMLHttpRequest.prototype.open;
    const os = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (m, u) { this.__ocUrl = u; return oo.apply(this, arguments); };
    XMLHttpRequest.prototype.send = function (b) {
      this.addEventListener('load', () => { try { rec(this.__ocUrl, b, typeof this.responseText === 'string' ? this.responseText : ''); } catch (e) { /* ignore */ } });
      return os.apply(this, arguments);
    };
    window.__ocJmHook = true;
    return 'hooked';
  });
}

/** Remove leftover references and prompt text from a previous draft. */
export async function resetDraft(page) {
  return ev(page, async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    let removed = 0;
    for (let i = 0; i < 20; i++) {
      const b = document.querySelector('[data-testid="dreamina.generator"] [data-content-generator-references] [data-native-reference-action=remove]');
      if (!b) break;
      b.click(); removed++;
      await wait(400);
    }
    const ed = document.querySelector('[data-testid="dreamina.generator"] .tiptap');
    if (ed && ed.editor) ed.editor.commands.clearContent(true);
    return removed;
  });
}

// ───────────────────────── dropdown selections ─────────────────────────

/** Select an option from one of the generator's arco <Select> comboboxes. */
async function selectCombo(page, which, wanted) {
  const res = await ev(page, async (which, wanted) => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const g = document.querySelector('[data-testid="dreamina.generator"]');
    const combos = [...g.querySelectorAll('[role=combobox]')];
    const combo = which === 'mode' ? combos.find((c) => !c.getAttribute('aria-label')) : combos.find((c) => c.getAttribute('aria-label') === which);
    if (!combo) return { ok: false, reason: `combobox ${which} not found` };
    const current = combo.innerText.trim();
    if (current === wanted) return { ok: true, value: current, changed: false };
    combo.click();
    await wait(700);
    const lb = [...document.querySelectorAll('[role=listbox]')].filter(vis).pop();
    if (!lb) return { ok: false, reason: 'listbox did not open' };
    const opts = [...lb.querySelectorAll('[role=option]')];
    const hit = opts.find((o) => o.innerText.trim() === wanted) || opts.find((o) => o.innerText.trim().includes(wanted));
    if (!hit) { combo.click(); return { ok: false, reason: 'option not found', options: opts.map((o) => o.innerText.trim()) }; }
    hit.click();
    await wait(1200);
    return { ok: true, value: combo.innerText.trim(), changed: true };
  }, which, wanted);
  if (!res.ok) {
    throw new ArgumentError(`无法选择 ${which === 'mode' ? '参考模式' : which} "${wanted}": ${res.reason}`, res.options ? `可选: ${res.options.join(' / ')}` : undefined);
  }
  return res;
}

export async function ensureImageType(page) {
  return selectCombo(page, '创作类型', '图片生成');
}

export async function ensureVideoType(page) {
  return selectCombo(page, '创作类型', '视频生成');
}

export async function selectMode(page, mode) {
  if (!mode) return null;
  return selectCombo(page, 'mode', mode);
}

export async function selectModel(page, model) {
  if (!model) return null;
  const res = await ev(page, async (wanted) => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const g = document.querySelector('[data-testid="dreamina.generator"]');
    const combo = g.querySelector('[role=combobox][aria-label="模型"]');
    if (!combo) return { ok: false, reason: 'model combobox not found' };
    const curName = () => norm(combo.innerText);
    if (curName() === norm(wanted)) return { ok: true, value: combo.innerText.trim(), changed: false };
    combo.click();
    await wait(900);
    const rowName = (b) => {
      const n = b.querySelector('[class*="name-"]');
      return (n ? n.textContent : b.innerText.split('\n')[0]).trim();
    };
    const findRow = () => {
      const pops = [...document.querySelectorAll('.lv-select-popup, .lv-trigger')].filter(vis);
      const rows = pops.flatMap((p) => [...p.querySelectorAll('button')]).filter(vis).filter((b) => !/个模型/.test(b.innerText));
      const w = norm(wanted);
      const named = rows.map((b) => ({ b, name: rowName(b) })).filter((x) => x.name);
      return named.find((x) => norm(x.name) === w)
        || named.filter((x) => norm(x.name).includes(w)).sort((a, b) => a.name.length - b.name.length)[0]
        || null;
    };
    let hit = findRow();
    const seenNames = new Set();
    if (!hit) {
      // Expand "全部模型" families one by one
      const fams = [...document.querySelectorAll('.lv-select-popup button')].filter(vis).filter((b) => /个模型/.test(b.innerText));
      for (const f of fams) {
        f.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        f.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        f.click();
        await wait(800);
        hit = findRow();
        if (hit) break;
      }
    }
    if (!hit) {
      [...document.querySelectorAll('.lv-select-popup, .lv-trigger')].filter(vis).forEach((p) => p.querySelectorAll('button').forEach((b) => { const n = rowName(b); if (n && !/个模型/.test(b.innerText)) seenNames.add(n); }));
      combo.click();
      return { ok: false, reason: 'model not found', options: [...seenNames] };
    }
    hit.b.click();
    await wait(1200);
    return { ok: true, value: combo.innerText.trim(), changed: true };
  }, model);
  if (!res.ok) throw new ArgumentError(`无法选择模型 "${model}": ${res.reason}`, res.options ? `可选: ${res.options.join(' / ')}` : undefined);
  return res;
}

/**
 * Settings popovers next to the model selector:
 *   ratio + resolution (one popover), count, duration.
 */
export async function applySettings(page, { ratio, resolution, count, duration }) {
  const res = await ev(page, async (cfg) => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const g = document.querySelector('[data-testid="dreamina.generator"]');
    const buttons = () => [...g.querySelectorAll('button')].filter(vis).filter((b) => !b.closest('[contenteditable]'));
    const label = (b) => (b.getAttribute('aria-label') || b.innerText).replace(/\s+/g, ' ').trim();
    const popover = () => [...document.querySelectorAll('.lv-popover')].filter(vis).pop();
    const out = { errors: [] };
    const pickRadio = async (btnFinder, groupSel, value, key) => {
      const btn = buttons().find(btnFinder);
      if (!btn) { out.errors.push(`${key}: 当前模型/模式下没有该设置项`); return; }
      btn.click();
      await wait(700);
      const p = popover();
      const group = p && p.querySelector(groupSel);
      if (!group) { out.errors.push(`${key}: 面板未打开`); btn.click(); await wait(300); return; }
      const labels = [...group.querySelectorAll('label')];
      const v = String(value).toLowerCase();
      const hit = labels.find((l) => (l.querySelector('input')?.value || '').toLowerCase() === v)
        || labels.find((l) => l.innerText.trim().toLowerCase() === v);
      if (!hit) {
        out.errors.push(`${key}: 不支持 "${value}"，可选 ${labels.map((l) => l.innerText.trim() || l.querySelector('input')?.value).join(' / ')}`);
      } else if ((hit.className || '').includes('disabled')) {
        out.errors.push(`${key}: "${value}" 当前不可用`);
      } else {
        hit.click();
        await wait(500);
        out[key] = hit.innerText.trim() || hit.querySelector('input')?.value;
      }
      if (popover()) { btn.click(); await wait(400); }
    };
    // video: "16:9 720P"; image: "1:1 2K" / "智能 1.5K"
    const isRatioBtn = (b) => /\d{3,4}P|\d(\.\d)?K\b/i.test(label(b)) && !/生成数量/.test(label(b));
    // image mode's ratio group has no aspect-ratio class: fall back to the first group of N:M values
    if (cfg.ratio) await pickRadio(isRatioBtn, '.lv-radio-group[class*="aspect-ratio"], .lv-radio-group:not([class*="resolution"])', cfg.ratio, 'ratio');
    if (cfg.resolution) await pickRadio(isRatioBtn, '.lv-radio-group[class*="resolution"]', cfg.resolution, 'resolution');
    if (cfg.count) await pickRadio((b) => /生成数量/.test(label(b)), '.lv-radio-group[class*="batch-number"], .lv-radio-group[class*="generate-count"]', cfg.count, 'count');
    if (cfg.duration) {
      const btn = buttons().find((b) => /^\d+s$/.test(label(b)));
      if (!btn) out.errors.push('duration: 当前模型/模式下没有时长设置');
      else {
        btn.click();
        await wait(700);
        const p = popover();
        const input = p && p.querySelector('input[role=spinbutton]');
        if (!input) out.errors.push('duration: 时长面板未打开');
        else {
          const min = Number(input.getAttribute('aria-valuemin'));
          const max = Number(input.getAttribute('aria-valuemax'));
          const d = Number(cfg.duration);
          if ((Number.isFinite(min) && d < min) || (Number.isFinite(max) && d > max)) {
            out.errors.push(`duration: ${d}s 超出范围 ${min}-${max}s`);
          } else {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
            input.focus();
            setter.call(input, String(d));
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
            input.blur();
            input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
            await wait(500);
          }
        }
        if (popover()) { btn.click(); await wait(400); }
        const now = buttons().find((b) => /^\d+s$/.test(label(b)));
        out.duration = now ? label(now) : null;
        if (now && label(now) !== `${cfg.duration}s` && !out.errors.some((e) => e.startsWith('duration'))) {
          out.errors.push(`duration: 设置后显示为 ${label(now)}`);
        }
      }
    }
    return out;
  }, { ratio, resolution, count: count ? String(count) : '', duration: duration ? String(duration) : '' });
  if (res.errors.length) throw new ArgumentError(`参数设置失败: ${res.errors.join('; ')}`);
  return res;
}

/** Read what the generator currently shows (model / mode / ratio / count / duration / credits). */
export async function readSummary(page) {
  return ev(page, () => {
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const g = document.querySelector('[data-testid="dreamina.generator"]');
    const combos = [...g.querySelectorAll('[role=combobox]')];
    const btnText = [...g.querySelectorAll('button')].filter(vis).map((b) => (b.getAttribute('aria-label') || b.innerText).replace(/\s+/g, ' ').trim());
    const credit = [...g.querySelectorAll('span[tabindex="0"]')].map((s) => s.innerText.replace(/\s+/g, ' ').trim()).find((t) => /^\d+(\/张)?( \d+(\/张)?)?$/.test(t)); // video: "24 36"; image: "6/张 9/张"
    const submit = g.querySelector('[data-testid="dreamina.generator.submit"]');
    return {
      type: combos.find((c) => c.getAttribute('aria-label') === '创作类型')?.innerText.trim() || '',
      model: combos.find((c) => c.getAttribute('aria-label') === '模型')?.innerText.trim() || '',
      mode: combos.find((c) => !c.getAttribute('aria-label'))?.innerText.trim() || '',
      ratio_resolution: btnText.find((t) => /\d{3,4}P|\d(\.\d)?K\b/i.test(t) && !/生成数量/.test(t)) || '',
      count: (btnText.find((t) => /生成数量/.test(t)) || '').replace(/[^\d]/g, ''),
      duration: btnText.find((t) => /^\d+s$/.test(t)) || '',
      credits: credit ? parseInt(credit, 10) : null, // image mode: per image × count
      credits_per: credit && credit.includes('/张') ? 'image' : 'task',
      submit_enabled: !!submit && !submit.disabled && !String(submit.className).includes('disabled') && submit.getAttribute('aria-disabled') !== 'true',
      url: location.href,
    };
  });
}

// ───────────────────────── uploads ─────────────────────────

async function setFiles(page, paths, selector) {
  try {
    await page.setFileInput(paths, selector);
    return;
  } catch (err) {
    if (typeof page.cdp !== 'function') throw err;
  }
  await page.cdp('DOM.enable', {}).catch(() => undefined);
  const doc = await page.cdp('DOM.getDocument', {});
  const q = await page.cdp('DOM.querySelector', { nodeId: doc.root.nodeId, selector });
  if (!q?.nodeId) throw new CommandExecutionError(`file input ${selector} not found`);
  await page.cdp('DOM.setFileInputFiles', { files: paths, nodeId: q.nodeId });
}

/**
 * Upload files the same way a user drag-drops them onto 参考内容:
 * Chrome reads the local files into a hidden <input type=file> (CDP), then we
 * dispatch a real DragEvent(drop) carrying those File objects onto the slot.
 */
export async function uploadFiles(page, files, mode) {
  if (!files.length) return [];
  const groups = [];
  if (mode === '首尾帧') {
    if (files.length > 2) throw new ArgumentError('首尾帧模式最多 2 个图片素材（首帧、尾帧）');
    if (files.some((f) => f.kind !== 'image')) throw new ArgumentError('首尾帧模式只支持图片素材');
    files.forEach((f, i) => groups.push({ files: [f], slot: i === 0 ? '首帧' : '尾帧' }));
  } else {
    groups.push({ files, slot: null });
  }
  const inputId = `oc-jm-file-${Date.now().toString(36)}`;
  for (const grp of groups) {
    await ev(page, (id) => {
      document.querySelectorAll('input[data-oc-jm-file]').forEach((x) => x.remove());
      const i = document.createElement('input');
      i.type = 'file'; i.multiple = true; i.id = id; i.setAttribute('data-oc-jm-file', '1');
      i.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none;';
      document.body.appendChild(i);
      return true;
    }, inputId);
    await setFiles(page, grp.files.map((f) => f.path), `#${inputId}`);
    const dropped = await ev(page, (id, slot) => {
      const input = document.getElementById(id);
      if (!input || !input.files || !input.files.length) return { ok: false, reason: 'no files loaded into input' };
      const dt = new DataTransfer();
      for (const f of input.files) dt.items.add(f);
      const g = document.querySelector('[data-testid="dreamina.generator"]');
      const slots = [...g.querySelectorAll('[id*="reference-upload"]')];
      const target = slot ? slots.find((s) => (s.getAttribute('aria-label') || s.innerText).includes(slot)) : slots[slots.length - 1];
      if (!target) return { ok: false, reason: `upload slot ${slot || '参考内容'} not found`, slots: slots.map((s) => s.getAttribute('aria-label')) };
      for (const ty of ['dragenter', 'dragover', 'drop']) {
        target.dispatchEvent(new DragEvent(ty, { bubbles: true, cancelable: true, dataTransfer: dt }));
      }
      input.remove();
      return { ok: true, n: dt.files.length };
    }, inputId, grp.slot);
    if (!dropped.ok) throw new CommandExecutionError(`素材上传失败: ${dropped.reason}`);
    await sleep(800);
  }
  // wait for upload + audit to finish
  const totalBytes = files.reduce((s, f) => s + f.size, 0);
  const uploadBudgetMs = Math.max(90000, Math.ceil(totalBytes / (256 * 1024)) * 1000);
  const deadline = Date.now() + uploadBudgetMs;
  let last;
  while (Date.now() < deadline) {
    last = await ev(page, () => {
      const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const g = document.querySelector('[data-testid="dreamina.generator"]');
      const refs = g.querySelector('[data-content-generator-references]') || g;
      const toasts = [...document.querySelectorAll('.lv-message')].filter(vis).map((e) => e.innerText.trim()).filter(Boolean);
      return {
        loading: !!refs.querySelector('[data-dreamina-loading=true]'),
        count: refs.querySelectorAll('[data-native-reference-action=remove]').length,
        toasts,
      };
    });
    const bad = last.toasts.find((t) => /失败|不支持|超过|过大|违规|无法|错误|limit|fail/i.test(t));
    if (bad) throw new CommandExecutionError(`素材上传被拒绝: ${bad}`);
    if (!last.loading && last.count >= files.length) return last;
    await sleep(1000);
  }
  const diag = await ev(page, () => {
    const g = document.querySelector('[data-testid="dreamina.generator"]');
    const refs = g.querySelector('[data-content-generator-references]');
    return {
      url: location.href,
      visible: document.visibilityState,
      focus: document.hasFocus(),
      mode: [...g.querySelectorAll('[role=combobox]')].map((c) => c.innerText.trim()).join(' | '),
      slots: [...g.querySelectorAll('[id*="reference-upload"]')].map((s) => `${s.getAttribute('aria-label')}:${s.getAttribute('aria-disabled')}`),
      refs: refs ? refs.outerHTML.replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/ (style|class)="[^"]*"/g, '').slice(0, 600) : null,
    };
  }).catch(() => null);
  const hiddenHint = diag && diag.visible === 'hidden'
    ? 'opencli 的即梦窗口当前不可见（被其它窗口遮挡或最小化），Chrome 会暂停后台页面的素材处理；请让该窗口保持可见后重试。'
    : '';
  throw new TimeoutError('素材上传', Math.round(uploadBudgetMs / 1000), `${hiddenHint}上传状态: ${JSON.stringify(last)} 诊断: ${JSON.stringify(diag)}`);
}

// ───────────────────────── prompt (TipTap editor) ─────────────────────────

async function editorKind(page) {
  return ev(page, () => {
    const g = document.querySelector('[data-testid="dreamina.generator"]');
    if (g.querySelector('.tiptap') && g.querySelector('.tiptap').editor) return 'tiptap';
    if (g.querySelector('textarea')) return 'textarea';
    return 'none';
  });
}

async function typeText(page, text) {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) {
      await ev(page, () => {
        const ed = document.querySelector('[data-testid="dreamina.generator"] .tiptap').editor; ed.view.dom.focus();
        ed.view.dom.focus();
        ed.commands.setTextSelection(ed.state.doc.content.size - 1);
        ed.commands.splitBlock();
        return true;
      });
    }
    const line = lines[i];
    if (!line) continue;
    // Always append at the document end via an editor transaction. Typing through the DOM caret
    // (CDP insertText) can land before mention chips that were inserted by command, scrambling
    // the order. A JSON text node (not a string) also keeps "<名称>" from being parsed as HTML
    // and a literal "@" from opening the mention popup.
    await ev(page, (t) => {
      const ed = document.querySelector('[data-testid="dreamina.generator"] .tiptap').editor;
      ed.view.dom.focus();
      ed.chain().setTextSelection(ed.state.doc.content.size - 1).insertContent({ type: 'text', text: t }).run();
      return true;
    }, line);
  }
  await closeMentionPopup(page);
}

async function closeMentionPopup(page) {
  await ev(page, () => {
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    if ([...document.querySelectorAll('[role=listbox]')].some(vis)) {
      const ed = document.querySelector('[data-testid="dreamina.generator"] .tiptap');
      ed.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
    }
    return true;
  });
}

const countMentions = (page) => ev(page, () => {
  const ed = document.querySelector('[data-testid="dreamina.generator"] .tiptap').editor; ed.view.dom.focus();
  let n = 0;
  ed.state.doc.descendants((node) => { if (/MentionTag$/.test(node.type.name)) n++; });
  return n;
});

/** Read the @ popup options (group 0 = uploaded references, later groups = 主体/subjects). */
const readMentionOptions = (page) => ev(page, () => {
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const lb = [...document.querySelectorAll('[role=listbox]')].filter(vis).pop();
  if (!lb) return null;
  let group = 0;
  const out = [];
  for (const li of lb.querySelectorAll('li')) {
    if (li.classList.contains('lv-select-group-title')) {
      if (li.querySelector('[role=separator]')) group++;
      continue;
    }
    if (li.getAttribute('role') !== 'option') continue;
    const l = li.querySelector('[class*="option-label"]');
    const label = (l ? l.textContent : li.innerText.split('\n').pop()).trim();
    out.push({ label, group, blob: !!li.querySelector('img[src^="blob:"]') });
  }
  return out;
});

/**
 * Uploaded references live in the generator's React state as resources
 * ({ $type: 'ReferenceImageResource', id: <uuid>, name: <file stem>, ... }).
 * Picking one from the @ popup inserts referenceMentionTag{id: resource.id};
 * we insert the very same node directly, which also works when the tab is
 * hidden (the popup only renders in a visible tab).
 */
const RESOURCES_FN = `(() => {
  const g = document.querySelector('[data-testid="dreamina.generator"]');
  const el = g && g.querySelector('[data-content-generator-references] [data-index]');
  if (!el) return [];
  const fk = Object.keys(el).find((k) => k.startsWith('__reactFiber'));
  let f = el[fk];
  for (let d = 0; f && d < 60; d++, f = f.return) {
    const p = f.memoizedProps;
    if (p && Array.isArray(p.items) && p.items.length && p.items[0] && p.items[0].id && ('uri' in p.items[0] || 'file' in p.items[0])) {
      return p.items.map((x) => ({ id: x.id, name: x.name || x._name || '', type: x.type || x.$type || '', uri: x.uri || '' }));
    }
  }
  return [];
})()`;

export async function listUploadedResources(page) {
  return unwrap(await page.evaluate(RESOURCES_FN)) || [];
}

async function insertUploadMention(page, seg) {
  const res = await ev(page, (label, resourcesFn) => {
    // eslint-disable-next-line no-eval
    const items = (0, eval)(resourcesFn);
    const hit = items.find((x) => x.name === label);
    if (!hit) return { ok: false, names: items.map((x) => x.name) };
    const ed = document.querySelector('[data-testid="dreamina.generator"] .tiptap').editor;
    ed.view.dom.focus();
    const end = ed.state.doc.content.size - 1;
    ed.chain().setTextSelection(end).insertContent({ type: 'referenceMentionTag', attrs: { id: hit.id, isContinuationPromptBlockPart: false } }).run();
    return { ok: true, id: hit.id };
  }, seg.label, RESOURCES_FN);
  return res;
}

async function insertMention(page, seg, hasUploads) {
  const before = await countMentions(page);
  if (seg.source === 'upload') {
    const r = await insertUploadMention(page, seg);
    if (!r.ok) throw new ArgumentError(`已上传素材中找不到 "${seg.label}"（来自 ${seg.token}）`, `已上传: ${r.names.join(' / ') || '(无)'}`);
    const after = await countMentions(page);
    if (after !== before + 1) throw new CommandExecutionError(`@${seg.label} 引用未插入到输入框`);
    return;
  }
  // 主体 / asset-library subjects: go through the real @ popup (needs a visible tab)
  await ev(page, () => { const ed = document.querySelector('[data-testid="dreamina.generator"] .tiptap').editor; ed.view.dom.focus(); ed.commands.setTextSelection(ed.state.doc.content.size - 1); return true; });
  await page.insertText('@').catch(async () => {
    await ev(page, () => { document.querySelector('[data-testid="dreamina.generator"] .tiptap').editor.commands.insertContent('@'); return true; });
  });
  let opts = null;
  for (let i = 0; i < 15 && !opts; i++) { await sleep(200); opts = await readMentionOptions(page); }
  if (!opts) {
    const diag = await ev(page, () => {
      const el = document.querySelector('[data-testid="dreamina.generator"] .tiptap');
      return { text: el.editor.getText(), json: JSON.stringify(el.editor.getJSON()).slice(0, 400), active: document.activeElement === el, hasFocus: document.hasFocus(), vis: document.visibilityState, suggestion: !!el.querySelector('.suggestion') };
    }).catch(() => null);
    throw new CommandExecutionError(`输入 @ 后没有出现素材选择列表 ${JSON.stringify(diag)}`);
  }

  const choose = async (filtered) => ev(page, (label, preferGroup0, filtered) => {
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const lb = [...document.querySelectorAll('[role=listbox]')].filter(vis).pop();
    if (!lb) return { ok: false };
    let group = 0;
    const cands = [];
    for (const li of lb.querySelectorAll('li')) {
      if (li.classList.contains('lv-select-group-title')) { if (li.querySelector('[role=separator]')) group++; continue; }
      if (li.getAttribute('role') !== 'option') continue;
      const l = li.querySelector('[class*="option-label"]');
      const text = (l ? l.textContent : li.innerText.split('\n').pop()).trim();
      if (text === label) cands.push({ li, group });
    }
    if (!cands.length) return { ok: false };
    const pick = (preferGroup0 && cands.find((c) => c.group === 0)) || cands[0];
    pick.li.scrollIntoView({ block: 'nearest' });
    pick.li.click();
    return { ok: true, group: pick.group, filtered };
  }, seg.label, seg.source === 'upload' && hasUploads, filtered);

  let r = await choose(false);
  if (!r.ok && seg.source !== 'upload') {
    // long subject lists: type the name after @ to filter, like a user would
    await page.insertText(seg.label).catch(() => undefined);
    await sleep(900);
    r = await choose(true);
  }
  if (!r.ok) {
    const labels = (await readMentionOptions(page) || opts).map((o) => o.label);
    await closeMentionPopup(page);
    throw new ArgumentError(`@ 列表中找不到素材 "${seg.label}"（来自 ${seg.token}）`, `可引用: ${[...new Set(labels)].join(' / ')}`);
  }
  await sleep(400);
  const after = await countMentions(page);
  if (after !== before + 1) throw new CommandExecutionError(`@${seg.label} 引用未插入到输入框`);
}

/** Fill the prompt exactly like the web UI: text + @ mention chips chosen from the popup. */
export async function fillPrompt(page, segments, hasUploads) {
  const kind = await editorKind(page);
  if (kind === 'textarea') {
    if (segments.some((s) => s.type === 'mention')) throw new ArgumentError('当前参考模式的输入框不支持 @ 引用素材（请使用 全能参考 模式）');
    const text = segments.map((s) => s.text).join('');
    await ev(page, (t) => {
      const ta = document.querySelector('[data-testid="dreamina.generator"] textarea');
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      ta.focus();
      setter.call(ta, t);
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }, text);
    return readPrompt(page);
  }
  if (kind !== 'tiptap') throw new CommandExecutionError('找不到提示词输入框');
  await ev(page, () => { const ed = document.querySelector('[data-testid="dreamina.generator"] .tiptap').editor; ed.commands.clearContent(true); ed.view.dom.focus(); return true; });
  for (const seg of segments) {
    if (seg.type === 'text') await typeText(page, seg.text);
    else await insertMention(page, seg, hasUploads);
  }
  await closeMentionPopup(page);
  return readPrompt(page);
}

/** Human readable prompt as shown in the web UI (mention chips rendered as @label). */
export async function readPrompt(page) {
  return ev(page, (resourcesFn) => {
    const g = document.querySelector('[data-testid="dreamina.generator"]');
    const el = g.querySelector('.tiptap');
    if (el && el.editor) {
      const ed = el.editor;
      // eslint-disable-next-line no-eval
      const byId = new Map((0, eval)(resourcesFn).map((x) => [x.id, x.name]));
      const subjectChips = [...el.querySelectorAll('.node-subjectMentionTag')].map((c) => c.innerText.trim());
      let si = 0;
      let i = 0;
      const paras = [];
      ed.state.doc.forEach((p) => {
        let s = '';
        p.descendants((n) => {
          if (n.isText) s += n.text;
          else if (/MentionTag$/.test(n.type.name)) {
            i++;
            const chip = n.type.name === 'subjectMentionTag' ? subjectChips[si++] : '';
            s += `@[${byId.get(n.attrs.id) || chip || n.attrs.id}]`;
          }
        });
        paras.push(s);
      });
      return { text: paras.join('\n'), mentions: i, doc: ed.getJSON() };
    }
    const ta = g.querySelector('textarea');
    return { text: ta ? ta.value : '', mentions: 0, doc: null };
  }, RESOURCES_FN);
}

// ───────────────────────── submit & results ─────────────────────────

export async function submit(page) {
  const clickedAt = await ev(page, () => {
    const b = document.querySelector('[data-testid="dreamina.generator.submit"]');
    if (!b) return { ok: false, reason: '找不到生成按钮' };
    if (b.disabled || String(b.className).includes('disabled') || b.getAttribute('aria-disabled') === 'true') return { ok: false, reason: '生成按钮不可用（检查提示词/素材/积分）' };
    window.__ocJmSubmitAt = Date.now();
    b.click();
    return { ok: true, t: window.__ocJmSubmitAt };
  });
  if (!clickedAt.ok) throw new CommandExecutionError(clickedAt.reason);
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    await sleep(1000);
    const st = await ev(page, (t0) => {
      const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const net = (window.__ocJmNet || []).filter((x) => x.t >= t0);
      const found = [];
      for (const x of net) {
        if (!/generate|submit/i.test(x.url) || /accelerate|audit|get_|query/i.test(x.url)) continue;
        let j; try { j = JSON.parse(x.res); } catch { continue; }
        const walk = (o, d = 0) => {
          if (!o || typeof o !== 'object' || d > 8) return;
          if (o.history_record_id) found.push({ history_record_id: String(o.history_record_id), submit_id: o.submit_id || null, status: o.status ?? null });
          Object.values(o).forEach((v) => walk(v, d + 1));
        };
        walk(j);
        if (!found.length && j && j.ret && String(j.ret) !== '0') {
          return { error: `${j.errmsg || 'generate failed'} (ret=${j.ret})`, url: x.url.replace(/\?.*/, '') };
        }
      }
      const toasts = [...document.querySelectorAll('.lv-message')].filter(vis).map((e) => e.innerText.trim()).filter(Boolean);
      const modal = [...document.querySelectorAll('.lv-modal, [role=dialog]')].filter(vis).map((e) => e.innerText.trim().slice(0, 300)).filter(Boolean);
      return { found: found[0] || null, toasts, modal, urls: net.map((x) => x.url.replace(/\?.*/, '')), url: location.href };
    }, clickedAt.t);
    if (st.error) throw new CommandExecutionError(`提交失败: ${st.error}`);
    if (st.found) return { ...st.found, page_url: st.url };
    const bad = (st.toasts || []).find((t) => /失败|不足|违规|错误|上限|频繁|无法|请先|fail/i.test(t));
    if (bad) throw new CommandExecutionError(`提交失败: ${bad}`);
    if (st.modal && st.modal.length) {
      throw new CommandExecutionError(`提交后出现确认弹窗，未自动处理: ${st.modal.join(' | ')}`, '请在浏览器中查看该弹窗');
    }
  }
  throw new TimeoutError('提交生成任务', 45, '未捕获到生成任务 ID，请在浏览器中确认是否已提交（避免重复提交消耗积分）');
}

function workspaceFromUrl(url) {
  const m = /[?&]workspace=(\d+)/.exec(url || '');
  return m ? m[1] : '0';
}

/** Find a generation record by history_record_id via get_asset_list (and anything the page fetched itself). */
/** kind: 'video' (asset type 2) | 'image' (asset type 1). Results are returned in `videos` either way. */
export async function lookupRecord(page, recordId, workspaceId, maxPages = 6, kind = 'video') {
  return ev(page, async (rid, ws, maxPages, q, kind) => {
    const pickVideo = (rec) => {
      const urls = [];
      for (const it of rec.item_list || []) {
        const imgs = it.image?.large_images || [];
        if (imgs.length) {
          const best = imgs.slice().sort((a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0))[0];
          if (best.image_url) urls.push({ url: best.image_url, width: best.width || null, height: best.height || null, size: best.size || null, format: best.format || it.image?.format || 'png', cover: it.common_attr?.cover_url || null, item_id: it.common_attr?.id || null });
          continue;
        }
        const v = it.video || {};
        const tv = v.transcoded_video || {};
        const best = tv.origin || tv['1080p'] || tv['720p'] || Object.values(tv)[0] || {};
        const u = best.video_url || v.video_url || (it.common_attr && it.common_attr.item_urls && it.common_attr.item_urls.find(Boolean));
        if (u) urls.push({ url: u, width: best.width || null, height: best.height || null, size: best.size || null, duration: v.duration || null, cover: it.common_attr?.cover_url || null, item_id: it.common_attr?.id || null });
      }
      return urls;
    };
    const fromObj = (o) => ({
      history_record_id: String(o.history_record_id),
      submit_id: o.submit_id || null,
      status: o.status,
      fail_msg: o.fail_starling_message || o.fail_msg || '',
      created_time: o.created_time || null,
      finish_time: o.finish_time || null,
      prompt: (o.item_list && o.item_list[0] && o.item_list[0].common_attr && o.item_list[0].common_attr.prompt) || '',
      model: o.model_info?.model_name || '',
      credits: o.item_list?.[0]?.extra?.credits_consume ?? null,
      videos: pickVideo(o),
    });
    const search = (j) => {
      let hit = null;
      const walk = (o, d = 0) => {
        if (hit || !o || typeof o !== 'object' || d > 9) return;
        if (String(o.history_record_id || '') === rid && Array.isArray(o.item_list)) { hit = o; return; }
        Object.values(o).forEach((v) => walk(v, d + 1));
      };
      walk(j);
      return hit;
    };
    // 1) responses the page itself received (its own polling)
    for (const x of [...(window.__ocJmNet || [])].reverse()) {
      let j; try { j = JSON.parse(x.res); } catch { continue; }
      const h = search(j);
      if (h && (h.status === 50 || h.status === 30)) return { ok: true, rec: fromObj(h), via: 'page' };
    }
    // 2) query the asset list ourselves
    let offset = 0;
    for (let p = 0; p < maxPages; p++) {
      // workspace_id omitted = newest first across all conversations (workspace_id:0 returns an unrelated list)
      const body = { count: 20, asset_type_list: [kind === 'image' ? 1 : 2], direction: 1, mode: 'workbench' };
      if (Number(ws)) body.workspace_id = Number(ws);
      if (offset) body.offset = offset;
      const r = await fetch(`/mweb/v1/get_asset_list?${q}`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json();
      if (String(j.ret) !== '0') return { ok: false, error: `get_asset_list ret=${j.ret} ${j.errmsg}` };
      for (const a of j.data?.asset_list || []) {
        const rec = a.video || a.image;
        if (rec && String(rec.history_record_id) === rid) return { ok: true, rec: fromObj(rec), via: 'api' };
      }
      if (!j.data?.has_more || !j.data?.next_offset) break;
      offset = j.data.next_offset;
    }
    return { ok: true, rec: null };
  }, String(recordId), String(workspaceId || '0'), maxPages, API_QUERY, kind);
}

export async function waitForRecord(page, recordId, workspaceId, timeoutSec, startedAt = Date.now(), kind = 'video') {
  const deadline = startedAt + timeoutSec * 1000;
  let last = null;
  while (Date.now() < deadline) {
    const r = await lookupRecord(page, recordId, workspaceId, 3, kind).catch((e) => ({ ok: false, error: String(e?.message || e) }));
    if (r.ok && r.rec) {
      last = r.rec;
      if (r.rec.status === 50 && r.rec.videos.length) return r.rec;
      if (r.rec.status === 30) return r.rec;
    }
    await sleep(8000);
  }
  return { ...(last || { history_record_id: String(recordId) }), timed_out: true };
}

export function statusText(code) {
  return STATUS_TEXT[code] || (code == null ? 'unknown' : 'running');
}

export async function downloadVideos(videos, outDir, baseName) {
  const dir = path.resolve(expandHome(outDir));
  fs.mkdirSync(dir, { recursive: true });
  const saved = [];
  for (let i = 0; i < videos.length; i++) {
    const v = videos[i];
    const file = path.join(dir, `${baseName}${videos.length > 1 ? `_${i + 1}` : ''}.mp4`);
    const resp = await fetch(v.url, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://jimeng.jianying.com/' } });
    if (!resp.ok || !resp.body) throw new CommandExecutionError(`视频下载失败: HTTP ${resp.status}`);
    await pipeline(Readable.fromWeb(resp.body), fs.createWriteStream(file));
    saved.push(file);
  }
  return saved;
}
