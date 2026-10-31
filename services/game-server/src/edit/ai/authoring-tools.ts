import { tool } from 'ai';
import { z } from 'zod';
import { AuthoringSession, authoringError, ContentDomain } from './authoring-session';
import { entityPatchSchema } from './entity-content-domain';
import { entityLifecycleSchema } from './entity-lifecycle-domain';
import { uiPatchSchema } from './ui-content-domain';
import { readContentOverview } from './content-overview';
import { createTerrainContentDomain } from './terrain-content-domain';

const sessions = new WeakMap<object, { session: AuthoringSession; raw: Record<string, any> }>();
const domains = new WeakMap<object, Map<string, ContentDomain>>();
export function registerAuthoringDomain(state: object, name: string, domain: ContentDomain) {
  if (!domains.has(state)) domains.set(state, new Map());
  domains.get(state)!.set(name, domain);
  sessions.get(state)?.session.registerDomain(name, domain);
}

/** The runtime's one coordinator, once any front door has built its tools. */
export function authoringSessionFor(state: object): AuthoringSession | undefined {
  return sessions.get(state)?.session;
}
const readers = new Set(['terrainInfo', 'terrainRead', 'uiTreeRead', 'uiContext', 'listEntities', 'entityContext', 'getProjectModels', 'searchPublicModels', 'blockCatalog', 'getBlock', 'resolvePalette', 'searchBlocks', 'listScripts', 'readScript', 'scriptPreview', 'scriptCheck']);

