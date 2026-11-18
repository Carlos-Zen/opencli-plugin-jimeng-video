// 一键把即梦网页桥接配置进 ArcReel：导入/更新端点定义 → 创建/更新自定义供应商与模型。可重复执行。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFINITION_FILE = path.join(HERE, '..', 'arcreel', 'jimeng-web-bridge.json');
export const PROVIDER_NAME = '即梦网页（opencli 桥接）';
export const IMAGE_DEFINITION_FILE = path.join(HERE, '..', 'arcreel', 'jimeng-web-bridge-image.json');
export const DEFAULT_MODELS = ['即梦 Seedance 2.0 Fast VIP', '即梦 Seedance 2.0 mini'];
export const DEFAULT_IMAGE_MODELS = ['Seedream 5.5', '即梦 ImageMax 1.0'];

/** 从 ArcReel deploy/.env 读取 AUTH_USERNAME / AUTH_PASSWORD */
export function readArcreelEnv(file) {
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

async function call(base, token, method, url, body) {
  const r = await fetch(`${base}/api/v1${url}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'accept-language': 'zh' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let j;
  try { j = JSON.parse(text); } catch { j = { raw: text }; }
  if (!r.ok) throw new Error(`ArcReel ${method} ${url} → HTTP ${r.status}: ${JSON.stringify(j.detail ?? j).slice(0, 800)}`);
  return j;
}

async function upsertEndpoint(base, token, file, mediaType) {
  const definition = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list = await call(base, token, 'GET', '/custom-endpoints');
  const existing = (list.endpoints || []).find((e) => e.display_name === definition.meta.name);
  const ep = existing
    ? await call(base, token, 'PUT', `/custom-endpoints/${existing.id}`, definition)
    : await call(base, token, 'POST', `/custom-endpoints?media_type=${mediaType}`, definition);
  return { ep, action: existing ? 'updated' : 'created' };
}

export async function setupArcreel({ url, username, password, bridgeUrl, bridgeToken, models, imageModels = [], durations, resolution, videoWorkers }) {
  const base = url.replace(/\/+$/, '');
  const form = new URLSearchParams({ username, password });
  const lr = await fetch(`${base}/api/v1/auth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form });
  if (!lr.ok) throw new Error(`ArcReel 登录失败 HTTP ${lr.status}（检查用户名/密码）`);
  const token = (await lr.json()).access_token;

  // 1. 端点定义（按 meta.name 识别，已存在则原地更新）
  const { ep, action: endpointAction } = await upsertEndpoint(base, token, DEFINITION_FILE, 'video');
  const img = imageModels.length ? await upsertEndpoint(base, token, IMAGE_DEFINITION_FILE, 'image') : null;

  // 2. 供应商 + 模型（视频与图片模型挂在同一个供应商下，各自指向自己的端点）
  const modelInputs = [
    ...models.map((m, i) => ({
      model_id: m,
      display_name: m,
      endpoint: ep.key,
      is_default: i === 0,
      is_enabled: true,
      resolution,
      capability_overrides: { durations, resolutions: [resolution] },
    })),
    ...imageModels.map((m, i) => ({
      model_id: m,
      display_name: m,
      endpoint: img.ep.key,
      is_default: i === 0,
      is_enabled: true,
    })),
  ];
  const existing = endpointAction === 'updated';
  const providers = (await call(base, token, 'GET', '/custom-providers')).providers || [];
  const prev = providers.find((p) => p.display_name === PROVIDER_NAME);
  const payload = {
    display_name: PROVIDER_NAME,
    base_url: bridgeUrl,
    api_key: bridgeToken,
    models: modelInputs,
    // 网页操作本就串行，并发只决定 ArcReel 一次往桥接排队多少个任务
    image_max_workers: imageModels.length ? 2 : null,
    video_max_workers: videoWorkers,
    audio_max_workers: null,
  };
  const provider = prev
    ? await call(base, token, 'PUT', `/custom-providers/${prev.id}`, payload)
    : await call(base, token, 'POST', '/custom-providers', { ...payload, discovery_format: 'openai' });
  return {
    endpoint_key: ep.key,
    endpoint_action: existing ? 'updated' : 'created',
    image_endpoint_key: img?.ep.key || '',
    image_endpoint_action: img?.action || '',
    provider_id: provider.id,
    provider_action: prev ? 'updated' : 'created',
    models: (provider.models || []).map((m) => m.model_id || m.display_name),
  };
}
