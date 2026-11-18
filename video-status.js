// opencli jimeng video-status — 查询/下载某个即梦视频生成任务（只读，不消耗积分）
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, EmptyResultError } from '@jackwener/opencli/errors';
import { DOMAIN, VIDEO_URL, downloadVideos, installNetHook, lookupRecord, statusText, waitForRecord } from './utils.js';
import { DEFAULT_PROJECT, resolveLibraryDir, saveToLibrary, showInUi } from './lib/library.js';

cli({
  site: 'jimeng',
  name: 'video-status',
  access: 'read',
  description: '即梦AI 查询视频生成任务状态（record_id），可等待完成并下载 mp4',
  example: 'opencli jimeng video-status <record_id> --output ./out',
  domain: DOMAIN,
  strategy: Strategy.UI,
  browser: true,
  navigateBefore: false,
  args: [
    { name: 'record_id', type: 'string', required: true, positional: true, help: 'history_record_id（jimeng video 返回的 record_id）' },
    { name: 'workspace', type: 'string', default: '0', help: '会话ID（加速查找，可选）' },
    { name: 'wait', type: 'boolean', default: false, help: '若仍在生成，则等待完成' },
    { name: 'timeout', type: 'int', default: 1800, help: '总超时秒数（含等待生成与下载）' },
    { name: 'output', type: 'string', default: '', help: '下载 mp4 到该目录（留空=不下载）' },
    { name: 'save', type: 'boolean', default: false, help: '存入素材库（可用于导入网页端生成的视频；已在库则跳过）' },
    { name: 'library', type: 'string', default: '', help: '素材库目录（默认取 library init 设置的目录）' },
    { name: 'project', type: 'string', default: '', help: '存入素材库时的项目' },
    { name: 'tags', type: 'string', default: '', help: '存入素材库时的额外标签，逗号分隔' },
    { name: 'open-ui', type: 'boolean', default: true, help: '入库后在管理页展示' },
  ],
  columns: ['status', 'record_id', 'model', 'credits', 'prompt', 'video_url', 'file'],
  func: async (page, kwargs) => {
    const rid = String(kwargs.record_id || '').trim();
    if (!/^\d+$/.test(rid)) throw new ArgumentError('record_id 应为数字');
    const ws = String(kwargs.workspace || '0');
    await page.goto(/^\d+$/.test(ws) && ws !== '0' ? `${VIDEO_URL}&workspace=${ws}` : VIDEO_URL);
    await installNetHook(page);
    let rec;
    if (kwargs.wait) rec = await waitForRecord(page, rid, ws, Number(kwargs.timeout));
    else {
      const r = await lookupRecord(page, rid, ws, 10);
      if (!r.ok) throw new Error(r.error);
      rec = r.rec;
    }
    if (!rec || (rec.status == null && !rec.videos)) throw new EmptyResultError('jimeng video-status', `没有找到 record ${rid}（可指定 --workspace 会话ID）`);
    const status = rec.timed_out ? 'timeout' : statusText(rec.status);
    const videos = rec.videos || [];
    let saved = [];
    if (status === 'succeeded' && kwargs.output && videos.length) {
      saved = await downloadVideos(videos, kwargs.output, `jimeng_${rid}`);
    }
    let libItems = [];
    const libInfo = {};
    if (status === 'succeeded' && kwargs.save && videos.length) {
      const lib = resolveLibraryDir(kwargs.library);
      libItems = await saveToLibrary(lib, {
        recordId: rid,
        workspaceId: ws !== '0' ? ws : null,
        createdAt: rec.created_time,
        prompt: rec.prompt,
        promptRaw: rec.prompt,
        project: kwargs.project || DEFAULT_PROJECT,
        tags: kwargs.tags,
        generation: { model: rec.model, credits: rec.credits },
        videos,
        source: 'video-status',
      });
      libInfo.library = lib;
      const ids = libItems.map((x) => x.id);
      const ui = await showInUi(lib, ids, { open: kwargs['open-ui'] }).catch((e) => ({ error: String(e.message || e) }));
      libInfo.ui_url = ui.url || '';
    }
    return (videos.length ? videos : [{}]).map((v, i) => ({
      status,
      record_id: rid,
      model: rec.model,
      credits: rec.credits,
      prompt: rec.prompt,
      fail_msg: rec.fail_msg || '',
      video_url: v.url || '',
      cover_url: v.cover || '',
      width: v.width || null,
      height: v.height || null,
      file: saved[i] || libItems[i]?.videoPath || '',
      library_item: libItems[i]?.id || '',
      ...libInfo,
    }));
  },
});
