import { authoringError, ContentDomain } from './authoring-session';

type Result = Record<string, any>;
type Invoke = (name: string, args: Result) => Promise<Result>;

type FillArgs = { region?: any; block?: any; [key: string]: any };

function normalizeSteps(raw: Result): Result[] {
  if (Array.isArray(raw?.steps)) return raw.steps.map((s: Result) => s?.args ?? s);
  if (raw?.step) return [raw.step?.args ?? raw.step];
  return [raw];
}

/**
 * Terrain as a first-class content domain so it can join a cross-domain plan.
 *
 * Thin adapter over the engine's own terrain tools (`terrainInfo`,
 * `terrainApply`, `terrainRevert`). It never re-implements voxel writes or CAS:
 * the authoritative optimistic lock is the `expectedRevision` handed to
 * `terrainApply`, and the inverse data is the `undoToken` it returns.
 *
 * Supports a single fill or a bounded multi-step fill (1–64 steps) so a
 * "platform + props" scenario is one reviewable member. Steps apply in order
 * with a rolling revision; a mid-sequence failure rolls back the steps already
 * applied within this domain and reports failure (the cross-domain plan layer
 * then compensates any earlier members).
 *
 * `revision()` is synchronous, so it returns the last revision observed during
 * prepare. That value is only used for cross-domain bookkeeping; a stale cache
 * cannot overwrite later edits because `terrainApply` re-checks the real CAS.
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
      const fills = normalizeSteps(raw);
      if (fills.length < 1 || fills.length > 64) {
        throw authoringError('INVALID_PROPOSAL', 'Terrain proposal supports 1–64 fill steps');
      }
      for (const f of fills) {
        if (!f || !f.region || f.block === undefined) {
          throw authoringError('INVALID_PROPOSAL', 'Each terrain step requires a region and block');
        }
      }
      const info = await invoke('terrainInfo', {});
      if (info.success === false || typeof info.revision !== 'string') {
        throw authoringError('STATE_UNAVAILABLE', 'Cannot read terrain revision');
      }
      if (raw?.expectedRevision !== undefined && raw.expectedRevision !== info.revision) {
        throw authoringError('REVISION_CONFLICT', 'Terrain changed after reading source content; regenerate proposal');
      }
      const previews: Result[] = [];
      let totalChanged = 0;
      let sawChange = false;
      for (const f of fills) {
        const preview = await invoke('terrainApply', {
          ...f,
          expectedRevision: info.revision,
          dryRun: true,
          allowWhileRunning: false,
        });
        if (preview.success === false || (preview.rejected ?? 0) > 0) {
          throw authoringError(preview.code || 'PROPOSAL_REFUSED', preview.error || 'Proposal includes unwritable cells');
        }
        const changed = preview.changed ?? 0;
        if (changed > 0) sawChange = true;
        totalChanged += changed;
        previews.push({ region: f.region, block: preview.block, changed, changedBounds: preview.changedBounds });
      }
      if (!sawChange) throw authoringError('NO_CHANGE', 'Proposal would not change any cell');
      cachedRevision = info.revision;
      return {
        baseRevision: info.revision,
        step: { fills: fills.map((f) => ({ ...f })) },
        preview: { kind: 'terrain', steps: previews, totalChanged },
        // Unknown until apply(); backfilled from the terrainApply undoToken stack.
        undoToken: '',
      };
    },
    async apply(step: Result, expectedRevision: string) {
      const fills: Result[] = step.fills || [];
      const tokens: string[] = [];
      let revision = expectedRevision;
      for (const f of fills) {
        const res = await invoke('terrainApply', {
          ...f,
          expectedRevision: revision,
          dryRun: false,
          allowWhileRunning: false,
        });
        if (res.success === false || (res.rejected ?? 0) > 0) {
          // Roll back this domain's already-applied steps so the caller sees a
          // clean failure and the plan layer need not undo a half member.
          for (const t of [...tokens].reverse()) {
            try { const r = await invoke('terrainRevert', { undoToken: t, expectedRevision: revision }); if (r.newRevision) revision = r.newRevision; } catch { /* best effort */ }
          }
          return { success: false, code: res.code || 'TERRAIN_APPLY_FAILED', error: res.error, mutationStarted: tokens.length > 0 };
        }
        if (typeof res.newRevision !== 'string' || !res.newRevision) {
          return { success: false, code: 'TERRAIN_NO_REVISION', mutationStarted: true, error: 'terrainApply omitted newRevision' };
        }
        if (typeof res.undoToken === 'string' && res.undoToken && res.undoToken !== '[]') tokens.push(res.undoToken);
        revision = res.newRevision;
      }
      cachedRevision = revision;
      return { success: true, newRevision: revision, undoToken: JSON.stringify(tokens) };
    },
    async revert(undoToken: string, expectedRevision: string) {
      if (!undoToken || undoToken === '[]') throw authoringError('INVALID_UNDO_TOKEN', 'Terrain proposal has no inverse data');
      const tokens: string[] = JSON.parse(undoToken);
      if (!Array.isArray(tokens) || tokens.length === 0) throw authoringError('INVALID_UNDO_TOKEN', 'Terrain inverse list is empty');
      let revision = expectedRevision;
      for (const t of [...tokens].reverse()) {
        const res = await invoke('terrainRevert', { undoToken: t, expectedRevision: revision });
        if (res.success === false) {
          return { success: false, code: res.code || 'TERRAIN_REVERT_FAILED', error: res.error, mutationStarted: true };
        }
        if (typeof res.newRevision === 'string' && res.newRevision) revision = res.newRevision;
      }
      cachedRevision = revision;
      return { success: true, newRevision: revision };
    },
  };
}
