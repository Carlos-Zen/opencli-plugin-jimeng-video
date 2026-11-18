// opencli jimeng library — 即梦素材库：打开管理页 / 设置目录 / 查看状态 / 停止服务
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';
import {
  configPath, ensureLibrary, ensureServer, libraryStats, openUrl, readConfig, readServerInfo,
  resolveLibraryDir, stopServer, writeConfig,
} from './lib/library.js';

const ACTIONS = ['open', 'init', 'status', 'stop'];

cli({
  site: 'jimeng',
  name: 'library',
  access: 'write',
  description: '即梦素材库 — open: 打开管理页面 / init: 设置素材库目录 / status: 查看状态 / stop: 停止本地服务',
  example: 'opencli jimeng library init --dir D:/Jimeng素材库',
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    { name: 'action', type: 'string', positional: true, default: 'open', help: 'open | init | status | stop（默认 open）' },
    { name: 'dir', type: 'string', default: '', help: '素材库目录（init 时保存为默认目录；其它操作临时指定）' },
    { name: 'port', type: 'int', default: 0, help: '本地服务端口（默认 17890，被占用自动顺延；init 时保存）' },
    { name: 'open', type: 'boolean', default: true, help: 'open 时是否打开浏览器' },
  ],
  columns: ['action', 'library', 'url', 'active', 'archived', 'size_mb', 'server'],
  func: async (kwargs) => {
    const action = String(kwargs.action || 'open').trim().toLowerCase();
    if (!ACTIONS.includes(action)) throw new ArgumentError(`未知操作 ${action}`, `可用: ${ACTIONS.join(' / ')}`);
    const port = Number(kwargs.port || 0) || undefined;

    if (action === 'init') {
      if (!String(kwargs.dir || '').trim()) throw new ArgumentError('init 需要 --dir <素材库目录>');
      const lib = resolveLibraryDir(kwargs.dir);
      const prev = readConfig().libraryDir;
      ensureLibrary(lib);
      writeConfig({ libraryDir: lib, ...(port ? { port } : {}) });
      const s = libraryStats(lib);
      return [{ action, library: lib, previous: prev || '', config: configPath(), active: s.active, archived: s.archived, size_mb: +(s.activeBytes / 1048576).toFixed(1), url: '', server: '' }];
    }

    const lib = resolveLibraryDir(kwargs.dir);
    if (action === 'stop') {
      const stopped = await stopServer(lib);
      return [{ action, library: lib, server: stopped ? 'stopped' : 'not running', url: '' }];
    }
    ensureLibrary(lib);
    const s = libraryStats(lib);
    const row = { action, library: lib, active: s.active, archived: s.archived, size_mb: +(s.activeBytes / 1048576).toFixed(1), archived_mb: +(s.archivedBytes / 1048576).toFixed(1), projects: s.projects };

    if (action === 'status') {
      const info = readServerInfo(lib);
      let server = 'not running';
      let url = '';
      if (info?.port) {
        try {
          const r = await fetch(`http://127.0.0.1:${info.port}/api/ping`, { signal: AbortSignal.timeout(1500) });
          const j = await r.json();
          if (j.app === 'jimeng-library') { server = `running (pid ${j.pid})`; url = `http://127.0.0.1:${info.port}/`; }
        } catch { /* not running */ }
      }
      return [{ ...row, url, server, config: configPath(), configured: Boolean(readConfig().libraryDir || process.env.JIMENG_LIBRARY) }];
    }

    let srv;
    try { srv = await ensureServer(lib, { port }); } catch (e) { throw new CommandExecutionError(String(e.message || e)); }
    const url = `${srv.url}/`;
    if (kwargs.open) openUrl(url);
    return [{ ...row, url, server: srv.started ? 'started' : 'running' }];
  },
});
