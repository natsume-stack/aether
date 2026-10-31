import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

import { getLocalProjectManager } from './local-project-manager';

export type HealthState = 'healthy' | 'warning' | 'unhealthy' | 'disabled';

type ServiceHealth = {
  id: string;
  name: string;
  state: HealthState;
  configured: boolean;
  detail: string;
  latencyMs?: number;
  endpoint?: string;
  check: 'http' | 'tcp';
};

function safeError(error: unknown) {
  const code = typeof error === 'object' && error && 'code' in error
    ? String((error as { code?: unknown }).code || '')
    : '';
  return code || '连接失败';
}

async function probeTcp(host: string, port: number, timeoutMs = 1500) {
  const startedAt = Date.now();
  return new Promise<number>((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const finish = (error?: Error) => {
      socket.removeAllListeners();
      socket.destroy();
      if (error) reject(error);
      else resolve(Date.now() - startedAt);
    };
    socket.setTimeout(timeoutMs, () => finish(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    socket.once('connect', () => finish());
    socket.once('error', finish);
  });
}

async function tcpService(
  id: string,
  name: string,
  configured: boolean,
  host: string,
  port: number,
  disabledDetail: string,
): Promise<ServiceHealth> {
  if (!configured) return { id, name, configured: false, state: 'disabled', detail: disabledDetail, check: 'tcp' };
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    return { id, name, configured: true, state: 'unhealthy', detail: '配置无效', check: 'tcp' };
  }
  const endpoint = `${host}:${port}`;
  try {
    const latencyMs = await probeTcp(host, port);
    return { id, name, configured: true, state: 'healthy', detail: '端点可连接', latencyMs, endpoint, check: 'tcp' };
  } catch (error) {
    return { id, name, configured: true, state: 'unhealthy', detail: safeError(error), endpoint, check: 'tcp' };
  }
}

async function voxaHealth(): Promise<ServiceHealth> {
  const raw = process.env.VOXA_INTERNAL_URL || process.env.VOXA_URL || '';
  if (!raw) return { id: 'voxa', name: 'VOXA', configured: false, state: 'disabled', detail: '未配置', check: 'http' };
  try {
    const url = new URL('/api/health-check', raw.endsWith('/') ? raw : `${raw}/`);
    const startedAt = Date.now();
    const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) throw Object.assign(new Error('bad response'), { code: `HTTP_${response.status}` });
    return {
      id: 'voxa',
      name: 'VOXA',
      configured: true,
      state: 'healthy',
      detail: '服务正常',
      latencyMs: Date.now() - startedAt,
      endpoint: url.host,
      check: 'http',
    };
  } catch (error) {
    return { id: 'voxa', name: 'VOXA', configured: true, state: 'unhealthy', detail: safeError(error), check: 'http' };
  }
}

async function httpService(
  id: string,
  name: string,
  raw: string,
  pathname: string,
  disabledDetail: string,
): Promise<ServiceHealth> {
  if (!raw) return { id, name, configured: false, state: 'disabled', detail: disabledDetail, check: 'http' };
  try {
    const url = new URL(pathname, raw.endsWith('/') ? raw : `${raw}/`);
    const startedAt = Date.now();
    const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) throw Object.assign(new Error('bad response'), { code: `HTTP_${response.status}` });
    return {
      id,
      name,
      configured: true,
      state: 'healthy',
      detail: '服务正常',
      latencyMs: Date.now() - startedAt,
      endpoint: url.host,
      check: 'http',
    };
  } catch (error) {
    return { id, name, configured: true, state: 'unhealthy', detail: safeError(error), check: 'http' };
  }
}

function endpointFromUrl(value: string, defaultPort: number) {
  try {
    const parsed = new URL(value);
    return { host: parsed.hostname, port: Number(parsed.port || defaultPort), valid: true };
  } catch {
    return { host: '', port: 0, valid: false };
  }
}

export async function getServiceHealth() {
  const databaseUrl = process.env.BOX_DATABASE_URL || '';
  const database = endpointFromUrl(databaseUrl, 5432);
  const redisHost = process.env.REDIS_HOST || '';
  const services = await Promise.all([
    httpService(
      'player-service',
      '玩家服务',
      process.env.BOX_PLAYER_SERVICE_INTERNAL_URL || process.env.BOX_PLAYER_SERVICE_PUBLIC_URL || '',
      '/api/health-check',
      '未配置玩家服务地址',
    ),
    voxaHealth(),
    tcpService(
      'postgres',
      'PostgreSQL',
      Boolean(databaseUrl),
      database.host,
      database.port,
      '当前使用本地文件存储',
    ),
    tcpService('redis', 'Redis', Boolean(redisHost), redisHost, Number(process.env.REDIS_PORT || 6379), '未启用'),
  ]);
  const redis = services.find((service) => service.id === 'redis');
  if (redis?.state === 'healthy') {
    redis.detail = `端点可连接 · Session DB ${process.env.REDIS_DB || '0'} · 构建缓存 DB ${process.env.STORAGE_CACHE_REDIS_DB || '1'}`;
  }
  const postgres = services.find((service) => service.id === 'postgres');
  if (postgres?.state === 'healthy' && database.valid) {
    const databaseName = new URL(databaseUrl).pathname.replace(/^\//, '') || '默认数据库';
    postgres.detail = `端点可连接 · ${databaseName}`;
  }
  return services;
}

export async function getRuntimeStatus(projectId: string, mode: 'edit' | 'play') {
  const port = Number(mode === 'edit'
    ? process.env.BOX_EDIT_RUNTIME_PORT || process.env.BOX_EDIT_SERVER_PORT || 9967
    : process.env.BOX_PLAY_RUNTIME_PORT || process.env.BOX_SERVER_PORT || 9966);
  try {
    const startedAt = Date.now();
    const response = await fetch(
      `http://127.0.0.1:${port}/${encodeURIComponent(projectId)}/__local_runtime/status`,
      { signal: AbortSignal.timeout(1500) },
    );
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error('bad response'), { code: `HTTP_${response.status}` });
    return {
      mode,
      phase: typeof data.phase === 'string' ? data.phase : 'unknown',
      percent: Math.max(0, Math.min(100, Number(data.percent || 0))),
      message: typeof data.message === 'string' ? data.message : '',
      port: Number.isInteger(data.port) ? data.port : undefined,
      pid: Number.isInteger(data.pid) ? data.pid : undefined,
      startedAt: typeof data.startedAt === 'string' ? data.startedAt : '',
      updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : '',
      latencyMs: Date.now() - startedAt,
    };
  } catch (error) {
    return { mode, phase: 'unavailable', percent: 0, message: safeError(error), startedAt: '', updatedAt: '' };
  }
}

