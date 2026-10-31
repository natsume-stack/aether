import fs from 'fs';
import path from 'path';

import { getVoxaDataRoot } from './local-voxa-store';

/**
 * An edit lock is intentionally short lived. External agents renew it while
 * they are driving the editor and the editor UI treats any other holder as a
 * busy model, so a crashed CLI cannot lock a model forever.
 */
export type EditLockRecord = {
  actor: string;
  acquiredAt: string;
  expiresAt: string;
};

export type EditLockState = {
  locked: boolean;
  actor: string | null;
  acquiredAt: string | null;
  expiresAt: string | null;
};

export const DEFAULT_EDIT_LOCK_TTL_MS = 120_000;
export const MIN_EDIT_LOCK_TTL_MS = 1_000;
export const MAX_EDIT_LOCK_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_EDIT_LOCK_ACTOR_LENGTH = 120;

const LOCK_FILE_NAME = 'edit-locks.json';

/**
 * Locks live in memory for low latency and are mirrored to the VOXA data
 * directory so a `next dev` restart does not silently unlock a model.
 */
let locks: Record<string, EditLockRecord> | undefined;

function persistenceEnabled() {
  return process.env.VOXA_EDIT_LOCK_PERSIST !== '0';
}

function lockFilePath() {
  return path.join(getVoxaDataRoot(), LOCK_FILE_NAME);
}

function isExpired(record: EditLockRecord, now: number) {
  const expiresAt = Date.parse(record.expiresAt);
  return !Number.isFinite(expiresAt) || expiresAt <= now;
}

function unlockedState(): EditLockState {
  return {
    locked: false,
    actor: null,
    acquiredAt: null,
    expiresAt: null,
  };
}

function toState(record: EditLockRecord | null): EditLockState {
  if (!record) return unlockedState();
  return {
    locked: true,
    actor: record.actor,
    acquiredAt: record.acquiredAt,
    expiresAt: record.expiresAt,
  };
}

function loadLocks() {
  if (locks) return locks;
  locks = {};
  if (!persistenceEnabled()) return locks;

  try {
    const parsed = JSON.parse(fs.readFileSync(lockFilePath(), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return locks;
    }
    for (const [modelId, value] of Object.entries(parsed as Record<string, unknown>)) {
      const record = value as Partial<EditLockRecord> | null;
      if (!record || typeof record.actor !== 'string' || !record.actor) continue;
      const acquiredAt = Date.parse(String(record.acquiredAt || ''));
      const expiresAt = Date.parse(String(record.expiresAt || ''));
      if (!Number.isFinite(acquiredAt) || !Number.isFinite(expiresAt)) continue;
      locks[modelId] = {
        actor: record.actor.slice(0, MAX_EDIT_LOCK_ACTOR_LENGTH),
        acquiredAt: new Date(acquiredAt).toISOString(),
        expiresAt: new Date(expiresAt).toISOString(),
      };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      console.error('Failed to read VOXA edit locks', error);
    }
  }
  return locks;
}

function persistLocks() {
  if (!persistenceEnabled()) return;
  try {
    const target = lockFilePath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(locks || {}, null, 2)}\n`);
    fs.renameSync(temporary, target);
  } catch (error) {
    // Losing the disk mirror must not take the editor down; the in-memory
    // lock still protects writes for the lifetime of this process.
    console.error('Failed to persist VOXA edit locks', error);
  }
}

function activeRecord(modelId: number) {
  const store = loadLocks();
  const key = String(modelId);
  const record = store[key];
  if (!record) return null;
  if (isExpired(record, Date.now())) {
    delete store[key];
    persistLocks();
    return null;
  }
  return record;
}

export function normalizeEditLockActor(value: unknown) {
  if (Array.isArray(value)) return normalizeEditLockActor(value[0]);
  return String(value || '').trim().slice(0, MAX_EDIT_LOCK_ACTOR_LENGTH);
}

export function normalizeEditLockTtl(value: unknown) {
  const ttl = Number(value);
  if (!Number.isFinite(ttl) || ttl <= 0) return DEFAULT_EDIT_LOCK_TTL_MS;
  return Math.min(MAX_EDIT_LOCK_TTL_MS, Math.max(MIN_EDIT_LOCK_TTL_MS, Math.round(ttl)));
}

export function getEditLock(modelId: number): EditLockState {
  return toState(activeRecord(modelId));
}

export function acquireEditLock(modelId: number, actor: string, ttlMs?: number) {
  const current = activeRecord(modelId);
  if (current && current.actor !== actor) {
    return {
      acquired: false as const,
      conflict: true as const,
      lock: toState(current),
    };
  }

  const now = new Date();
  const record: EditLockRecord = {
    actor,
    // Renewal by the same actor keeps the original acquisition time, which
    // makes it obvious how long a CLI session has owned the model.
    acquiredAt: current ? current.acquiredAt : now.toISOString(),
    expiresAt: new Date(now.getTime() + normalizeEditLockTtl(ttlMs)).toISOString(),
  };
  loadLocks()[String(modelId)] = record;
  persistLocks();
  return {
    acquired: true as const,
    conflict: false as const,
    lock: toState(record),
  };
}

export function releaseEditLock(modelId: number, actor: string) {
  const current = activeRecord(modelId);
  if (!current) {
    return {
      released: true as const,
      conflict: false as const,
      lock: unlockedState(),
    };
  }
  if (current.actor !== actor) {
    return {
      released: false as const,
      conflict: true as const,
      lock: toState(current),
    };
  }

  delete loadLocks()[String(modelId)];
  persistLocks();
  return {
    released: true as const,
    conflict: false as const,
    lock: unlockedState(),
  };
}

/**
 * Removes any lock for a model that no longer exists.
 */
export function clearEditLock(modelId: number) {
  const store = loadLocks();
  const key = String(modelId);
  if (!store[key]) return;
  delete store[key];
  persistLocks();
}

/**
 * Returns the current lock when a write by `actor` must be rejected.
 * A missing actor never matches an existing lock, so legacy callers that do
 * not participate in locking are rejected while a CLI owns the model.
 */
export function getEditLockConflict(modelId: number, actor?: string) {
  const state = getEditLock(modelId);
  if (!state.locked) return null;
  return state.actor === normalizeEditLockActor(actor) ? null : state;
}
