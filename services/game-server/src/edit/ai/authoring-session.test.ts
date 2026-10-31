import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-ignore Native Node test runner requires the explicit TypeScript extension.
import { AuthoringSession } from './authoring-session.ts';

function harness() {
  let revision = 'r0';
  let value = 0;
  let writes = 0;
  const session = new AuthoringSession(async (tool, args) => {
    if (tool === 'terrainInfo') return { success: true, revision };
    if (tool === 'authoringApply') return session.applyProposal(args.proposalId);
    if (tool === 'authoringRevert') return session.revertProposal(args.proposalId);
    if (args.expectedRevision !== revision) return { success: false, code: 'REVISION_CONFLICT' };
    if (args.dryRun) return { success: true, changed: 1, rejected: 0, block: args.block };
    const prev = value;
    value = tool === 'terrainRevert' ? JSON.parse(args.undoToken)[0].prev : args.block;
    writes++;
    revision = `r${writes}`;
    return { success: true, newRevision: revision, undoToken: JSON.stringify([{ x: 1, y: 1, z: 1, prev }]) };
  });
  return { session, value: () => value, writes: () => writes, humanEdit: () => { revision = 'human'; value = 99; } };
}

test('simultaneous duplicates write once; changed arguments cannot reuse id', async () => {
  const h = harness();
  const args = { expectedRevision: 'r0', block: 3 };
  const [a,b] = await Promise.all([h.session.perform('terrainApply', args, 'same'), h.session.perform('terrainApply', args, 'same')]);
  assert.deepEqual(a,b);
  assert.equal(h.writes(), 1);
  assert.equal(h.session.operation('same').status, 'completed');
  await assert.rejects(h.session.perform('terrainApply', { ...args, block: 4 }, 'same'), /different arguments/);
});

test('proposal preview does not write; apply and reverse restore content', async () => {
  const h = harness();
  const p = await h.session.propose([{ tool: 'terrainApply', args: { block: 7 } }]);
  assert.equal(h.writes(),0);
  const listed = h.session.proposalList();
  assert.equal(listed.proposals[0].proposalId, p.proposalId);
  assert.equal(listed.proposals[0].status, 'proposed');
  assert.equal(JSON.stringify(listed).includes('undoToken'), false);
  const result = await h.session.perform('authoringApply', { proposalId: p.proposalId }, 'apply');
  assert.equal(result.success,true);
  assert.equal(h.value(),7);
  const reverted = await h.session.perform('authoringRevert', { proposalId: p.proposalId }, 'revert');
  assert.equal(reverted.success,true);
  assert.equal(h.value(),0);
});

test('human edits invalidate stale proposals and later rollback', async () => {
  const h = harness();
  const p = await h.session.propose([{ tool: 'terrainApply', args: { block: 7 } }]);
  await h.session.perform('authoringApply', { proposalId: p.proposalId }, 'apply');
  h.humanEdit();
  const result = await h.session.perform('authoringRevert', { proposalId: p.proposalId }, 'revert');
  assert.equal(result.code,'REVISION_CONFLICT');
  assert.equal(h.value(),99);
  const h2 = harness();
  const p2 = await h2.session.propose([{ tool: 'terrainApply', args: { block: 1 } }]);
  h2.humanEdit();
  await assert.rejects(h2.session.applyProposal(p2.proposalId), /changed/);
});

test('event sequence resumes and does not include argument or undo payloads', async () => {
  const h = harness();
  await h.session.perform('terrainApply', { expectedRevision: 'r0', block: 1 }, 'first');
  const events = h.session.events(1);
  assert.deepEqual(events.events.map(e => e.status), ['running','completed']);
  assert.equal(JSON.stringify(events).includes('undoToken'), false);
  assert.equal(h.session.operation('missing').code, 'OPERATION_NOT_FOUND');
});

test('receipt capacity refuses a new write without evicting idempotency history', async () => {
  let calls=0;
  const session = new AuthoringSession(async () => { calls++; return { success:true }; }, 1);
  await session.perform('write',{},'one');
  await assert.rejects(session.perform('write',{},'two'), /capacity/);
  await session.perform('write',{},'one');
  assert.equal(calls,1);
});

test('subscriber exceptions cannot fail writes and unsubscribe stops delivery', async () => {
  const h = harness();
  const rows: unknown[] = [];
  const off = h.session.subscribe(row => rows.push(row));
  const broken = h.session.subscribe(() => { throw new Error('viewer failed'); });
  const result = await h.session.perform('terrainApply', { expectedRevision: 'r0', block: 1 }, 'stream');
  assert.equal(result.success, true);
  assert.equal(rows.length, 3);
  off(); broken();
  await h.session.perform('terrainApply', { expectedRevision: 'r1', block: 2 }, 'after-unsubscribe');
  assert.equal(rows.length, 3);
});

test('ambiguous apply exception is queryable and cannot be blindly applied again', async () => {
  const session = new AuthoringSession(async (name, args) => {
    if (name === 'terrainInfo') return { revision: 'r0' };
    if (args.dryRun) return { success: true };
    throw new Error('lost response after mutation');
  });
  const p = await session.propose([{ tool: 'terrainApply', args: { block: 1 } }]);
  const result = await session.applyProposal(p.proposalId);
  assert.equal(result.code, 'APPLY_OUTCOME_UNKNOWN');
  assert.equal(session.proposal(p.proposalId).status, 'unknown');
  await assert.rejects(session.applyProposal(p.proposalId), /already applied/);
  await assert.rejects(session.revertProposal(p.proposalId), /no reversible/);
});

