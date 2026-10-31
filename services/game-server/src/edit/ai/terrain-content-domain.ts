import { authoringError, ContentDomain } from './authoring-session';

type Result = Record<string, any>;
type Invoke = (name: string, args: Result) => Promise<Result>;

/**
 * Terrain as a first-class content domain so it can join a cross-domain plan.
 *
 * This is a thin adapter over the engine's own terrain tools (`terrainInfo`,
 * `terrainApply`, `terrainRevert`). It never re-implements voxel writes or the
 * CAS logic: real conflict detection and the inverse data both stay in
 * `terrainApply`. Two consequences follow:
 *
 *  - `revision()` must be synchronous, so it returns the last revision observed
 *    during `prepare`. That value is only used for cross-domain bookkeeping; the
 *    authoritative optimistic lock is the `expectedRevision` handed to
 *    `terrainApply`, so a stale cache cannot silently overwrite later edits.
 *  - The inverse is only known after the write. `apply()` therefore returns the
 *    `undoToken` produced by `terrainApply`, and the session backfills it into the
 *    proposal (see AuthoringSession.runContent) before `revert()` is called.
 *
 * One proposal == one region fill. Multi-step terrain stays on the legacy
 * `authoringPropose` path (which keeps its own ordered undo stack).
 */
export function createTerrainContentDomain(invoke: Invoke): ContentDomain {
  let cachedRevision: string | undefined;
  return {
    revision(): string {
      if (!cachedRevision) {
        throw authoringError('STATE_UNAVAILABLE', 'Terrain revision not initialized; propose first');
      }
      return cachedRevision;
    },
    async prepare(raw: Result) {
      const step = raw?.step ?? raw;
      const applyArgs: Result = step?.args ?? step;
      if (!applyArgs || !applyArgs.region || applyArgs.block === undefined) {
        throw authoringError('INVALID_PROPOSAL', 'Terrain proposal requires a region and block');
      }
      const info = await invoke('terrainInfo', {});
      if (info.success === false || typeof info.revision !== 'string') {
        throw authoringError('STATE_UNAVAILABLE', 'Cannot read terrain revision');
      }
      if (raw?.expectedRevision !== undefined && raw.expectedRevision !== info.revision) {
        throw authoringError('REVISION_CONFLICT', 'Terrain changed after reading source content; regenerate proposal');
      }
      const preview = await invoke('terrainApply', {
        ...applyArgs,
        expectedRevision: info.revision,
        dryRun: true,
        allowWhileRunning: false,
      });
      if (preview.success === false || (preview.rejected ?? 0) > 0) {
        throw authoringError(preview.code || 'PROPOSAL_REFUSED', preview.error || 'Proposal includes unwritable cells');
      }
      cachedRevision = info.revision;
      return {
        baseRevision: info.revision,
        step: { args: { ...applyArgs }, region: applyArgs.region, block: preview.block },
        preview: {
          kind: 'terrain',
          region: applyArgs.region,
          block: preview.block,
          changed: preview.changed,
          changedBounds: preview.changedBounds,
        },
        // Unknown until apply(); filled in from terrainApply's undoToken.
        undoToken: '',
      };
    },
    async apply(step: Result, expectedRevision: string) {
      const res = await invoke('terrainApply', {
        ...step.args,
        expectedRevision,
        dryRun: false,
        allowWhileRunning: false,
      });
      if (res.success === false || (res.rejected ?? 0) > 0) {
        return {
          success: false,
          code: res.code || 'TERRAIN_APPLY_FAILED',
          error: res.error,
          mutationStarted: !!res.mutationStarted,
        };
      }
      if (typeof res.newRevision !== 'string' || !res.newRevision) {
        return { success: false, code: 'TERRAIN_NO_REVISION', mutationStarted: true, error: 'terrainApply omitted newRevision' };
      }
      cachedRevision = res.newRevision;
      return { success: true, newRevision: res.newRevision, undoToken: res.undoToken };
    },
    async revert(undoToken: string, expectedRevision: string) {
      if (!undoToken || undoToken === '[]') {
        throw authoringError('INVALID_UNDO_TOKEN', 'Terrain proposal has no inverse data');
      }
      const res = await invoke('terrainRevert', { undoToken, expectedRevision });
      if (res.success === false) {
        return { success: false, code: res.code || 'TERRAIN_REVERT_FAILED', error: res.error, mutationStarted: !!res.mutationStarted };
      }
      if (typeof res.newRevision === 'string' && res.newRevision) cachedRevision = res.newRevision;
      return { success: true, newRevision: res.newRevision };
    },
  };
}