export async function getSystemStatus() {
  const manager = getLocalProjectManager();
  const projects = manager.listProjects();
  const mainProjects = projects.filter((project) => project.mapRole === 'main');
  const [services, runtimePairs] = await Promise.all([
    getServiceHealth(),
    Promise.all(projects.map(async (project) => ({
      projectId: project.id,
      projectName: project.name,
      edit: await getRuntimeStatus(project.id, 'edit'),
      play: await getRuntimeStatus(project.id, 'play'),
    }))),
  ]);
  const diskTarget = fs.existsSync(manager.projectsRoot) ? manager.projectsRoot : path.dirname(manager.projectsRoot);
  const stat = fs.statfsSync(diskTarget);
  const totalBytes = stat.blocks * stat.bsize;
  const freeBytes = stat.bavail * stat.bsize;
  const snapshots = projects.reduce((total, project) => {
    try { return total + manager.listProjectSnapshots(project.id).length; }
    catch { return total; }
  }, 0);
  const backups = mainProjects.reduce((total, project) => {
    try { return total + manager.listProjectBackups(project.id).length; }
    catch { return total; }
  }, 0);
  const latestBackups = mainProjects.flatMap((project) => {
    try {
      return manager.listProjectBackups(project.id).map((backup) => ({ ...backup, projectName: project.name }));
    } catch {
      return [];
    }
  }).sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || ''))).slice(0, 10);
  const diskState: HealthState = freeBytes < 1024 ** 3 || freeBytes / Math.max(totalBytes, 1) < 0.05
    ? 'warning'
    : 'healthy';
  const hasFailure = services.some((service) => service.configured && service.state === 'unhealthy');
  const backupStatus = manager.readBackupStatus();
  const memory = process.memoryUsage();
  const runtimeFailures = runtimePairs.flatMap((runtime) => [runtime.edit, runtime.play])
    .filter((runtime) => runtime.phase === 'error' || runtime.phase === 'unavailable');
  const diagnostics = [
    ...services
      .filter((service) => service.configured && service.state === 'unhealthy')
      .map((service) => ({ severity: 'error' as const, source: service.name, message: service.detail })),
    ...(diskState === 'warning'
      ? [{ severity: 'warning' as const, source: '工程磁盘', message: `剩余空间 ${Math.round(freeBytes / 1024 ** 2)} MB` }]
      : []),
    ...runtimePairs.flatMap((runtime) => ([
      { name: runtime.projectName, label: '编辑运行时', status: runtime.edit },
      { name: runtime.projectName, label: '游玩运行时', status: runtime.play },
    ]))
      .filter((item) => item.status.phase === 'error' || item.status.phase === 'unavailable')
      .map((item) => ({
        severity: 'error' as const,
        source: `${item.name} · ${item.label}`,
        message: item.status.message || '运行时不可用',
      })),
    ...backupStatus.failed.map((failure) => ({
      severity: 'warning' as const,
      source: `${failure.projectName || failure.projectId || '工程'} · 备份`,
      message: failure.message,
    })),
  ].slice(0, 30);
  return {
    status: hasFailure || runtimeFailures.length > 0 || diskState === 'warning' || backupStatus.state === 'warning' ? 'warning' : 'healthy',
    checkedAt: new Date().toISOString(),
    creator: {
      state: 'healthy' as const,
      detail: '创作端状态接口正常',
      version: process.env.BOX_IMAGE_TAG || '0.2.0',
      deploymentMode: process.env.BOX_DEPLOYMENT_MODE || 'local',
      nodeVersion: process.version,
      pid: process.pid,
      uptimeSeconds: Math.floor(process.uptime()),
      hostname: os.hostname(),
      memory: { rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, heapTotalBytes: memory.heapTotal },
      ports: {
        web: Number(process.env.BOX_WEB_PORT || process.env.PORT || 3000),
        edit: Number(process.env.BOX_EDIT_RUNTIME_PORT || process.env.BOX_EDIT_SERVER_PORT || 9967),
        play: Number(process.env.BOX_PLAY_RUNTIME_PORT || process.env.BOX_SERVER_PORT || 9966),
      },
    },
    services,
    disk: { state: diskState, totalBytes, freeBytes, projectsPath: manager.projectsRoot },
    projects: { count: projects.length, snapshots, backups, latestBackups, runtimes: runtimePairs },
    backup: { configuration: manager.getBackupConfiguration(), status: backupStatus },
    diagnostics,
  };
}
