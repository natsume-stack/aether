import type { ToolSet } from 'ai';

export type ExecutionMode = 'review' | 'autonomous';
const READ_TOOLS = new Set([
  'terrainInfo', 'terrainRead', 'uiTreeRead', 'uiContext', 'listEntities', 'entityContext',
  'getProjectModels', 'searchPublicModels', 'blockCatalog', 'getBlock', 'resolvePalette',
  'searchBlocks', 'listScripts', 'readScript', 'scriptPreview', 'scriptCheck',
  'authoringContext', 'authoringEvents', 'authoringHistory', 'authoringOperation',
  'authoringProposal', 'authoringProposals', 'authoringPlan', 'authoringPlans',
]);
const PROPOSE_TOOLS = new Set([
  'authoringPropose', 'authoringProposeScript', 'authoringProposeEntities',
  'authoringProposeEntityLifecycle', 'authoringProposeUi', 'authoringProposeTerrain',
  'authoringProposePlan', 'authoringDiscard', 'authoringDiscardPlan',
]);
const WRITE_TOOLS = new Set(['authoringApply', 'authoringApplyPlan', 'authoringRevert', 'authoringRevertPlan']);

export interface ExecutionPolicy {
  mode: ExecutionMode;
  signal: AbortSignal;
  maxCalls: number;
  authorizeWrite: () => Promise<void>;
  save: () => Promise<string>;
  audit: (event: Record<string, unknown>) => void;
}

/** A request owns its policy and counters; no mutable mode is shared between sessions. */
export function executionTools(source: ToolSet, policy: ExecutionPolicy): ToolSet {
  let calls = 0;
  let writeQueue: Promise<unknown> = Promise.resolve();
  let uncertain = false;
  return Object.fromEntries(Object.entries(source).filter(([name]) =>
    READ_TOOLS.has(name) || PROPOSE_TOOLS.has(name) || (policy.mode === 'autonomous' && WRITE_TOOLS.has(name)),
  ).map(([name, definition]) => [name, {
    ...definition,
    execute: async (args: unknown, options: any) => {
      if (policy.signal.aborted) throw new Error('AI execution cancelled');
      if (++calls > policy.maxCalls) throw new Error('AI tool budget exceeded');
      if (!definition.execute) throw new Error('AI tool is unavailable');
      const execute = definition.execute as (args: unknown, options: any) => Promise<any>;
      if (!WRITE_TOOLS.has(name)) return execute(args, options);
      const pending = writeQueue.then(async () => {
        if (uncertain) throw new Error('Inspect the previous failed write before continuing');
        if (policy.signal.aborted) throw new Error('AI execution cancelled');
        await policy.authorizeWrite();
        const before = await policy.save();
        policy.audit({ action: name, phase: 'before', snapshot: before });
        let result: any;
        try {
          result = await execute(args, options);
          const after = await policy.save();
          policy.audit({ action: name, phase: 'after', snapshot: after, success: result?.success !== false });
          if (result?.success === false) uncertain = true;
          return { ...result, persisted: true, snapshotBefore: before, snapshotAfter: after };
        } catch (error) {
          uncertain = true;
          policy.audit({ action: name, phase: 'unknown' });
          throw new Error('AI write or save failed; inspect map content before another execution');
        }
      });
      writeQueue = pending.catch(() => undefined);
      return pending;
    },
  }]));
}
