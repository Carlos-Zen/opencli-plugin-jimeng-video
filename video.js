// opencli jimeng video — 即梦AI 视频生成（上传素材 + @引用 + 提交 + 等待 + 下载）
import path from 'node:path';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';
import {
  DOMAIN,
  applySettings,
  downloadVideos,
  ensureVideoType,
  expandHome,
  fillPrompt,
  installNetHook,
  openGenerator,
  parseFiles,
  parsePrompt,
  readSummary,
  resetDraft,
  selectMode,
  selectModel,
  statusText,
  submit,
  uploadFiles,
  waitForRecord,
} from './utils.js';
import { DEFAULT_PROJECT, resolveLibraryDir, saveToLibrary, showInUi } from './lib/library.js';

cli({
  site: 'jimeng',
  name: 'video',
  access: 'write',
  description: '即梦AI 视频生成 — 上传图片/视频/音频素材，提示词中用 @ 引用素材（与网页端一致），提交并等待/下载结果',
  example: 'opencli jimeng video "@图片1 中的女孩在 @视频1 的场景里跳舞" --files girl.png,dance.mp4 --model "Seedance 2.0 mini" --duration 5 --output ./out',
  domain: DOMAIN,
  strategy: Strategy.UI,
  browser: true,
  navigateBefore: false,
  // TipTap focus + mention popup rely on requestAnimationFrame, which is paused in hidden tabs
  defaultWindowMode: 'foreground',
  args: [
    { name: 'prompt', type: 'string', required: true, positional: true, help: '提示词。@图片N/@视频N/@音频N/@素材N 引用 --files 中的素材；@[名称] 引用素材名或资产库主体；@@ 表示字面 @；换行=新段落' },
    { name: 'files', type: 'string', default: '', help: '本地素材路径，逗号分隔（按顺序上传，最多 12 个）' },
    { name: 'model', type: 'string', default: '', help: '模型名，如 "Seedance 2.0 mini" / "Seedance 2.5 Flash"（留空=保持网页当前选择）' },
    { name: 'mode', type: 'string', default: '全能参考', help: '参考模式: 全能参考 / 首尾帧 / 智能多帧 / 智能编辑 / 超长视频 / 视频复刻' },
    { name: 'ratio', type: 'string', default: '', help: '画面比例: 21:9 / 16:9 / 4:3 / 1:1 / 3:4 / 9:16（留空=保持当前）' },
    { name: 'resolution', type: 'string', default: '', help: '分辨率: 480p / 720p / 1080p …（留空=保持当前）' },
    { name: 'duration', type: 'int', default: 0, help: '时长(秒)，0=保持当前' },
    { name: 'count', type: 'int', default: 0, help: '生成数量 1-4，0=保持当前' },
    { name: 'workspace', type: 'string', default: 'new', help: '会话: new=新会话 / 会话ID(数字) / 会话标题' },
    { name: 'wait', type: 'boolean', default: true, help: '等待生成完成；false=提交后立即返回 record_id' },
    { name: 'timeout', type: 'int', default: 1200, help: '总超时秒数（含等待生成）' },
    { name: 'output', type: 'string', default: '', help: '生成完成后下载 mp4 到该目录（留空=不下载，只返回链接）' },
    { name: 'dry-run', type: 'boolean', default: false, help: '只上传素材并填写提示词/参数，不点击生成（不消耗积分）' },
    { name: 'max-credits', type: 'int', default: 0, help: '预计积分超过该值则不提交（0=不限制）' },
    { name: 'screenshot', type: 'string', default: '', help: '提交前把填写好的页面截图保存到该路径（.png）' },
    { name: 'save', type: 'boolean', default: true, help: '生成完成后自动存入素材库（目录见 opencli jimeng library status）' },
    { name: 'library', type: 'string', default: '', help: '本次使用的素材库目录（默认取 library init 设置的目录）' },
    { name: 'project', type: 'string', default: '', help: '归入的项目（默认：--workspace 为会话标题时用该标题，否则「未分类」）' },
    { name: 'tags', type: 'string', default: '', help: '额外标签，逗号分隔（模型/比例/时长/参考类型等会自动打标签）' },
    { name: 'title', type: 'string', default: '', help: '素材标题（默认从提示词自动提取）' },
    { name: 'open-ui', type: 'boolean', default: true, help: '入库后在管理页展示（已打开则实时刷新，否则打开浏览器）' },
  ],
  columns: ['status', 'record_id', 'model', 'mode', 'ratio_resolution', 'duration', 'credits', 'prompt', 'video_url', 'file'],
  func: async (page, kwargs) => {
    const startedAt = Date.now();
    const prompt = String(kwargs.prompt ?? '');
    if (!prompt.trim()) throw new ArgumentError('提示词不能为空');
    const files = parseFiles(kwargs.files);
    const segments = parsePrompt(prompt, files);
    const mode = String(kwargs.mode || '').trim();
    const count = Number(kwargs.count || 0);
    if (count && (count < 1 || count > 4)) throw new ArgumentError('--count 取值 1-4');
    const timeout = Number(kwargs.timeout);
    const dryRun = Boolean(kwargs['dry-run']);

    // 1. open the generator (new conversation / existing one) and start from a clean draft
    await openGenerator(page, kwargs.workspace);
    await installNetHook(page);
    await resetDraft(page);

    // 2. type / model / mode first — they reset references & settings
    await ensureVideoType(page);
    await selectModel(page, String(kwargs.model || '').trim());
    await selectMode(page, mode);
    await resetDraft(page);

    // 3. materials → 4. prompt with @ chips → 5. ratio / resolution / duration / count
    await uploadFiles(page, files, mode);
    const filled = await fillPrompt(page, segments, files.length > 0);
    await applySettings(page, {
      ratio: String(kwargs.ratio || '').trim(),
      resolution: String(kwargs.resolution || '').trim(),
      count: count || '',
      duration: Number(kwargs.duration || 0) || '',
    });
    const summary = await readSummary(page);
    const base = {
      model: summary.model,
      mode: summary.mode,
      ratio_resolution: summary.ratio_resolution,
      duration: summary.duration,
      count: summary.count,
      credits: summary.credits,
      prompt: filled.text,
      uploaded: files.map((f) => f.name),
    };

    if (kwargs.screenshot) {
      const shot = path.resolve(expandHome(String(kwargs.screenshot)));
      await page.screenshot({ path: shot }).catch(() => undefined);
      base.screenshot = shot;
    }

    if (dryRun) {
      return [{ status: 'dry-run', record_id: '', ...base, submit_enabled: summary.submit_enabled, video_url: '', file: '', page_url: summary.url }];
    }
    if (!summary.submit_enabled) throw new CommandExecutionError('生成按钮不可用', '请检查提示词、素材与积分余额');
    const maxCredits = Number(kwargs['max-credits'] || 0);
    if (maxCredits > 0 && summary.credits != null && summary.credits > maxCredits) {
      throw new ArgumentError(`预计消耗 ${summary.credits} 积分，超过 --max-credits ${maxCredits}，未提交`);
    }

    // 6. submit (single click — never retried automatically)
    const job = await submit(page);
    const workspaceId = (/[?&]workspace=(\d+)/.exec(job.page_url) || [])[1] || '0';
    const submitted = { ...base, record_id: job.history_record_id, submit_id: job.submit_id, workspace_id: workspaceId };
    if (!kwargs.wait) {
      return [{ status: 'submitted', ...submitted, video_url: '', file: '' }];
    }

    // 7. wait for result
    const rec = await waitForRecord(page, job.history_record_id, workspaceId, Math.max(30, timeout - 15), startedAt);
    const status = rec.timed_out ? 'timeout' : statusText(rec.status);
    const videos = rec.videos || [];
    let saved = [];
    if (status === 'succeeded' && kwargs.output) {
      saved = await downloadVideos(videos, kwargs.output, `jimeng_${job.history_record_id}`);
    }
    if (status === 'failed') {
      throw new CommandExecutionError(`即梦生成失败: ${rec.fail_msg || 'unknown'} (record ${job.history_record_id})`);
    }
    // 8. 存入素材库 + 通知管理页（失败不影响已生成的结果）
    let libItems = [];
    let libInfo = {};
    if (status === 'succeeded' && kwargs.save && videos.length) {
      try {
        const lib = resolveLibraryDir(kwargs.library);
        const ws = String(kwargs.workspace || '').trim();
        const [ratio, resolution] = String(summary.ratio_resolution || '').split(/s+/);
        libItems = await saveToLibrary(lib, {
          recordId: job.history_record_id,
          submitId: job.submit_id,
          workspaceId,
          createdAt: rec.created_time || startedAt,
          prompt: filled.text,
          promptRaw: prompt,
          title: kwargs.title,
          project: kwargs.project || (ws && ws !== 'new' && !/^d+$/.test(ws) ? ws : DEFAULT_PROJECT),
          tags: kwargs.tags,
          references: files,
          subjects: segments.filter((s) => s.type === 'mention' && s.source !== 'upload').map((s) => s.label),
          generation: { model: summary.model, mode: summary.mode, ratio: ratio || '', resolution: resolution || '', duration: summary.duration, count: summary.count, credits: rec.credits ?? summary.credits },
          videos,
          source: 'video',
        });
        libInfo = { library: lib };
        const ids = libItems.map((x) => x.id);
        if (ids.length) {
          const ui = await showInUi(lib, ids, { open: kwargs['open-ui'] }).catch((e) => ({ error: String(e.message || e) }));
          libInfo.ui_url = ui.url || '';
          if (ui.error) libInfo.ui_error = ui.error;
        }
      } catch (e) {
        libInfo.library_error = String(e.message || e);
      }
    }
    const rows = (videos.length ? videos : [{}]).map((v, i) => ({
      status,
      ...submitted,
      credits: rec.credits ?? submitted.credits,
      video_url: v.url || '',
      cover_url: v.cover || '',
      width: v.width || null,
      height: v.height || null,
      file: saved[i] || libItems[i]?.videoPath || '',
      library_item: libItems[i]?.id || '',
      ...libInfo,
    }));
    return rows;
  },
});