/** All front doors share one session per authoritative EditServerState. */
export function coordinateAuthoring<T extends Record<string, any>>(state: object, tools: T) {
  let entry = sessions.get(state);
  if (!entry) {
    const raw: Record<string, any> = {};
    const invoke = async (name: string, args: Record<string, any>) => {
      const definition = raw[name];
      if (!definition?.execute) throw authoringError('UNKNOWN_TOOL', `Unknown tool ${name}`);
      const parsed = definition.inputSchema.safeParse(args);
      if (!parsed.success) throw authoringError('TOOL_ARGS_INVALID', parsed.error.message);
      return definition.execute(parsed.data, { toolCallId: 'authoring-internal', messages: [] });
    };
    const session = new AuthoringSession(invoke);
    session.registerDomain('terrain', createTerrainContentDomain(invoke));
    Object.assign(raw, {
      authoringApply: { inputSchema: z.object({ proposalId: z.string() }), execute: ({ proposalId }: any) => session.applyProposal(proposalId) },
      authoringRevert: { inputSchema: z.object({ proposalId: z.string() }), execute: ({ proposalId }: any) => session.revertProposal(proposalId) },
      authoringDiscard: { inputSchema: z.object({ proposalId: z.string() }), execute: ({ proposalId }: any) => session.discardProposal(proposalId) },
      authoringApplyPlan: { inputSchema: z.object({ planId: z.string() }), execute: ({ planId }: any) => session.applyPlan(planId) },
      authoringRevertPlan: { inputSchema: z.object({ planId: z.string() }), execute: ({ planId }: any) => session.revertPlan(planId) },
      authoringDiscardPlan: { inputSchema: z.object({ planId: z.string() }), execute: ({ planId }: any) => session.discardPlan(planId) },
    });
    entry = { session, raw };
    sessions.set(state, entry);
  }
  Object.assign(entry.raw, tools);
  const { session } = entry;
  for (const [name, domain] of domains.get(state) || []) session.registerDomain(name, domain);
  const coordinated = Object.fromEntries(Object.entries(tools).map(([name, definition]) => [name, readers.has(name) ? definition : {
    ...definition,
    execute: (args: any, options: any) => session.perform(name, args, options?.toolCallId),
  }]));
  return {
    ...(coordinated as T),
    authoringContext: tool({ description: 'Read task-sized live content overview. No camera, terrain sampling or screenshot required. Script bodies and regions are fetched separately.', inputSchema: z.object({}), execute: async () => {
      const info = await entry!.raw.terrainInfo.execute({}, { toolCallId: 'context', messages: [] });
      if (info.success === false) throw authoringError('STATE_UNAVAILABLE', 'Cannot read live terrain context');
      const files = await entry!.raw.listScripts.execute({}, { toolCallId: 'context', messages: [] });
      const overview = readContentOverview(state as any);
      return { format: 'box3-map-context/1', live: true, runtimeId: session.runtimeId, terrain: info,
        scripts: files.scripts, ...overview, contentRevisions: { terrain: info.revision, ...overview.contentRevisions },
        selectionSource: 'editor bridge; not present in server content snapshot' };
    } }),
    authoringEvents: tool({ description: 'Read bounded runtime authoring events since sequence; runtimeId changes after restart. No credentials or script bodies included.', inputSchema: z.object({ after: z.number().int().min(0).default(0) }), execute: async ({ after }) => session.events(after) }),
    authoringHistory: tool({ description: 'Read durable authoring event history across runtime restarts. Historical completion does not prove unsaved content survived restart.', inputSchema: z.object({ limit: z.number().int().min(1).max(1000).default(100) }), execute: async ({ limit }) => session.journalHistory(limit) }),
    authoringOperation: tool({ description: 'Query an operation receipt in this runtime. Never blindly replay an ambiguous write after runtime restart.', inputSchema: z.object({ operationId: z.string() }), execute: async ({ operationId }) => session.operation(operationId) }),
    authoringProposal: tool({ description: 'Query proposal lifecycle and remaining rollback steps without exposing undo payloads.', inputSchema: z.object({ proposalId: z.string() }), execute: async ({ proposalId }) => session.proposal(proposalId) }),
    authoringProposals: tool({ description: 'List runtime-scoped terrain and script proposals and their review summaries. No undo tokens returned.', inputSchema: z.object({}), execute: async () => session.proposalList() }),
    authoringPropose: tool({ description: 'Dry-run 1–64 local terrain fills. Supply expectedRevision when derived from a prior content read. Rejects unwritable cells. Does not modify or save the map.', inputSchema: z.object({ expectedRevision: z.string().optional(), steps: z.array(z.object({ tool: z.literal('terrainApply'), args: z.record(z.string(), z.unknown()) })).min(1).max(64) }), execute: async ({ steps, expectedRevision }) => session.propose(steps, expectedRevision) }),
    authoringProposeScript: tool({ description: 'Prepare a version-bound script proposal with isolated type/UI binding checks and durable inverse data. Does not apply or save.',
      inputSchema: z.object({ fileId: z.string(), expectedRevision: z.string(), policy: z.enum(['strict', 'no-new-errors']).default('strict'), edits: z.array(z.object({ index: z.number().int().min(0), deleteCount: z.number().int().min(0), text: z.string().max(500000) })).min(1).max(64) }),
      execute: async args => session.proposeContent('script', args) }),
    authoringProposeEntities: tool({ description: 'Prepare bounded property edits to existing entity IDs with entity/asset CAS, edit-lock protection, exact diff and inverse. Does not add/delete/reparent entities or save.',
      inputSchema: entityPatchSchema, execute: async args => session.proposeContent('entities', args) }),
    authoringProposeEntityLifecycle: tool({ description: 'Prepare entity creation, leaf copying (full value incl. mesh, optional position offset), leaf deletion or reparenting with full-node inverse and entity/asset CAS. Refuses subtree copies, locked entities and unknown models. Does not save.',
      inputSchema: entityLifecycleSchema, execute: async args => session.proposeContent('entityLifecycle', args) }),
    authoringProposeUi: tool({description:'Prepare existing UI element property edits with authoritative revision, exact schema simulation and durable inverse. Preserves binding names, IDs, kinds, hierarchy and scripts. Does not create/delete/rename nodes or prove visual correctness.',
      inputSchema:uiPatchSchema,execute:async args=>session.proposeContent('ui',args)}),
    authoringProposeTerrain: tool({ description: 'Prepare 1-64 terrain region fills as one plan-capable content proposal with optimistic revision. Applies in order with rolling revision. Does not modify or save the map.',
      inputSchema: z.object({ expectedRevision: z.string().optional(),
        step: z.object({ args: z.record(z.string(), z.unknown()) }).optional(),
        steps: z.array(z.object({ args: z.record(z.string(), z.unknown()) })).min(1).max(64).optional(),
      }).refine((v: any) => Boolean(v.step) !== Boolean(v.steps), 'Provide either step or steps'),
      execute: async args => session.proposeContent('terrain', args) }),
    authoringApply: tool({ description: 'Apply a terrain or checked script proposal with domain revision checks. Inverse stays on the server; save separately. Not an atomic multi-domain transaction.', inputSchema: z.object({ proposalId: z.string() }), execute: async (args, options) => session.perform('authoringApply', args, options?.toolCallId) }),
    authoringDiscard: tool({ description: 'Discard an unapplied or expired draft without changing map content. Preserves review/history; applied, partial or unknown proposals must be inspected or reverted instead. Does not release proposal capacity.', inputSchema: z.object({ proposalId: z.string() }), execute: async (args, options) => session.perform('authoringDiscard', args, options?.toolCallId) }),
    authoringRevert: tool({ description: 'Revert a terrain or script proposal only if its domain revision still matches. Refuses to erase later human edits. Save separately.', inputSchema: z.object({ proposalId: z.string() }), execute: async (args, options) => session.perform('authoringRevert', args, options?.toolCallId) }),
    authoringProposePlan: tool({ description: 'Group 1–16 already-proposed content proposals (one per domain) into one reviewable plan. Applying is ordered and compensated on failure, not atomic. Does not modify content.', inputSchema: z.object({ proposalIds: z.array(z.string()).min(1).max(16) }), execute: async ({ proposalIds }) => session.proposePlan(proposalIds) }),
    authoringPlan: tool({ description: 'Query a plan: status, per-member proposal status and applied count. Does not expose inverse data.', inputSchema: z.object({ planId: z.string() }), execute: async ({ planId }) => session.plan(planId) }),
    authoringPlans: tool({ description: 'List runtime-scoped plans newest first with their domains and status. No inverse data returned.', inputSchema: z.object({ limit: z.number().int().min(1).max(50).default(20) }), execute: async ({ limit }) => session.planList(limit) }),
    authoringApplyPlan: tool({ description: 'Apply a plan: re-checks every member revision before writing, applies in order and compensates already-applied members when one fails. Save separately.', inputSchema: z.object({ planId: z.string() }), execute: async (args, options) => session.perform('authoringApplyPlan', args, options?.toolCallId) }),
    authoringRevertPlan: tool({ description: 'Revert an applied plan in reverse order, refusing when any member domain changed afterwards. Save separately.', inputSchema: z.object({ planId: z.string() }), execute: async (args, options) => session.perform('authoringRevertPlan', args, options?.toolCallId) }),
    authoringDiscardPlan: tool({ description: 'Discard an unapplied plan and its member drafts without touching content. Applied plans must be reverted instead.', inputSchema: z.object({ planId: z.string() }), execute: async (args, options) => session.perform('authoringDiscardPlan', args, options?.toolCallId) }),
  };
}
