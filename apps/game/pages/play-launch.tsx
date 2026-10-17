import { useEffect, useMemo, useState } from 'react';
import type { GetServerSideProps } from 'next';
import { useRouter } from 'next/router';
import { IntlProvider } from 'react-intl';
import { PlayLoading } from '../components/play-loading';
import { PlayResourceCacheBootstrap } from '../components/play-resource-cache-bootstrap';
import { LoadingStage } from '../src/defs/loading-stage';
import { resolvePublicUrl } from '../src/utils/public-url';
import { hasAuthenticatedPlayer, playerLoginURL, requestPlayerServiceIp } from '../server/player-service-client';
import { findPlayWorld } from '../server/play-worlds';

type RuntimeStatus = {
  phase: 'idle' | 'starting' | 'loading' | 'ready' | 'error';
  percent: number;
  message: string;
};

type PlayLaunchProps = { cover: string; worldName: string };

export const getServerSideProps: GetServerSideProps<PlayLaunchProps> = async ({ req, query }) => {
  if (process.env.BOX_DEPLOYMENT_MODE !== 'play') return { notFound: true };
  const worldId = Array.isArray(query.world) ? query.world[0] : query.world;
  const world = findPlayWorld(String(worldId || ''));
  if (!world) return { notFound: true };
  if (!await hasAuthenticatedPlayer(req.headers.cookie || '', requestPlayerServiceIp(req), String(req.headers['user-agent'] || ''))) {
    return { redirect: { destination: playerLoginURL('play'), permanent: false } };
  }
  return { props: { cover: world?.loadingCover || '', worldName: world?.name || '本地作品' } };
};

export default function PlayLaunchPage({ cover, worldName }: PlayLaunchProps) {
  const router = useRouter();
  const world = typeof router.query.world === 'string' ? router.query.world : '';
  const name = worldName;
  const [elapsed, setElapsed] = useState(0);
  const [status, setStatus] = useState<RuntimeStatus>({ phase: 'idle', percent: 4, message: '正在提交启动请求' });
  const percent = useMemo(() => status.phase === 'ready' ? 100 : status.phase === 'error' ? status.percent : Math.round(Math.min(92, Math.max(status.percent, 4 + elapsed * .8))), [elapsed, status]);

  useEffect(() => {
    const startedAt = Date.now();
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 500);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!router.isReady) return;
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(world)) {
      setStatus({ phase: 'error', percent: 0, message: '地图 ID 无效' });
      return;
    }
    let cancelled = false;
    let timer: number | undefined;
    const request = async (action: 'start' | 'status') => {
      const response = await fetch(`/p/${encodeURIComponent(world)}/__local_runtime/${action}`, { method: action === 'start' ? 'POST' : 'GET', headers: action === 'start' ? { 'x-box-runtime-restart': '1' } : undefined });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || `启动失败（HTTP ${response.status}）`);
      return data as RuntimeStatus;
    };
    const poll = async () => {
      try {
        const next = await request('status');
        if (cancelled) return;
        setStatus(next);
        if (next.phase === 'ready') {
          window.setTimeout(
            () => window.location.replace(resolvePublicUrl(`/p/${encodeURIComponent(world)}`)),
            300,
          );
          return;
        }
        if (next.phase !== 'error') timer = window.setTimeout(poll, 800);
      } catch (error) {
        if (!cancelled) setStatus({ phase: 'error', percent: 0, message: error instanceof Error ? error.message : '启动失败' });
      }
    };
    request('start').then((next) => {
      if (!cancelled) { setStatus(next); timer = window.setTimeout(poll, 500); }
    }).catch((error) => {
      if (!cancelled) setStatus({ phase: 'error', percent: 0, message: error instanceof Error ? error.message : '启动失败' });
    });
    return () => { cancelled = true; if (timer) window.clearTimeout(timer); };
  }, [router.isReady, world]);

  const failed = status.phase === 'error';
  const stage = status.phase === 'ready'
    ? LoadingStage.done
    : status.phase === 'loading'
      ? LoadingStage.game
      : LoadingStage.file;
  return <IntlProvider locale="zh-CN" messages={{ playLoadingTip: '搭建世界需要大量的披萨和可乐...' }}>
    <PlayResourceCacheBootstrap world={world} />
    <PlayLoading
      stage={stage}
      loadingConfig={false}
      gameCover={cover}
      progress={percent}
      error={failed}
      message={failed ? `启动失败：${status.message}` : `${name} · ${status.message} · ${elapsed}s · `}
      actions={failed ? <><button onClick={() => window.location.reload()}>重新尝试</button><button onClick={() => router.push('/')}>返回作品列表</button></> : undefined}
    />
  </IntlProvider>;
}
