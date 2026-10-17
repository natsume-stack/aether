import { useEffect, useMemo, useState } from 'react';
import type { GetServerSideProps } from 'next';
import { useRouter } from 'next/router';
import { ArenaBg } from '../../components/loading/arena';
import { apiClient } from '../../src/apis/client';
import { hasAuthenticatedPlayer, playerLoginURL, requestPlayerServiceIp } from '../../server/player-service-client';
import { getLocalProjectManager } from '../../server/local-project-manager';


type RuntimeStatus = {
  phase: 'idle' | 'starting' | 'loading' | 'ready' | 'error';
  percent: number;
  message: string;
  editUrl?: string;
  playUrl?: string;
};

export const getServerSideProps: GetServerSideProps = async ({ req, query }) => {
  if (process.env.BOX_DEPLOYMENT_MODE === 'play') return { notFound: true };
  const projectId = Array.isArray(query.project) ? query.project[0] : query.project;
  try {
    getLocalProjectManager().getProject(String(projectId || ''));
  } catch {
    return { notFound: true };
  }
  if (!await hasAuthenticatedPlayer(req.headers.cookie || '', requestPlayerServiceIp(req), String(req.headers['user-agent'] || ''))) {
    return { redirect: { destination: playerLoginURL('creator'), permanent: false } };
  }
  return { props: {} };
};

export default function ProjectLaunchPage() {
  const router = useRouter();
  const project = typeof router.query.project === 'string' ? router.query.project : '';
  const mode = router.query.mode === 'play' ? 'play' : 'edit';
  const name = typeof router.query.name === 'string' ? router.query.name : '本地作品';
  const [status, setStatus] = useState<RuntimeStatus>({
    phase: 'idle',
    percent: 4,
    message: '正在提交启动请求',
  });
  const [elapsed, setElapsed] = useState(0);

  const displayPercent = useMemo(() => {
    if (status.phase === 'ready') return 100;
    if (status.phase === 'error') return status.percent || 0;
    const estimated = status.phase === 'idle'
      ? 4 + elapsed * 1.2
      : status.phase === 'starting'
        ? 18 + elapsed * 0.55
        : 42 + elapsed * 0.36;
    return Math.round(Math.min(92, Math.max(status.percent || 0, estimated)));
  }, [elapsed, status]);

  useEffect(() => {
    const startedAt = Date.now();
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 500);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!router.isReady) return;
    if (!project || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(project)) {
      setStatus({ phase: 'error', percent: 0, message: '工程 ID 无效' });
      return;
    }
    let cancelled = false;
    let pollTimer: number | undefined;

    const request = (method: 'GET' | 'POST') =>
      (method === 'POST'
        ? apiClient.postApiLocalProjectsIdRuntime({
            params: { path: { id: project } },
            body: { mode },
          })
        : apiClient.getApiLocalProjectsIdRuntime({
            params: { path: { id: project }, query: { mode } },
          })) as Promise<RuntimeStatus>;

    const poll = async () => {
      try {
        const next = await request('GET');
        if (cancelled) return;
        setStatus(next);
        if (next.phase === 'ready') {
          window.setTimeout(() => window.location.replace(mode === 'edit' ? next.editUrl! : next.playUrl!), 350);
          return;
        }
        if (next.phase === 'error') return;
        pollTimer = window.setTimeout(poll, 1000);
      } catch (error) {
        if (!cancelled) setStatus({
          phase: 'error',
          percent: 0,
          message: error instanceof Error ? error.message : '运行时启动失败',
        });
      }
    };

    request('POST')
      .then((next) => {
        if (cancelled) return;
        setStatus(next);
        pollTimer = window.setTimeout(poll, 500);
      })
      .catch((error) => {
        if (!cancelled) setStatus({
          phase: 'error',
          percent: 0,
          message: error instanceof Error ? error.message : '运行时启动失败',
        });
      });

    return () => {
      cancelled = true;
      if (pollTimer) window.clearTimeout(pollTimer);
    };
  }, [mode, project, router.isReady]);

  const failed = status.phase === 'error';
  const ready = status.phase === 'ready';
  const detail = failed
    ? `启动失败：${status.message}`
    : `${name} · ${ready ? '正在进入作品' : status.message}${!ready ? ` · ${elapsed}s` : ''}`;

  return (
    <ArenaBg
      progress={displayPercent}
      message={detail}
      error={failed}
      actions={failed ? <>
        <button type="button" onClick={() => window.location.reload()}>重新尝试</button>
        <button type="button" onClick={() => window.close()}>关闭</button>
      </> : undefined}
    />
  );
}
