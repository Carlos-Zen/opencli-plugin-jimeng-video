// opencli jimeng bridge — 即梦网页桥接服务：让 ArcReel 等工具通过 HTTP API 使用即梦网页账号生成视频
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';
import {
  bridgeConfig, bridgeStatus, ensureBridge, ensureBridgeToken, resolveLibraryDir, saveBridgeConfig, stopBridge,
} from './lib/library.js';
import { DEFAULT_IMAGE_MODELS, DEFAULT_MODELS, readArcreelEnv, setupArcreel } from './lib/arcreel.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFINITION = path.join(HERE, 'arcreel', 'jimeng-web-bridge.json');
const ACTIONS = ['start', 'status', 'stop', 'restart', 'token', 'definition', 'jobs', 'arcreel'];

cli({
  site: 'jimeng',
  name: 'bridge',
  access: 'write',
  description: '即梦网页桥接服务 — start/status/stop/restart，token: 查看(--reset 重置)令牌，definition: 输出 ArcReel 端点定义，jobs: 最近任务',
  example: 'opencli jimeng bridge start --max-credits 60',
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    { name: 'action', type: 'string', positional: true, default: 'status', help: ACTIONS.join(' | ') },
    { name: 'port', type: 'int', default: 0, help: '监听端口（默认 17891，保存为配置）' },
    { name: 'host', type: 'string', default: '', help: '监听地址（默认 127.0.0.1；Docker Desktop 可通过 host.docker.internal 访问。保存为配置）' },
    { name: 'max-credits', type: 'int', default: -1, help: '单个任务预计积分上限，超过则拒绝提交（0=不限，保存为配置）' },
    { name: 'project', type: 'string', default: '', help: '桥接生成的视频在素材库中的项目名（默认 ArcReel，保存为配置）' },
    { name: 'model', type: 'string', default: '', help: '请求未指定模型时使用的即梦模型（保存为配置）' },
    { name: 'library', type: 'string', default: '', help: '素材库目录（任务状态与生成结果存放处）' },
    { name: 'reset', type: 'boolean', default: false, help: 'token 时重新生成令牌（旧令牌立即失效，需要同步修改 ArcReel）' },
    { name: 'out', type: 'string', default: '', help: 'definition 时把定义写到该文件' },
    { name: 'replay-record', type: 'string', default: '', help: '测试模式：网页只 dry-run 不提交，用该已有 record_id 作为结果（不消耗积分）' },
    { name: 'replay-image-record', type: 'string', default: '', help: '测试模式（图片）：同上，用该已有图片任务作为结果' },
    { name: 'image-model', type: 'string', default: '', help: '请求未指定模型时使用的即梦图片模型（默认 Seedream 5.5，保存为配置）；arcreel 时为要添加的图片模型，逗号分隔' },
    { name: 'arcreel-url', type: 'string', default: 'http://127.0.0.1:1241', help: 'arcreel：ArcReel 地址' },
    { name: 'arcreel-env', type: 'string', default: '', help: 'arcreel：ArcReel deploy/.env 路径（从中读取管理员账号密码）' },
    { name: 'arcreel-user', type: 'string', default: '', help: 'arcreel：管理员用户名（默认取 .env 或 admin）' },
    { name: 'arcreel-password', type: 'string', default: '', help: 'arcreel：管理员密码（也可用环境变量 ARCREEL_PASSWORD）' },
    { name: 'models', type: 'string', default: '', help: 'arcreel：要添加的即梦模型名，逗号分隔（默认 即梦 Seedance 2.0 Fast VIP,即梦 Seedance 2.0 mini）' },
    { name: 'durations', type: 'string', default: '4-15', help: 'arcreel：模型可选时长（秒），如 4-15 或 4,5,8,10' },
    { name: 'resolution', type: 'string', default: '720p', help: 'arcreel：分辨率' },
  ],
  columns: ['action', 'status', 'task_id', 'record_id', 'credits', 'error', 'url', 'docker_url', 'max_credits'],
  func: async (kwargs) => {
    const action = String(kwargs.action || 'status').toLowerCase();
    if (!ACTIONS.includes(action)) throw new ArgumentError(`未知操作 ${action}`, `可用: ${ACTIONS.join(' / ')}`);
    const lib = resolveLibraryDir(kwargs.library);
    const patch = {};
    if (Number(kwargs.port) > 0) patch.port = Number(kwargs.port);
    if (String(kwargs.host || '').trim()) patch.host = String(kwargs.host).trim();
    if (Number(kwargs['max-credits']) >= 0) patch.maxCredits = Number(kwargs['max-credits']);
    if (String(kwargs.project || '').trim()) patch.project = String(kwargs.project).trim();
    if (String(kwargs.model || '').trim()) patch.defaultModel = String(kwargs.model).trim();
    if (action !== 'arcreel' && String(kwargs['image-model'] || '').trim()) patch.defaultImageModel = String(kwargs['image-model']).trim();
    if (Object.keys(patch).length) saveBridgeConfig(patch);

    const describe = (st, extra = {}) => {
      const c = bridgeConfig();
      return {
        action,
        status: st.running ? `running (pid ${st.pid})` : 'stopped',
        url: `http://127.0.0.1:${c.port}`,
        docker_url: `http://host.docker.internal:${c.port}`,
        token: c.token,
        max_credits: c.maxCredits || 0,
        project: c.project,
        default_model: c.defaultModel || '',
        default_image_model: c.defaultImageModel || '',
        library: lib,
        log: path.join(lib, '.system', 'bridge', 'bridge.log'),
        definition: DEFINITION,
        ...extra,
      };
    };

    if (action === 'token') {
      ensureBridgeToken(Boolean(kwargs.reset));
      const st = await bridgeStatus(lib);
      if (kwargs.reset && st.running) { await stopBridge(lib); await new Promise((r) => setTimeout(r, 500)); await ensureBridge(lib); }
      return [describe(await bridgeStatus(lib))];
    }
    if (action === 'definition') {
      const text = fs.readFileSync(DEFINITION, 'utf8');
      if (kwargs.out) fs.writeFileSync(path.resolve(String(kwargs.out)), text);
      return [{ ...describe(await bridgeStatus(lib)), definition: kwargs.out ? path.resolve(String(kwargs.out)) : DEFINITION, json: JSON.parse(text) }];
    }
    if (action === 'stop') {
      const stopped = await stopBridge(lib);
      await new Promise((r) => setTimeout(r, 400));
      return [describe(await bridgeStatus(lib), { stopped })];
    }
    if (action === 'arcreel') {
      const env = kwargs['arcreel-env'] ? readArcreelEnv(path.resolve(String(kwargs['arcreel-env']))) : {};
      const password = String(kwargs['arcreel-password'] || process.env.ARCREEL_PASSWORD || env.AUTH_PASSWORD || '');
      if (!password) throw new ArgumentError('需要 ArcReel 管理员密码', '用 --arcreel-env <ArcReel 的 deploy/.env> 或 --arcreel-password');
      const spec = String(kwargs.durations || '4-15').trim();
      const range = /^(\d+)\s*-\s*(\d+)$/.exec(spec);
      const durations = range
        ? Array.from({ length: Number(range[2]) - Number(range[1]) + 1 }, (_, i) => Number(range[1]) + i)
        : spec.split(/[,，\s]+/).map(Number).filter((n) => Number.isInteger(n) && n > 0);
      if (!durations.length) throw new ArgumentError(`--durations 无效: ${spec}`);
      const token = ensureBridgeToken();
      const c = bridgeConfig();
      const models = String(kwargs.models || '').split(/[,，]/).map((s) => s.trim()).filter(Boolean);
      try {
        const r = await setupArcreel({
          url: String(kwargs['arcreel-url']),
          username: String(kwargs['arcreel-user'] || env.AUTH_USERNAME || 'admin'),
          password,
          bridgeUrl: `http://host.docker.internal:${c.port}`,
          bridgeToken: token,
          models: models.length ? models : DEFAULT_MODELS,
          imageModels: (() => { const l = String(kwargs['image-model'] || '').split(/[,，]/).map((s) => s.trim()).filter(Boolean); return l.length ? l : DEFAULT_IMAGE_MODELS; })(),
          durations,
          resolution: String(kwargs.resolution || '720p').toLowerCase(),
          videoWorkers: 3,
        });
        return [{ action, status: 'configured', url: String(kwargs['arcreel-url']), docker_url: `http://host.docker.internal:${c.port}`, ...r }];
      } catch (e) {
        throw new CommandExecutionError(String(e.message || e));
      }
    }
    if (action === 'jobs') {
      const st = await bridgeStatus(lib);
      if (!st.running) throw new CommandExecutionError('桥接服务未运行', 'opencli jimeng bridge start');
      const r = await fetch(`http://127.0.0.1:${st.port}/v1/jimeng/videos`, { headers: { authorization: `Bearer ${bridgeConfig().token}` } });
      const j = await r.json();
      return (j.data || []).map((x) => ({ action: 'job', task_id: x.task_id, created: x.created_at, status: x.status, record_id: x.record_id || '', credits: x.credits ?? '', mode: x.mode, model: x.model, error: x.error || '', prompt: x.prompt }));
    }
    if (action === 'restart' || (action === 'start' && (Object.keys(patch).length || kwargs['replay-record'] || kwargs['replay-image-record']))) {
      await stopBridge(lib);
      await new Promise((r) => setTimeout(r, 500));
    }
    if (action === 'status') return [describe(await bridgeStatus(lib))];
    try {
      const st = await ensureBridge(lib, { replayRecord: String(kwargs['replay-record'] || '').trim(), replayImageRecord: String(kwargs['replay-image-record'] || '').trim() });
      return [describe(st, { started: st.started })];
    } catch (e) {
      throw new CommandExecutionError(String(e.message || e));
    }
  },
});
