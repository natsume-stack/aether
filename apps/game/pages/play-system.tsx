import { subscribeRealtime } from '@box/realtime-client';
import type { GetServerSideProps } from 'next';
import { ApiClientError } from '@box/apis';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  ArrowLeft,
  CircleAlert,
  Clock3,
  Database,
  FolderTree,
  Gauge,
  HardDrive,
  RefreshCw,
  Server,
} from 'lucide-react';

import { isPlayAdminEnabled } from '../server/play-admin-security';
import { hasAuthenticatedPlayer, playerLoginURL, requestPlayerServiceIp } from '../server/player-service-client';
import { apiClient } from '../src/apis/client';
import styles from './play-system.module.css';

const TOKEN_KEY = 'box-play-admin-token';
type HealthState = 'healthy' | 'warning' | 'unhealthy' | 'disabled';
type RuntimeStatus = {
  phase: string;
  percent: number;
  message: string;
  port?: number;
  pid?: number;
  startedAt: string;
  updatedAt: string;
  latencyMs?: number;
};
type PlaySystemStatus = {
  status: 'healthy' | 'warning';
  checkedAt: string;
  host: {
    detail: string;
    version: string;
    nodeVersion: string;
    pid: number;
    uptimeSeconds: number;
    hostname: string;
    memory: { rssBytes: number; heapUsedBytes: number; heapTotalBytes: number };
    ports: { web: number; runtime: number };
  };
  services: Array<{
    id: string;
    name: string;
    state: HealthState;
    configured: boolean;
    detail: string;
    latencyMs?: number;
    endpoint?: string;
    check: 'http' | 'tcp';
  }>;
  disk: { state: HealthState; totalBytes: number; freeBytes: number; libraryPath: string };
  worlds: {
    count: number;
    groupCount: number;
    runtimes: Array<{
      worldId: string;
      publicId: string;
      worldName: string;
      mapRole: 'main' | 'submap';
      status: RuntimeStatus;
    }>;
  };
  diagnostics: Array<{ severity: 'warning' | 'error'; source: string; message: string }>;
};

const stateLabels: Record<HealthState, string> = {
  healthy: '正常',
  warning: '注意',
  unhealthy: '异常',
  disabled: '未启用',
};

function formatBytes(value: number) {
  if (!value) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const unit = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** unit).toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

function formatDuration(seconds: number) {
  if (seconds < 60) return `${seconds} 秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时 ${Math.floor((seconds % 3600) / 60)} 分钟`;
  return `${Math.floor(seconds / 86400)} 天 ${Math.floor((seconds % 86400) / 3600)} 小时`;
}

function runtimeLabel(phase: string) {
  if (phase === 'ready') return '运行中';
  if (phase === 'idle') return '未启动';
  if (phase === 'unavailable') return '管理服务不可用';
  if (phase === 'error') return '启动失败';
  if (phase === 'starting' || phase === 'loading') return '启动中';
  return phase || '未知';
}

function runtimeState(phase: string): HealthState {
  if (phase === 'ready') return 'healthy';
  if (phase === 'starting' || phase === 'loading') return 'warning';
  if (phase === 'error' || phase === 'unavailable') return 'unhealthy';
  return 'disabled';
}

function RuntimeCell({ status }: { status: RuntimeStatus }) {
  const state = runtimeState(status.phase);
  const showProgress = status.phase === 'starting' || status.phase === 'loading';
  return (
    <div className={styles.runtimeCell}>
      <div className={styles.runtimeCellTop}>
        <small>游玩运行时</small>
        <em className={styles[`state_${state}`]}>{runtimeLabel(status.phase)}</em>
      </div>
      <p>{status.message || '暂无运行信息'}</p>
      {showProgress && <div className={styles.runtimeProgress}><span style={{ width: `${Math.max(4, status.percent)}%` }} /></div>}
      <div className={styles.runtimeMeta}>
        {status.pid ? <span>PID {status.pid}</span> : null}
        {status.port ? <span>端口 {status.port}</span> : null}
        {status.latencyMs !== undefined ? <span>探测 {status.latencyMs} ms</span> : null}
        {status.startedAt ? <span>启动于 {new Date(status.startedAt).toLocaleString()}</span> : null}
      </div>
    </div>
  );
}

