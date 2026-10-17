import fs from 'fs';
import os from 'os';
import path from 'path';

import { getPlayWorlds } from './play-worlds';
import { getRuntimeStatus, getServiceHealth, type HealthState } from './system-status';

export async function getPlaySystemStatus() {
  const worlds = getPlayWorlds();
  const [services, runtimes] = await Promise.all([
    getServiceHealth(),
    Promise.all(worlds.map(async (world) => ({
      worldId: world.id,
      publicId: world.publicId,
      worldName: world.name,
      mapRole: world.mapRole,
      status: await getRuntimeStatus(world.id, 'play'),
    }))),
  ]);
  const libraryPath = process.env.BOX_PLAY_LIBRARY_PATH || process.cwd();
  const diskTarget = fs.existsSync(libraryPath) ? libraryPath : path.dirname(libraryPath);
  const stat = fs.statfsSync(diskTarget);
  const totalBytes = stat.blocks * stat.bsize;
  const freeBytes = stat.bavail * stat.bsize;
  const diskState: HealthState = freeBytes < 1024 ** 3 || freeBytes / Math.max(totalBytes, 1) < 0.05
    ? 'warning'
    : 'healthy';
  const runtimeFailures = runtimes.filter(({ status }) => status.phase === 'error' || status.phase === 'unavailable');
  const serviceFailures = services.filter((service) => service.configured && service.state === 'unhealthy');
  const groups = new Set(worlds.map((world) => world.mapGroupId || world.mainProjectId || world.id));
  const memory = process.memoryUsage();
  const diagnostics = [
    ...serviceFailures.map((service) => ({
      severity: 'error' as const,
      source: service.name,
      message: service.detail,
    })),
    ...(diskState === 'warning' ? [{
      severity: 'warning' as const,
      source: '游玩包磁盘',
      message: `剩余空间 ${Math.round(freeBytes / 1024 ** 2)} MB`,
    }] : []),
    ...runtimeFailures.map((runtime) => ({
      severity: 'error' as const,
      source: `${runtime.worldName} · 游玩运行时`,
      message: runtime.status.message || '运行时不可用',
    })),
  ].slice(0, 30);

  return {
    status: diagnostics.length ? 'warning' as const : 'healthy' as const,
    checkedAt: new Date().toISOString(),
    host: {
      detail: '游玩端管理服务正常',
      version: process.env.BOX_IMAGE_TAG || '0.2.0',
      nodeVersion: process.version,
      pid: process.pid,
      uptimeSeconds: Math.floor(process.uptime()),
      hostname: os.hostname(),
      memory: { rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, heapTotalBytes: memory.heapTotal },
      ports: {
        web: Number(process.env.BOX_WEB_PORT || process.env.PORT || 3000),
        runtime: Number(process.env.BOX_PLAY_RUNTIME_PORT || process.env.BOX_SERVER_PORT || 9966),
      },
    },
    services,
    disk: { state: diskState, totalBytes, freeBytes, libraryPath },
    worlds: { count: worlds.length, groupCount: groups.size, runtimes },
    diagnostics,
  };
}
