// opencli jimeng image — 即梦AI 图片生成（上传参考图 + @引用 + 提交 + 等待 + 下载）
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';
import {
  DOMAIN, applySettings, ensureImageType, expandHome, fillPrompt, installNetHook, openGenerator,
  parseFiles, parsePrompt, readSummary, resetDraft, selectModel, statusText, submit, uploadFiles, waitForRecord,
} from './utils.js';

async function downloadImages(images, outDir, baseName) {
  const dir = path.resolve(expandHome(outDir));
  fs.mkdirSync(dir, { recursive: true });
  const saved = [];
  for (let i = 0; i < images.length; i++) {
    const resp = await fetch(images[i].url, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://jimeng.jianying.com/' } });
    if (!resp.ok || !resp.body) throw new CommandExecutionError(`图片下载失败: HTTP ${resp.status}`);
    const ct = (resp.headers.get('content-type') || '').toLowerCase();
    const ext = ct.includes('jpeg') ? '.jpg' : ct.includes('webp') ? '.webp' : '.png';
    const file = path.join(dir, `${baseName}${images.length > 1 ? `_${i + 1}` : ''}${ext}`);
    await pipeline(Readable.fromWeb(resp.body), fs.createWriteStream(file));
    saved.push(file);
  }
  return saved;
}

cli({
  site: 'jimeng',
  name: 'image',
  access: 'write',
  description: '即梦AI 图片生成 — 上传参考图，提示词中用 @ 引用（与网页端一致），设置模型/比例/分辨率/数量，提交并等待/下载',
  example: 'opencli jimeng image "@图片1 中的毯子平铺在卧室床上" --files blanket.png --ratio 9:16 --count 1 --output ./out',
  domain: DOMAIN,
  strategy: Strategy.UI,
  browser: true,
  navigateBefore: false,
  defaultWindowMode: 'foreground',
  args: [
    { name: 'prompt', type: 'string', required: true, positional: true, help: '提示词。@图片N/@素材N 引用 --files 中的图片；@[名称] 引用素材名或资产库主体；@@ 表示字面 @' },
    { name: 'files', type: 'string', default: '', help: '参考图路径，逗号分隔' },
    { name: 'model', type: 'string', default: '', help: '模型名，如 "Seedream 5.5" / "即梦 ImageMax 1.0"（留空=保持网页当前选择）' },
    { name: 'ratio', type: 'string', default: '', help: '画面比例: 智能 / 1:1 / 3:4 / 16:9 / 4:3 / 9:16 / 2:3 / 3:2 / 21:9' },
    { name: 'resolution', type: 'string', default: '', help: '分辨率，如 1.5k / 2k / 4k（取决于模型）' },
    { name: 'strict', type: 'boolean', default: false, help: '比例/分辨率不可用时报错；默认忽略并保持网页当前值' },
    { name: 'count', type: 'int', default: 1, help: '生成数量 1-4（网页默认 4 张，这里默认 1 张以节省积分）' },
    { name: 'workspace', type: 'string', default: 'new', help: '会话: new / 会话ID / 会话标题' },
    { name: 'wait', type: 'boolean', default: true, help: '等待生成完成；false=提交后立即返回 record_id' },
    { name: 'timeout', type: 'int', default: 600, help: '总超时秒数' },
    { name: 'output', type: 'string', default: '', help: '下载图片到该目录' },
    { name: 'dry-run', type: 'boolean', default: false, help: '只上传并填写，不点击生成（不消耗积分）' },
    { name: 'max-credits', type: 'int', default: 0, help: '预计积分超过该值则不提交（0=不限制）' },
    { name: 'screenshot', type: 'string', default: '', help: '提交前截图保存到该路径' },
  ],
  columns: ['status', 'record_id', 'model', 'ratio_resolution', 'count', 'credits', 'prompt', 'image_url', 'file'],
  func: async (page, kwargs) => {
    const startedAt = Date.now();
    const prompt = String(kwargs.prompt ?? '');
    if (!prompt.trim()) throw new ArgumentError('提示词不能为空');
    const files = parseFiles(kwargs.files);
    if (files.some((f) => f.kind !== 'image')) throw new ArgumentError('图片生成只支持图片参考素材');
    const segments = parsePrompt(prompt, files);
    const count = Number(kwargs.count || 1);
    if (count < 1 || count > 4) throw new ArgumentError('--count 取值 1-4');

    await openGenerator(page, kwargs.workspace);
    await installNetHook(page);
    await resetDraft(page);
    await ensureImageType(page);
    await selectModel(page, String(kwargs.model || '').trim());
    await resetDraft(page);
    await uploadFiles(page, files, null);
    const filled = await fillPrompt(page, segments, files.length > 0);

    const warnings = [];
    await applySettings(page, { count });
    for (const [key, value] of [['ratio', String(kwargs.ratio || '').trim()], ['resolution', String(kwargs.resolution || '').trim().toLowerCase()]]) {
      if (!value) continue;
      try {
        await applySettings(page, { [key]: value });
      } catch (e) {
        if (kwargs.strict) throw e;
        warnings.push(String(e.message || e));
      }
    }
    const summary = await readSummary(page);
    if (summary.credits != null && summary.credits_per === 'image') summary.credits *= Number(summary.count || count);
    const base = {
      model: summary.model, ratio_resolution: summary.ratio_resolution, count: summary.count, credits: summary.credits,
      prompt: filled.text, uploaded: files.map((f) => f.name), warnings,
    };
    if (kwargs.screenshot) {
      const shot = path.resolve(expandHome(String(kwargs.screenshot)));
      await page.screenshot({ path: shot }).catch(() => undefined);
      base.screenshot = shot;
    }
    if (kwargs['dry-run']) return [{ status: 'dry-run', record_id: '', ...base, submit_enabled: summary.submit_enabled, image_url: '', file: '' }];
    if (!summary.submit_enabled) throw new CommandExecutionError('生成按钮不可用', '请检查提示词、参考图与积分余额');
    const maxCredits = Number(kwargs['max-credits'] || 0);
    if (maxCredits > 0 && summary.credits != null && summary.credits > maxCredits) {
      throw new ArgumentError(`预计消耗 ${summary.credits} 积分，超过 --max-credits ${maxCredits}，未提交`);
    }

    const job = await submit(page);
    const workspaceId = (/[?&]workspace=(\d+)/.exec(job.page_url) || [])[1] || '0';
    const submitted = { ...base, record_id: job.history_record_id, submit_id: job.submit_id, workspace_id: workspaceId };
    if (!kwargs.wait) return [{ status: 'submitted', ...submitted, image_url: '', file: '' }];

    const rec = await waitForRecord(page, job.history_record_id, workspaceId, Math.max(30, Number(kwargs.timeout) - 15), startedAt, 'image');
    const status = rec.timed_out ? 'timeout' : statusText(rec.status);
    if (status === 'failed') throw new CommandExecutionError(`即梦生成失败: ${rec.fail_msg || 'unknown'} (record ${job.history_record_id})`);
    const images = rec.videos || [];
    const saved = status === 'succeeded' && kwargs.output && images.length
      ? await downloadImages(images, kwargs.output, `jimeng_img_${job.history_record_id}`) : [];
    return (images.length ? images : [{}]).map((im, i) => ({
      status, ...submitted, credits: rec.credits ?? submitted.credits,
      image_url: im.url || '', width: im.width || null, height: im.height || null, file: saved[i] || '',
    }));
  },
});
