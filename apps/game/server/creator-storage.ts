import { PostgresDataStorage } from '../../../services/game-server/src/storage/postgres-data-storage';
import type { TableType } from '../../../services/game-server/src/storage/types';
import { Logger } from '@box/utils/logger';
import { getLocalProjectManager } from './local-project-manager';

export type CreatorStorageScope = TableType;

const storageLogger = new Logger(() => undefined, ['creator-storage'], 'creator-storage');

function databaseConfig() {
  const connectionString = String(process.env.BOX_DATABASE_URL || '').trim();
  if (!connectionString) {
    throw new Error('数据空间不可用：Creator 未配置 BOX_DATABASE_URL');
  }
  return {
    connectionString,
    schema: String(process.env.BOX_DATABASE_SCHEMA || 'box_engine').trim(),
    poolSize: 1,
    ssl: process.env.BOX_DATABASE_SSL === 'true',
    sslRejectUnauthorized:
      process.env.BOX_DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false',
    lockTimeoutMs: Math.max(
      1000,
      Number(process.env.BOX_DATA_STORAGE_LOCK_TIMEOUT_MS) || 10_000
    ),
  };
}

/**
 * Runs an operator request through the same PostgreSQL storage adapter that
 * map scripts use. The Creator process deliberately creates a short-lived
 * adapter: it keeps this administrative path isolated from map runtime pools.
 */
export async function withCreatorStorage<T>(
  projectId: string,
  operation: (storage: PostgresDataStorage) => Promise<T>
) {
  const identity = getLocalProjectManager().projectStorageIdentity(projectId);
  const config = databaseConfig();
  const storage = new PostgresDataStorage({
    ...config,
    projectNamespace: identity.permanentMapId,
    groupNamespace: identity.permanentMapGroupId,
    // Creator preview is an edit runtime, so its script storage uses edit mode.
    mode: 'edit',
    logger: storageLogger,
  });
  try {
    await storage.connect();
    return await operation(storage);
  } finally {
    await storage.close().catch(() => undefined);
  }
}
