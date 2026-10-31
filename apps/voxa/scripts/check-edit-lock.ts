import assert from 'node:assert/strict';

import {
  acquireEditLock,
  fetchEditLock,
  releaseEditLock,
  type EditLockInfo,
} from '../src/utils/edit-lock';
import {
  startEditSession,
  type ModelRevisionEvent,
} from '../src/utils/edit-session';

/**
 * End-to-end check for the CLI/agent model write lane:
 * acquire -> 409 for a second actor -> locked PUT -> revision bump -> SSE
 * reload in the editor session -> release / retry.
 *
 * Requires a running VOXA dev server plus the shared internal token:
 *   PERMISSION_TOKEN_SECRET=local-dev-secret-2026 \
 *   node -r ts-node/register scripts/check-edit-lock.ts
 */

const baseUrl = process.env.VOXA_CHECK_URL || 'http://127.0.0.1:3001';
const modelId = Number(process.env.VOXA_CHECK_MODEL_ID || 1);
const actorA = 'cli:check-a';
const actorB = 'cli:check-b';
const secret = process.env.PERMISSION_TOKEN_SECRET || 'local-dev-secret-2026';
const headers = { Authorization: `Bearer ${secret}` };

type ModelDetail = {
  projectFileHash: string;
  modelFileHash: string;
  modelPreviewHash?: string;
  revision?: number;
  lastEditActor?: string;
};

async function modelDetail(): Promise<ModelDetail> {
  const response = await fetch(`${baseUrl}/api/local/models/${modelId}`, {
    headers,
    cache: 'no-store',
  });
  assert.equal(response.status, 200, 'model lookup must succeed');
  return await response.json() as ModelDetail;
}

async function putModel(actor: string, detail: ModelDetail) {
  return await fetch(`${baseUrl}/api/local/models/${modelId}/model`, {
    method: 'PUT',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      actor,
      projectBlobHash: detail.projectFileHash,
      metaBlobHash: detail.modelFileHash,
      previewBlobHash: detail.modelPreviewHash,
    }),
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs: number) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await sleep(100);
  }
  return predicate();
}

async function main() {
let session: ReturnType<typeof startEditSession> | undefined;

try {
  await releaseEditLock(modelId, actorA, { baseUrl, headers });
  await releaseEditLock(modelId, actorB, { baseUrl, headers });

  const initial = await fetchEditLock(modelId, undefined, baseUrl, headers);
  assert.equal(initial.locked, false, 'model must start unlocked');

  const acquiredA = await acquireEditLock(modelId, actorA, {
    ttlMs: 30_000,
    baseUrl,
    headers,
  });
  assert.equal(acquiredA.acquired, true, 'actor A must acquire the lock');
  assert.equal(acquiredA.lock.actor, actorA);

  const acquiredB = await acquireEditLock(modelId, actorB, {
    ttlMs: 30_000,
    baseUrl,
    headers,
  });
  assert.equal(acquiredB.acquired, false, 'actor B must be rejected');
  assert.equal(acquiredB.lock.actor, actorA, '409 must name the lock owner');

  const beforeWrite = await modelDetail();
  const rejected = await putModel(actorB, beforeWrite);
  assert.equal(rejected.status, 409, 'PUT from a non-owner must be 409');
  const rejectedBody = await rejected.json() as { code?: string };
  assert.equal(rejectedBody.code, 'EDIT_LOCKED');

  let reloads = 0;
  let reloadEvent: ModelRevisionEvent | undefined;
  let sawConflict = false;
  let lockSeen: EditLockInfo | undefined;
  let acquiredByRetry = false;

  session = startEditSession({
    modelId,
    actor: actorB,
    ttlMs: 10_000,
    baseUrl,
    headers,
    reload: () => {
      reloads += 1;
    },
    onLock: (lock) => {
      lockSeen = lock;
      if (lock.actor === actorB) acquiredByRetry = true;
    },
    onConflict: () => {
      sawConflict = true;
    },
    onReloaded: (event) => {
      reloadEvent = event;
    },
  });

  assert.equal(
    await waitFor(() => sawConflict && Boolean(lockSeen), 5_000),
    true,
    'observer session must report the conflicting owner',
  );

  const accepted = await putModel(actorA, beforeWrite);
  assert.equal(accepted.status, 200, 'owner PUT must succeed');
  const acceptedBody = await accepted.json() as ModelDetail;
  assert.equal(acceptedBody.revision, (beforeWrite.revision || 0) + 1);
  assert.equal(acceptedBody.lastEditActor, actorA);

  assert.equal(
    await waitFor(() => reloads === 1 && Boolean(reloadEvent), 6_000),
    true,
    'editor session must reload once after an external revision',
  );
  assert.equal(reloadEvent?.actor, actorA);
  assert.equal(reloadEvent?.revision, acceptedBody.revision);

  const releasedA = await releaseEditLock(modelId, actorA, {
    baseUrl,
    headers,
  });
  assert.equal(releasedA.acquired, true, 'owner release must succeed');

  assert.equal(
    await waitFor(() => acquiredByRetry && lockSeen?.actor === actorB, 9_000),
    true,
    'observer session must acquire the lock after the owner releases',
  );

  await session.close();
  const afterClose = await fetchEditLock(modelId, undefined, baseUrl, headers);
  assert.equal(afterClose.locked, false, 'closing the session releases its lock');

  const final = await modelDetail();
  assert.equal(final.lastEditActor, actorA);

  console.log(JSON.stringify({
    ok: true,
    modelId,
    revision: final.revision,
    lastEditActor: final.lastEditActor,
    reloads,
    reloadActor: reloadEvent?.actor,
    conflictObserved: sawConflict,
    retryAcquired: acquiredByRetry,
    finalLock: afterClose,
  }, null, 2));
} finally {
  session?.close().catch(() => undefined);
  await releaseEditLock(modelId, actorA, { baseUrl, headers }).catch(() => undefined);
  await releaseEditLock(modelId, actorB, { baseUrl, headers }).catch(() => undefined);
}

}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
