import { createHash, randomUUID } from 'node:crypto';

type Result = Record<string, any>;
type Invoke = (name: string, args: Result) => Promise<Result>;
type EventKind = 'terrain' | 'entities' | 'ui' | 'script' | 'unknown';
type EventRow = {
  seq: number;
  at: number;
  operationId: string;
  tool: string;
  status: string;
  code?: string;
  kind: EventKind;
  actor: 'ai';
  summary: string;
};
type Receipt = { operationId: string; fingerprint: string; status: string; result?: Result };
type Proposal = { id: string; domain?: string; baseRevision: string; steps: Result[]; stepCount?: number; previews: Result[]; status: string; undo: string[]; revision?: string };
type PlanMember = { proposalId: string; domain: string; baseRevision: string };
type Plan = {
  id: string;
  members: PlanMember[];
  status: 'proposed' | 'applying' | 'applied' | 'compensated' | 'reverting' | 'reverted' | 'discarded' | 'unknown';
  appliedCount: number;
  revisions: Record<string, string>;
  error?: string;
};
export type ContentDomain = {
  revision(): string;
  prepare(args: Result): Promise<{ baseRevision: string; step: Result; preview: Result; undoToken: string }>;
  apply(step: Result, expectedRevision: string): Promise<Result>;
  revert(undoToken: string, expectedRevision: string): Promise<Result>;
};
type Journal = { rows: { kind: string; runtimeId: string; payload: Result }[]; reserve(): void; append(kind: 'intent' | 'result' | 'event', runtimeId: string, payload: Result): void; history(limit?: number): unknown[]; loadProposals?(): Result[]; saveProposals?(proposals: Result[]): void };

/** Tool name → the panel's five coarse kinds. */
function kindOf(tool: string): EventKind {
  if (/^terrain|^authoring(Apply|Revert|Propose|Discard)/.test(tool)) return 'terrain';
  if (/^(create|delete|update|move|copy)Entit|^getProjectModels|^addModelToProject|^createEntityFromModel|^searchPublicModels/.test(tool)) return 'entities';
  if (/^ui/.test(tool)) return 'ui';
  if (/Script/i.test(tool)) return 'script';
  return 'unknown';
}

/** One short line a human can read in the editor panel; never includes args. */
function summaryOf(tool: string, args: Result, status: string): string {
  const where = args?.region?.min && args?.region?.max
    ? ` [${args.region.min.join(',')}–${args.region.max.join(',')}]`
    : '';
  const block = typeof args?.block === 'number' || typeof args?.block === 'string' ? ` ${args.block}` : '';
  const state = status === 'completed' ? '' : ` · ${status}`;
  return `${tool}${block}${where}${state}`.slice(0, 320);
}