test('proposal compiled from stale source revision is refused before dry-run', async () => {
  const h = harness();
  h.humanEdit();
  await assert.rejects(h.session.propose([{ tool: 'terrainApply', args: { block: 1 } }], 'r0'), /regenerate proposal/);
  assert.equal(h.writes(), 0);
});

// ─── cross-domain plans ─────────────────────────────────────────────────────
function fakeDomain(initial = 'd0', failApply = false) {
  let rev = initial;
  let value = 0;
  return {
    get value() { return value; },
    item(value2: number, revision: string) { value = value2; rev = revision; },
    domain: {
      revision: () => rev,
      prepare: async (args: any) => ({ baseRevision: rev, step: { v: args.v }, preview: { to: args.v }, undoToken: String(value) }),
      apply: async (step: any, expected: string) => {
        if (expected !== rev) throw new Error('changed');
        if (failApply) return { success: false, code: 'DOMAIN_REFUSED' };
        value = step.v; rev = `${rev}>`;
        return { success: true, newRevision: rev };
      },
      revert: async (token: string, expected: string) => {
        if (expected !== rev) throw new Error('changed');
        value = Number(token); rev = `${rev}<`;
        return { success: true, newRevision: rev };
      },
    },
  };
}

function planSession(domains: Record<string, ReturnType<typeof fakeDomain>>) {
  const session = new AuthoringSession(async () => ({ success: false, code: 'UNUSED' }));
  for (const [name, d] of Object.entries(domains)) session.registerDomain(name, d.domain as any);
  return session;
}

test('a plan applies members in order and reverts them in reverse', async () => {
  const a = fakeDomain(); const b = fakeDomain();
  const session = planSession({ a, b });
  const pa = await session.proposeContent('a', { v: 1 });
  const pb = await session.proposeContent('b', { v: 2 });
  const plan = await session.proposePlan([pa.proposalId, pb.proposalId]);
  assert.equal(plan.atomic, false);
  assert.equal(plan.members.length, 2);

  const applied = await session.applyPlan(plan.planId);
  assert.equal(applied.success, true);
  assert.equal(a.value, 1); assert.equal(b.value, 2);
  assert.equal(session.plan(plan.planId).status, 'applied');

  const reverted = await session.revertPlan(plan.planId);
  assert.equal(reverted.success, true);
  assert.equal(a.value, 0); assert.equal(b.value, 0);
  assert.equal(session.plan(plan.planId).status, 'reverted');
});

test('a stale member refuses the plan before any member writes', async () => {
  const a = fakeDomain(); const b = fakeDomain();
  const session = planSession({ a, b });
  const pa = await session.proposeContent('a', { v: 1 });
  const pb = await session.proposeContent('b', { v: 2 });
  const plan = await session.proposePlan([pa.proposalId, pb.proposalId]);
  b.item(7, 'human');
  await assert.rejects(session.applyPlan(plan.planId), /changed after its proposal/);
  assert.equal(a.value, 0);
  assert.equal(session.plan(plan.planId).status, 'proposed');
});

test('a failing member compensates the members already applied', async () => {
  const a = fakeDomain(); const bad = fakeDomain('d0', true);
  const session = planSession({ a, bad });
  const pa = await session.proposeContent('a', { v: 5 });
  const pb = await session.proposeContent('bad', { v: 9 });
  const plan = await session.proposePlan([pa.proposalId, pb.proposalId]);
  const result = await session.applyPlan(plan.planId);
  assert.equal(result.success, false);
  assert.equal(result.code, 'PLAN_MEMBER_FAILED');
  assert.equal(result.compensated.length, 1);
  assert.equal(a.value, 0);
  assert.equal(session.plan(plan.planId).status, 'compensated');
  assert.equal(session.plan(plan.planId).appliedCount, 0);
});

test('a plan refuses two proposals from one domain and non-proposed members', async () => {
  const a = fakeDomain(); const b = fakeDomain();
  const session = planSession({ a, b });
  const p1 = await session.proposeContent('a', { v: 1 });
  const p2 = await session.proposeContent('a', { v: 2 });
  await assert.rejects(session.proposePlan([p1.proposalId, p2.proposalId]), /appears twice/);
  const p3 = await session.proposeContent('b', { v: 3 });
  await session.applyProposal(p3.proposalId);
  await assert.rejects(session.proposePlan([p1.proposalId, p3.proposalId]), /not proposed/);
});

test('an unapplied plan can be discarded without touching content', async () => {
  const a = fakeDomain(); const b = fakeDomain();
  const session = planSession({ a, b });
  const pa = await session.proposeContent('a', { v: 1 });
  const pb = await session.proposeContent('b', { v: 2 });
  const plan = await session.proposePlan([pa.proposalId, pb.proposalId]);
  const discarded = await session.discardPlan(plan.planId);
  assert.deepEqual(discarded.discarded.sort(), [pa.proposalId, pb.proposalId].sort());
  assert.equal(session.plan(plan.planId).status, 'discarded');
  assert.equal(a.value, 0); assert.equal(b.value, 0);
});