export const getServerSideProps: GetServerSideProps = async ({ req }) => {
  if (process.env.BOX_DEPLOYMENT_MODE !== 'play' || !process.env.BOX_PLAY_LIBRARY_PATH || !isPlayAdminEnabled()) {
    return { notFound: true };
  }
  const { hasAuthenticatedPlayer, playerLoginURL, requestPlayerServiceIp } = await import('../server/player-service-client');
  if (!await hasAuthenticatedPlayer(req.headers.cookie || '', requestPlayerServiceIp(req), String(req.headers['user-agent'] || ''))) {
    return { redirect: { destination: playerLoginURL('play'), permanent: false } };
  }
  return { props: {} };
};

export default function PlaySystemPage() {
  const router = useRouter();
  const [data, setData] = useState<PlaySystemStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const refresh = useCallback(async (quiet = false) => {
    const token = window.sessionStorage.getItem(TOKEN_KEY);
    if (!token) {
      void router.replace('/');
      return;
    }
    if (!quiet) setLoading(true);
    try {
      const next = await apiClient.getApiPlayAdminStatus({
        cache: 'no-store',
        headers: { Authorization: `Bearer ${token}` },
      }) as PlaySystemStatus;
      setData(next);
      setError('');
    } catch (nextError) {
      if (
        nextError instanceof ApiClientError &&
        (nextError.response.status === 401 || nextError.response.status === 403)
      ) {
        window.sessionStorage.removeItem(TOKEN_KEY);
        void router.replace('/');
        return;
      }
      setError((nextError as Error).message);
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    void refresh();
    const token = window.sessionStorage.getItem(TOKEN_KEY);
    if (!token) return;
    return subscribeRealtime('play-status:' + token, { body: { kind: 'play-status' }, headers: { Authorization: `Bearer ${token}` } }, event => {
      if (event.type === 'snapshot') { setData(event.data); setError(''); }
      if (event.type === 'unauthorized') { window.sessionStorage.removeItem(TOKEN_KEY); void router.replace('/'); }
      if (event.type === 'disconnected') setError('状态连接已断开，正在重连');
    });
  }, [refresh, router]);

  const activeRuntimes = data?.worlds.runtimes.filter(({ status }) => status.phase === 'ready').length;
  const diskUsed = data ? Math.max(0, data.disk.totalBytes - data.disk.freeBytes) : 0;
  const diskPercent = data?.disk.totalBytes ? Math.round((diskUsed / data.disk.totalBytes) * 100) : 0;
  const orderedRuntimes = useMemo(() => [...(data?.worlds.runtimes || [])].sort((left, right) => {
    if (left.mapRole !== right.mapRole) return left.mapRole === 'main' ? -1 : 1;
    return left.worldName.localeCompare(right.worldName);
  }), [data]);

  return (
    <main className={styles.page}>
      <Head><title>游玩端运行状态</title></Head>
      <header className={styles.header}>
        <div className={styles.headerTitle}><h1>运行状态</h1><span>地图运行时、基础服务、进程和游玩包磁盘</span></div>
        <div className={styles.headerActions}>
          <span className={`${styles.overall} ${data?.status === 'warning' ? styles.warning : ''}`}><span />{data?.status === 'warning' ? '需要检查' : '运行正常'}</span>
          <button className={styles.refreshButton} onClick={() => void refresh()} disabled={loading}><RefreshCw size={16} className={loading ? styles.spinning : ''} /> 刷新</button>
          <a className={styles.back} href="/"><ArrowLeft size={16} /> 返回作品管理</a>
        </div>
      </header>

      <section className={styles.content}>
        <p className={styles.intro}>集中检查游玩端健康情况。页面每 5 秒自动刷新，不显示数据库密码、令牌或连接密钥。</p>

        {error && <div className={styles.error}>{error}</div>}

        <div className={styles.summaryGrid}>
          <article><FolderTree /><div><strong>{data?.worlds.groupCount ?? '—'}</strong><span>地图组</span></div></article>
          <article><Gauge /><div><strong>{data?.worlds.count ?? '—'}</strong><span>已安装地图</span></div></article>
          <article><Activity /><div><strong>{activeRuntimes ?? '—'}</strong><span>活跃运行时</span></div></article>
          <article><HardDrive /><div><strong>{data ? `${diskPercent}%` : '—'}</strong><span>磁盘已使用</span></div></article>
        </div>

        <section className={styles.panel}>
          <div className={styles.panelTitle}><Server size={18} /><div><h2>游玩端</h2><p>当前服主管理网页进程与地图运行时入口。</p></div></div>
          {data?.host ? <div className={styles.creatorGrid}>
            <div className={styles.creatorPrimary}><span className={styles.creatorState}><i />{data.host.detail}</span><strong>Local Engine {data.host.version}</strong><small>{data.host.nodeVersion} · PID {data.host.pid}</small></div>
            <div><span>持续运行</span><strong><Clock3 size={14} />{formatDuration(data.host.uptimeSeconds)}</strong></div>
            <div><span>进程内存</span><strong>{formatBytes(data.host.memory.rssBytes)}</strong><small>堆 {formatBytes(data.host.memory.heapUsedBytes)} / {formatBytes(data.host.memory.heapTotalBytes)}</small></div>
            <div><span>服务端口</span><strong>Web {data.host.ports.web}</strong><small>运行时管理 {data.host.ports.runtime}</small></div>
            <div><span>运行节点</span><strong title={data.host.hostname}>{data.host.hostname}</strong><small>每 5 秒自动刷新</small></div>
          </div> : <div className={styles.loading}>正在读取游玩端状态…</div>}
        </section>

        {!!data?.diagnostics.length && <section className={`${styles.panel} ${styles.diagnosticsPanel}`}>
          <div className={styles.panelTitle}><CircleAlert size={18} /><div><h2>需要处理</h2><p>只显示会影响游玩的异常，未配置的可选服务不会报警。</p></div></div>
          <div className={styles.diagnosticList}>{data.diagnostics.map((item, index) => <div key={`${item.source}:${index}`}><span>{item.source}</span><p>{item.message}</p><em>{item.severity === 'error' ? '异常' : '注意'}</em></div>)}</div>
        </section>}

        <section className={styles.panel}>
          <div className={styles.panelTitle}><Database size={18} /><div><h2>基础服务</h2><p>检查玩家服务、PostgreSQL、Redis 和已配置的资源服务。</p></div></div>
          <div className={styles.serviceGrid}>{data?.services.map((service) => <div className={styles.service} key={service.id}><Database size={18} /><div><strong>{service.name}</strong><span>{service.detail}{service.latencyMs !== undefined ? ` · ${service.latencyMs} ms` : ''}</span><small>{service.endpoint ? `${service.check.toUpperCase()} · ${service.endpoint}` : service.configured ? service.check.toUpperCase() : '可选依赖'}</small></div><em className={styles[`state_${service.state}`]}>{stateLabels[service.state]}</em></div>) || <div className={styles.loading}>正在检查服务…</div>}</div>
        </section>

        <section className={styles.panel}>
          <div className={styles.panelTitle}><Activity size={18} /><div><h2>地图运行时</h2><p>这里只读取状态，不会为了检查而启动地图。</p></div></div>
          <div className={styles.runtimeList}>{orderedRuntimes.length ? orderedRuntimes.map((runtime) => <div className={`${styles.runtime} ${styles.playRuntime}`} key={runtime.worldId}><div className={styles.runtimeIdentity}><strong>{runtime.worldName}</strong><code>/p/{runtime.publicId}</code><small>{runtime.mapRole === 'main' ? '主地图' : '副地图'} · {runtime.worldId}</small></div><RuntimeCell status={runtime.status} /></div>) : <div className={styles.loading}>暂无已安装地图</div>}</div>
        </section>

        <section className={styles.diskPanel}><HardDrive size={18} /><div><strong>游玩包磁盘</strong><span>{data ? `${formatBytes(data.disk.freeBytes)} 可用，共 ${formatBytes(data.disk.totalBytes)}` : '正在读取…'}</span></div><div className={styles.diskTrack}><span style={{ width: `${diskPercent}%` }} /></div></section>
        {data && <p className={styles.checkedAt}>最后检查：{new Date(data.checkedAt).toLocaleString()}</p>}
      </section>
    </main>
  );
}
