// opencli jimeng video-list — 列出账号下最近的视频生成任务（只读，不消耗积分），可批量导入素材库
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, CommandExecutionError, EmptyResultError } from '@jackwener/opencli/errors';
import { DOMAIN, VIDEO_URL, statusText } from './utils.js';
import { DEFAULT_PROJECT, resolveLibraryDir, saveToLibrary, showInUi } from './lib/library.js';

const API_QUERY = 'aid=513695&device_platform=web&region=cn&web_version=7.5.0&da_version=3.3.40&aigc_features=app_lip_sync';

cli({
  site: 'jimeng',
  name: 'video-list',
  access: 'read',
  description: '即梦AI 列出最近的视频生成任务（含 record_id），可用 --save 批量导入素材库',
  example: 'opencli jimeng video-list --limit 10 -f table',
  domain: DOMAIN,
  strategy: Strategy.UI,
  browser: true,
  navigateBefore: false,
  args: [
    { name: 'limit', type: 'int', default: 20, help: '最多列出多少条（1-200）' },
    { name: 'workspace', type: 'string', default: '', help: '只看某个会话（会话ID，URL 中的 workspace=）' },
    { name: 'keyword', type: 'string', default: '', help: '按提示词关键字过滤' },
    { name: 'save', type: 'boolean', default: false, help: '把列出的成功任务全部导入素材库（已在库的跳过）' },
    { name: 'library', type: 'string', default: '', help: '素材库目录（默认取 library init 设置的目录）' },
    { name: 'project', type: 'string', default: '', help: '导入时的项目' },
    { name: 'open-ui', type: 'boolean', default: true, help: '导入后在管理页展示' },
  ],
  columns: ['record_id', 'created', 'status', 'model', 'videos', 'prompt', 'library_item'],
  func: async (page, kwargs) => {
    const limit = Number(kwargs.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new ArgumentError('--limit 取值 1-200');
    const ws = String(kwargs.workspace || '').trim();
    if (ws && !/^\d+$/.test(ws)) throw new ArgumentError('--workspace 应为数字会话ID');
    await page.goto(VIDEO_URL);
    const raw = await page.evaluate(async (limit, ws, kw, q) => {
      const out = [];
      let offset = 0;
      for (let p = 0; p < 20 && out.length < limit; p++) {
        const body = { count: 20, asset_type_list: [2], direction: 1, mode: 'workbench' };
        if (ws) body.workspace_id = Number(ws);
        if (offset) body.offset = offset;
        const r = await fetch(`/mweb/v1/get_asset_list?${q}`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const j = await r.json();
        if (String(j.ret) !== '0') return { error: `get_asset_list ret=${j.ret} ${j.errmsg}` };
        for (const a of j.data?.asset_list || []) {
          const v = a.video;
          if (!v || !v.history_record_id) continue;
          const prompt = v.item_list?.[0]?.common_attr?.prompt || '';
          if (kw && !prompt.includes(kw)) continue;
          const videos = (v.item_list || []).map((it) => {
            const tv = it.video?.transcoded_video || {};
            const best = tv.origin || Object.values(tv)[0] || {};
            return best.video_url ? { url: best.video_url, width: best.width || null, height: best.height || null, duration: it.video?.duration || null, cover: it.common_attr?.cover_url || null } : null;
          }).filter(Boolean);
          out.push({
            record_id: String(v.history_record_id),
            created_time: v.created_time || null,
            status: v.status,
            model: v.model_info?.model_name || '',
            credits: v.item_list?.[0]?.extra?.credits_consume ?? null,
            prompt,
            videos,
          });
          if (out.length >= limit) break;
        }
        if (!j.data?.has_more || !j.data?.next_offset) break;
        offset = j.data.next_offset;
      }
      return { rows: out };
    }, limit, ws, String(kwargs.keyword || ''), API_QUERY);
    const res = raw && raw.session && 'data' in raw ? raw.data : raw;
    if (res?.error) throw new CommandExecutionError(res.error);
    const rows = res?.rows || [];
    if (!rows.length) throw new EmptyResultError('jimeng video-list', '没有找到视频生成记录');

    const saved = new Map();
    let libInfo = {};
    if (kwargs.save) {
      const lib = resolveLibraryDir(kwargs.library);
      const ids = [];
      for (const r of rows.filter((x) => x.status === 50 && x.videos.length)) {
        const items = await saveToLibrary(lib, {
          recordId: r.record_id,
          workspaceId: ws || null,
          createdAt: r.created_time,
          prompt: r.prompt,
          promptRaw: r.prompt,
          project: kwargs.project || DEFAULT_PROJECT,
          generation: { model: r.model, credits: r.credits },
          videos: r.videos,
          source: 'video-list',
        });
        saved.set(r.record_id, items.map((x) => x.id).join(','));
        ids.push(...items.filter((x) => !x.duplicate).map((x) => x.id));
      }
      libInfo = { library: lib };
      if (ids.length) {
        const ui = await showInUi(lib, ids, { open: kwargs['open-ui'] }).catch(() => ({}));
        libInfo.ui_url = ui.url || '';
      }
    }
    const fmt = (t) => (t ? new Date(t * 1000).toLocaleString('zh-CN', { hour12: false }) : '');
    return rows.map((r) => ({
      record_id: r.record_id,
      created: fmt(r.created_time),
      status: statusText(r.status),
      model: r.model,
      videos: r.videos.length,
      prompt: r.prompt.replace(/\s+/g, ' ').slice(0, 60),
      library_item: saved.get(r.record_id) || '',
      ...libInfo,
    }));
  },
});