function canonical(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function authoringError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/** Runtime-scoped coordinator. Receipts are retained for this runtime lifetime.
 * Refuse at capacity rather than evict an idempotency key and replay a write.
 * Existing editor/human mutations still require the underlying tools' CAS.
 */
export class AuthoringSession {
  readonly runtimeId = randomUUID();
  private receipts = new Map<string, Receipt>();
  private inFlight = new Map<string, Promise<Result>>();
  private rows: EventRow[] = [];
  private subscribers = new Set<(row: EventRow) => void>();
  private proposals = new Map<string, Proposal>();
  private queue: Promise<unknown> = Promise.resolve();
  private seq = 0;
  private journal?: Journal;
  private journalFailed = false;
  private domains = new Map<string, ContentDomain>();

  private invoke: Invoke;
  private capacity: number;

  constructor(invoke: Invoke, capacity = 2000) { this.invoke = invoke; this.capacity = capacity; }

  attachJournal(journal: Journal) {
    if (this.journal || this.receipts.size) throw authoringError('JOURNAL_ALREADY_STARTED', 'Attach journal before accepting operations');
    const recovered = new Map<string, { fingerprint: string; runtimeId: string; outcome?: Result }>();
    for (const row of journal.rows) {
      const p = row.payload;
      if (row.kind === 'intent') recovered.set(p.operationId, { fingerprint: p.fingerprint, runtimeId: row.runtimeId });
      if (row.kind === 'result' && recovered.has(p.operationId)) recovered.get(p.operationId)!.outcome = p;
    }
    for (const [operationId, prior] of recovered) {
      this.receipts.set(operationId, { operationId, fingerprint: prior.fingerprint, status: 'recovered', result: {
        success: false, code: prior.outcome ? 'PREVIOUS_RUNTIME_OPERATION' : 'OPERATION_OUTCOME_UNKNOWN', operationId,
        runtimeId: this.runtimeId, previousRuntimeId: prior.runtimeId, historicalOutcome: prior.outcome,
        inspectRequired: true, error: 'Historical execution does not prove unsaved map content survived restart. Inspect current content; do not replay blindly.',
      } });
    }
    for (const p of journal.loadProposals?.() || []) {
      this.proposals.set(p.id, { id: p.id, domain: p.domain, baseRevision: p.baseRevision, previews: p.previews,
        undo: p.undo, revision: p.revision, stepCount: p.stepCount, steps: [],
        status: p.status === 'proposed' ? 'expired'
          : ['applying','reverting'].includes(p.status) ? 'unknown' : p.status });
    }
    this.journal = journal;
    this.checkpoint();
  }

  private checkpoint() {
    try { this.journal?.saveProposals?.([...this.proposals.values()]); }
    catch {
      this.journalFailed = true;
      for (const p of this.proposals.values()) {
        if (p.status === 'applying' || p.status === 'reverting') p.status = 'unknown';
      }
      throw authoringError('PROPOSAL_STORE_FAILED', 'Rollback state could not be committed. Inspect content; further writes are blocked.');
    }
  }

  journalHistory(limit = 100) {
    return { success: true, runtimeId: this.runtimeId, durable: !!this.journal, writesBlocked: this.journalFailed, events: this.journal?.history(limit) || [] };
  }

  disableWrites() { this.journalFailed = true; }

  registerDomain(name: string, domain: ContentDomain) { this.domains.set(name, domain); }

  async proposeContent(domainName: string, args: Result) {
    if (this.journalFailed) throw authoringError('JOURNAL_UNAVAILABLE', 'Writes are disabled');
    const domain = this.domains.get(domainName);
    if (!domain) throw authoringError('UNSUPPORTED_PROPOSAL_TOOL', 'Content domain is not mounted');
    if (this.proposals.size >= 100) throw authoringError('PROPOSAL_CAPACITY', 'Proposal capacity reached');
    const prepared = await domain.prepare(structuredClone(args));
    if (this.proposals.size >= 100) throw authoringError('PROPOSAL_CAPACITY', 'Proposal capacity reached');
    if (domain.revision() !== prepared.baseRevision) throw authoringError('REVISION_CONFLICT', 'Content changed during proposal preparation');
    const p: Proposal = { id: randomUUID(), domain: domainName, baseRevision: prepared.baseRevision,
      steps: [prepared.step], previews: [prepared.preview], undo: [prepared.undoToken], status: 'proposed' };
    this.proposals.set(p.id, p);
    this.checkpoint();
    return { success: true, runtimeId: this.runtimeId, proposalId: p.id, domain: domainName,
      status: p.status, baseRevision: p.baseRevision, previews: p.previews, persisted: false, rollbackAvailable: false };
  }

  private async runContent(p: Proposal, reverting: boolean): Promise<Result> {
    const domain = this.domains.get(p.domain!);
    if (!domain) throw authoringError('UNSUPPORTED_PROPOSAL_TOOL', 'Content domain is not mounted');
    const expected = reverting ? p.revision! : p.baseRevision;
    if (domain.revision() !== expected) throw authoringError('REVISION_CONFLICT', 'Content changed; refusing to overwrite later edits');
    p.status = reverting ? 'reverting' : 'applying';
    this.checkpoint();
    let result: Result;
    try { result = reverting ? await domain.revert(p.undo[0], expected) : await domain.apply(p.steps[0], expected); }
    catch (error) {
      p.status = 'unknown';
      this.checkpoint();
      return { success: false, code: 'CONTENT_OUTCOME_UNKNOWN', proposalId: p.id, inspectRequired: true, error: (error as Error).message };
    }
    if (result.success === false) {
      p.status = result.mutationStarted ? 'unknown' : reverting ? 'applied' : 'proposed';
      this.checkpoint();
      return { ...result, proposalId: p.id, inspectRequired: !!result.mutationStarted };
    }
    if (typeof result.newRevision !== 'string' || !result.newRevision) {
      p.status = 'unknown';
      this.checkpoint();
      return { success: false, code: 'CONTENT_OUTCOME_UNKNOWN', proposalId: p.id, inspectRequired: true, error: 'Content adapter omitted its verified revision' };
    }
    p.revision = result.newRevision;
    p.status = reverting ? 'reverted' : 'applied';
    if (reverting) p.undo = [];
    this.checkpoint();
    return { success: true, proposalId: p.id, domain: p.domain, revision: p.revision, rollbackAvailable: !reverting, persisted: false };
  }

  // ── plans: several single-domain proposals applied together, compensated on failure ──

  private plans = new Map<string, Plan>();

  /**
   * Group already-proposed content proposals into one reviewable unit.
   * One proposal per domain: two edits to the same content would both claim the
   * same base revision and the second can never apply.
   */
  async proposePlan(proposalIds: string[]) {
    if (this.journalFailed) throw authoringError('JOURNAL_UNAVAILABLE', 'Writes are disabled');
    if (!Array.isArray(proposalIds) || proposalIds.length < 1 || proposalIds.length > 16) {
      throw authoringError('INVALID_PLAN', 'Supply 1–16 proposal ids');
    }
    if (this.plans.size >= 50) throw authoringError('PLAN_CAPACITY', 'Plan capacity reached');
    const members: PlanMember[] = [];
    const seen = new Set<string>();
    for (const id of proposalIds) {
      const p = this.proposals.get(id);
      if (!p) throw authoringError('PROPOSAL_NOT_FOUND', `Proposal ${id} does not exist`);
      if (!p.domain) throw authoringError('UNSUPPORTED_PLAN_MEMBER', 'Terrain proposals already carry their own steps; group only content proposals');
      if (p.status !== 'proposed') throw authoringError('PROPOSAL_NOT_APPLICABLE', `Proposal ${id} is ${p.status}, not proposed`);
      if (seen.has(p.domain)) throw authoringError('DUPLICATE_PLAN_DOMAIN', `Domain ${p.domain} appears twice in one plan`);
      seen.add(p.domain);
      members.push({ proposalId: id, domain: p.domain, baseRevision: p.baseRevision });
    }
    const plan: Plan = { id: randomUUID(), members, status: 'proposed', appliedCount: 0, revisions: {} };
    this.plans.set(plan.id, plan);
    return { success: true, runtimeId: this.runtimeId, planId: plan.id, status: plan.status, atomic: false,
      members: members.map(m => ({ proposalId: m.proposalId, domain: m.domain })),
      note: 'Members apply in order; a failure compensates the members already applied. This is not a cross-domain transaction.' };
  }

  plan(id: string) {
    const plan = this.plans.get(id);
    if (!plan) return { success: false, code: 'PLAN_NOT_FOUND', runtimeId: this.runtimeId };
    return { success: true, runtimeId: this.runtimeId, planId: id, status: plan.status,
      appliedCount: plan.appliedCount, atomic: false,
      members: plan.members.map(m => ({ proposalId: m.proposalId, domain: m.domain, status: this.proposals.get(m.proposalId)?.status })) };
  }

  /** Newest-first plan index for review surfaces. Never includes inverse data. */
  planList(limit = 20) {
    const plans = [...this.plans.values()].slice(-Math.max(1, Math.min(50, limit))).reverse();
    return { success: true, runtimeId: this.runtimeId, atomic: false, plans: plans.map(p => ({
      planId: p.id, status: p.status, appliedCount: p.appliedCount,
      domains: p.members.map(m => m.domain),
    })) };
  }

  private memberProposal(m: PlanMember) {
    const p = this.proposals.get(m.proposalId);
    if (!p) throw authoringError('PROPOSAL_NOT_FOUND', `Proposal ${m.proposalId} disappeared`);
    const domain = this.domains.get(m.domain);
    if (!domain) throw authoringError('UNSUPPORTED_PROPOSAL_TOOL', `Domain ${m.domain} is not mounted`);
    return { p, domain };
  }

  async applyPlan(id: string) {
    const plan = this.plans.get(id);
    if (!plan) throw authoringError('PLAN_NOT_FOUND', `Plan ${id} does not exist`);
    if (plan.status !== 'proposed') throw authoringError('PLAN_NOT_APPLICABLE', `Plan is ${plan.status}`);
    // Every member is checked before any member writes: a stale member means the
    // agent's picture of the map is wrong and nothing should be applied.
    for (const m of plan.members) {
      const { p, domain } = this.memberProposal(m);
      if (domain.revision() !== p.baseRevision) {
        throw authoringError('REVISION_CONFLICT', `${m.domain} changed after its proposal; create a new plan`);
      }
    }
    plan.status = 'applying';
    const applied: PlanMember[] = [];
    for (const m of plan.members) {
      const { p, domain } = this.memberProposal(m);
      let result: Result;
      try {
        result = await domain.apply(p.steps[0], p.baseRevision);
      } catch (error) {
        await this.compensate(plan, applied, (error as Error).message);
        return { success: false, code: 'PLAN_MEMBER_FAILED', planId: id, compensated: applied.map(a => a.proposalId),
          error: (error as Error).message, inspectRequired: true };
      }
      if (result.success === false || typeof result.newRevision !== 'string' || !result.newRevision) {
        await this.compensate(plan, applied, result.error || 'member refused');
        return { success: false, code: 'PLAN_MEMBER_FAILED', planId: id, compensated: applied.map(a => a.proposalId),
          error: result.error || `Member ${m.domain} refused`, inspectRequired: !!result.mutationStarted };
      }
      p.status = 'applied';
      p.revision = result.newRevision;
      plan.revisions[m.domain] = result.newRevision;
      applied.push(m);
      plan.appliedCount = applied.length;
    }
    plan.status = 'applied';
    this.checkpoint();
    return { success: true, planId: id, status: plan.status, appliedCount: plan.appliedCount,
      revisions: plan.revisions, rollbackAvailable: true, persisted: false };
  }

  /** Best-effort reverse compensation. Any failure leaves the plan in `unknown`. */
  private async compensate(plan: Plan, applied: PlanMember[], reason: string) {
    const compensated: string[] = [];
    for (const m of [...applied].reverse()) {
      const { p, domain } = this.memberProposal(m);
      try {
        const result = await domain.revert(p.undo[0], p.revision || p.baseRevision);
        if (result.success === false) { plan.status = 'unknown'; break; }
        p.status = 'reverted';
        p.undo = [];
        compensated.push(m.proposalId);
      } catch {
        plan.status = 'unknown';
        break;
      }
    }
    if (plan.status !== 'unknown') {
      plan.status = 'compensated';
      plan.appliedCount = 0;
      plan.error = reason;
    }
    this.checkpoint();
    return compensated;
  }

  async revertPlan(id: string) {
    const plan = this.plans.get(id);
    if (!plan) throw authoringError('PLAN_NOT_FOUND', `Plan ${id} does not exist`);
    if (plan.status !== 'applied') throw authoringError('PLAN_NOT_REVERTIBLE', `Plan is ${plan.status}`);
    for (const m of plan.members) {
      const { p, domain } = this.memberProposal(m);
      if (domain.revision() !== p.revision) {
        throw authoringError('REVISION_CONFLICT', `${m.domain} changed after the plan was applied; refusing to overwrite later edits`);
      }
    }
    plan.status = 'reverting';
    for (const m of [...plan.members].reverse()) {
      const { p, domain } = this.memberProposal(m);
      let result: Result;
      try {
        result = await domain.revert(p.undo[0], p.revision!);
      } catch (error) {
        plan.status = 'unknown';
        this.checkpoint();
        return { success: false, code: 'PLAN_OUTCOME_UNKNOWN', planId: id, inspectRequired: true, error: (error as Error).message };
      }
      if (result.success === false) {
        plan.status = 'unknown';
        this.checkpoint();
        return { success: false, code: result.code || 'PLAN_MEMBER_FAILED', planId: id, inspectRequired: true, error: result.error };
      }
      p.status = 'reverted';
      p.undo = [];
      p.revision = result.newRevision;
      plan.appliedCount -= 1;
    }
    plan.status = 'reverted';
    plan.appliedCount = 0;
    this.checkpoint();
    return { success: true, planId: id, status: plan.status, persisted: false };
  }

  /** Drop an unapplied plan (and its member proposals) without touching content. */
  async discardPlan(id: string) {
    const plan = this.plans.get(id);
    if (!plan) throw authoringError('PLAN_NOT_FOUND', `Plan ${id} does not exist`);
    if (plan.status !== 'proposed') throw authoringError('PLAN_NOT_DISCARDABLE', `Plan is ${plan.status}; applied content must be reverted, not discarded`);
    const discarded: string[] = [];
    for (const m of plan.members) {
      const p = this.proposals.get(m.proposalId);
      if (!p) continue;
      if (p.status !== 'proposed' && p.status !== 'expired') continue;
      p.status = 'discarded';
      p.steps = [];
      p.undo = [];
      discarded.push(p.id);
    }
    plan.status = 'discarded';
    this.checkpoint();
    return { success: true, planId: id, status: plan.status, discarded };
  }

  /** Live tap for the editor's activity panel. Returns an unsubscribe function. */
  subscribe(listener: (row: EventRow) => void) {
    this.subscribers.add(listener);
    return () => { this.subscribers.delete(listener); };
  }

  private event(operationId: string, tool: string, status: string, code?: string, args: Result = {}) {
    const row: EventRow = {
      seq: ++this.seq,
      at: Date.now(),
      operationId,
      tool,
      status,
      kind: (['script', 'entities', 'ui'].includes(this.proposals.get(args?.proposalId)?.domain || '')
        ? this.proposals.get(args?.proposalId)!.domain : kindOf(tool)) as EventKind,
      actor: 'ai',
      summary: summaryOf(tool, args, status),
      ...(code ? { code } : {}),
    };
    this.rows.push(row);
    if (this.rows.length > 1000) this.rows.shift();
    for (const listener of this.subscribers) {
      try { listener(row); } catch { /* a broken tap must never fail a write */ }
    }
  }

  events(after = 0) {
    return { runtimeId: this.runtimeId, lastSeq: this.seq, resetRequired: after > this.seq || (this.rows.length > 0 && after < this.rows[0].seq - 1), events: this.rows.filter(row => row.seq > after) };
  }

  operation(id: string) {
    const row = this.receipts.get(id);
    if (!row) return { success: false, code: 'OPERATION_NOT_FOUND', runtimeId: this.runtimeId };
    return { success: true, runtimeId: this.runtimeId, ...row, fingerprint: undefined };
  }

  /** Serializes agent writes; duplicate requests join the same in-flight result. */
  perform(tool: string, args: Result, operationId: string = randomUUID()): Promise<Result> {
    if (!/^[\w:.-]{1,160}$/.test(operationId)) return Promise.reject(authoringError('INVALID_OPERATION_ID', 'operationId must be 1–160 letters, digits, _, :, . or -'));
    args = structuredClone(args);
    const fingerprint = createHash('sha256').update(canonical({ tool, args })).digest('hex');
    const previous = this.receipts.get(operationId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) return Promise.reject(authoringError('OPERATION_ID_REUSED', 'operationId already belongs to different arguments'));
      return this.inFlight.get(operationId) || Promise.resolve(previous.result!);
    }
    if (this.receipts.size >= this.capacity) return Promise.reject(authoringError('OPERATION_CAPACITY', 'Receipt capacity reached; preserve journal history and inspect before starting a new authoring workspace'));
    const receipt: Receipt = { operationId, fingerprint, status: 'queued' };
    this.receipts.set(operationId, receipt);
    const pending = this.queue.then(async () => {
      if (this.journalFailed) {
        receipt.status = 'failed';
        receipt.result = { success: false, code: 'JOURNAL_UNAVAILABLE', operationId, runtimeId: this.runtimeId, error: 'Journal failure blocks further writes' };
        this.event(operationId, tool, 'failed', 'JOURNAL_UNAVAILABLE');
        return receipt.result;
      }
      // Intent is durable before execution; a crash can never turn this ID into a new write.
      if (this.journal) {
        try { this.journal.reserve(); this.journal.append('intent', this.runtimeId, { operationId, fingerprint }); }
        catch (error) {
          this.journalFailed = true;
          receipt.status = 'failed';
          receipt.result = { success: false, code: 'JOURNAL_UNAVAILABLE', operationId, runtimeId: this.runtimeId, error: (error as Error).message };
          this.event(operationId, tool, 'failed', 'JOURNAL_UNAVAILABLE');
          return receipt.result;
        }
      }
      receipt.status = 'running';
      this.event(operationId, tool, 'running', undefined, args);
      try {
        const result = await this.invoke(tool, args);
        receipt.result = { ...result, operationId, runtimeId: this.runtimeId };
        receipt.status = result.success === false ? 'failed' : 'completed';
      } catch (error) {
        const code = (error as any).code || 'TOOL_EXECUTION_FAILED';
        receipt.status = code === 'PROPOSAL_STORE_FAILED' ? 'unknown' : 'failed';
        receipt.result = { success: false, code, error: (error as Error).message, operationId, runtimeId: this.runtimeId,
          ...(receipt.status === 'unknown' ? { inspectRequired: true } : {}) };
      }
      this.event(operationId, tool, receipt.status, receipt.result?.code, args);
      if (this.journal) {
        try {
          const result = receipt.result!;
          this.journal.append('result', this.runtimeId, { operationId, status: receipt.status,
            success: result.success !== false, code: result.code, revision: result.revision || result.newRevision,
            proposalId: result.proposalId });
          for (const row of this.rows.filter(row => row.operationId === operationId)) this.journal.append('event', this.runtimeId, row);
        } catch {
          this.journalFailed = true;
          receipt.status = 'unknown';
          receipt.result = { success: false, code: 'JOURNAL_COMMIT_FAILED', operationId, runtimeId: this.runtimeId, inspectRequired: true,
            error: 'Operation may have executed; inspect current content and proposal status.' };
          this.event(operationId, tool, 'unknown', 'JOURNAL_COMMIT_FAILED');
        }
      }
      return receipt.result!;
    });
    this.inFlight.set(operationId, pending);
    this.queue = pending.catch(() => undefined);
    this.event(operationId, tool, 'queued', undefined, args);
    void pending.finally(() => this.inFlight.delete(operationId));
    return pending;
  }

  proposal(id: string) {
    const p = this.proposals.get(id);
    if (!p) return { success: false, code: 'PROPOSAL_NOT_FOUND', runtimeId: this.runtimeId };
    return { success: true, runtimeId: this.runtimeId, proposalId: id, domain: p.domain || 'terrain', status: p.status,
      baseRevision: p.baseRevision, revision: p.revision, rollbackAvailable: ['applied','partial'].includes(p.status) && p.undo.length > 0,
      remainingUndoSteps: p.undo.length, rollbackDurable: !!this.journal?.saveProposals, persisted: false };
  }

  proposalList() {
    return { success: true, runtimeId: this.runtimeId, proposals: [...this.proposals.values()].reverse().map(p => ({
      ...this.proposal(p.id), previews: p.previews, stepCount: p.stepCount ?? p.steps.length,
    })) };
  }

  /** Discard only an unapplied draft. Applied/partial/unknown proposals retain
   * all recovery data; discarding must never be used as an ersatz rollback.
   * Call through perform() so rejection and application share the same queue.
   */
  discardProposal(id: string) {
    const p = this.proposals.get(id);
    if (!p) throw authoringError('PROPOSAL_NOT_FOUND', 'Proposal not found');
    if (p.status === 'discarded') return { success: true, proposalId: id, status: p.status, contentChanged: false };
    if (!['proposed', 'expired'].includes(p.status))
      throw authoringError('PROPOSAL_NOT_DISCARDABLE', 'Only unapplied drafts can be discarded; inspect or revert applied changes instead');
    p.stepCount = p.stepCount ?? p.steps.length;
    p.status = 'discarded';
    p.steps = [];
    p.undo = [];
    this.checkpoint();
    return { success: true, proposalId: id, status: p.status, contentChanged: false };
  }

  async propose(steps: Result[], expectedRevision?: string) {
    if (!Array.isArray(steps) || steps.length < 1 || steps.length > 64) throw authoringError('INVALID_PROPOSAL', 'Supply 1–64 terrainApply steps');
    if (this.proposals.size >= 100) throw authoringError('PROPOSAL_CAPACITY', 'Proposal capacity reached');
    const info = await this.invoke('terrainInfo', {});
    if (info.success === false || !info.revision) throw authoringError('STATE_UNAVAILABLE', 'Cannot read terrain revision');
    if (expectedRevision !== undefined && expectedRevision !== info.revision) throw authoringError('REVISION_CONFLICT', 'Terrain changed after reading source content; regenerate proposal');
    const normalized = structuredClone(steps);
    const previews: Result[] = [];
    for (const step of normalized) {
      if (step.tool !== 'terrainApply') throw authoringError('UNSUPPORTED_PROPOSAL_TOOL', 'Current compensation supports terrainApply only');
      const args = { ...step.args, expectedRevision: info.revision, dryRun: true, allowWhileRunning: false };
      const preview = await this.invoke('terrainApply', args);
      if (preview.success === false || preview.rejected > 0) throw authoringError(preview.code || 'PROPOSAL_REFUSED', preview.error || 'Proposal includes unwritable cells');
      previews.push({ changed: preview.changed, changedBounds: preview.changedBounds, region: args.region, block: preview.block });
    }
    const proposal: Proposal = { id: randomUUID(), baseRevision: info.revision, steps: normalized, previews, status: 'proposed', undo: [] };
    this.proposals.set(proposal.id, proposal);
    this.checkpoint();
    return { success: true, proposalId: proposal.id, baseRevision: proposal.baseRevision, previews, atomic: false, note: 'Previews are independent dry runs; overlapping steps are not a combined diff.' };
  }

  async applyProposal(id: string) {
    const p = this.proposals.get(id);
    if (!p || p.status !== 'proposed') throw authoringError('PROPOSAL_NOT_APPLICABLE', 'Proposal missing or already applied');
    if (p.domain) return this.runContent(p, false);
    const before = await this.invoke('terrainInfo', {});
    if (before.revision !== p.baseRevision) throw authoringError('REVISION_CONFLICT', 'Terrain changed after proposal; create a new proposal');
    p.status = 'applying';
    this.checkpoint();
    let revision = p.baseRevision;
    for (const step of p.steps) {
      let result: Result;
      try {
        result = await this.invoke('terrainApply', { ...step.args, expectedRevision: revision, dryRun: false, allowWhileRunning: false });
      } catch (error) {
        // An exception may occur after a mutation. Never infer that retry is safe.
        p.status = 'unknown';
        p.revision = revision;
        this.checkpoint();
        return { success: false, code: 'APPLY_OUTCOME_UNKNOWN', proposalId: id,
          error: (error as Error).message, inspectRequired: true, persisted: false };
      }
      if (result.undoToken && result.undoToken !== '[]') p.undo.push(result.undoToken);
      revision = result.newRevision || revision;
      p.revision = revision;
      this.checkpoint();
      if (result.success === false || result.rejected > 0) {
        p.status = 'partial';
        this.checkpoint();
        return { success: false, code: result.code || 'PARTIAL_APPLY', proposalId: id, revision, rollbackAvailable: p.undo.length > 0, error: result.error };
      }
    }
    p.status = 'applied';
    p.revision = revision;
    this.checkpoint();
    return { success: true, proposalId: id, revision, rollbackAvailable: p.undo.length > 0, persisted: false };
  }

  async revertProposal(id: string) {
    const p = this.proposals.get(id);
    if (!p || !['applied', 'partial'].includes(p.status)) throw authoringError('PROPOSAL_NOT_REVERTIBLE', 'Proposal has no reversible changes');
    if (p.domain) return this.runContent(p, true);
    let info = await this.invoke('terrainInfo', {});
    if (info.revision !== p.revision) throw authoringError('REVISION_CONFLICT', 'Terrain changed after apply; refusing to overwrite later edits');
    p.status = 'reverting';
    this.checkpoint();
    while (p.undo.length) {
      let result: Result;
      try {
        result = await this.invoke('terrainRevert', { undoToken: p.undo[p.undo.length - 1], expectedRevision: info.revision });
      } catch (error) {
        p.status = 'unknown';
        this.checkpoint();
        return { success: false, code: 'REVERT_OUTCOME_UNKNOWN', proposalId: id,
          error: (error as Error).message, inspectRequired: true, persisted: false };
      }
      if (result.newRevision) p.revision = result.newRevision;
      if (result.success === false) { p.status = result.newRevision ? 'partial' : 'unknown'; this.checkpoint(); return { ...result, proposalId: id, inspectRequired: p.status === 'unknown' }; }
      p.undo.pop();
      info = { revision: result.newRevision };
      p.revision = info.revision;
      this.checkpoint();
    }
    p.status = 'reverted';
    this.checkpoint();
    return { success: true, proposalId: id, revision: info.revision, persisted: false };
  }
}
