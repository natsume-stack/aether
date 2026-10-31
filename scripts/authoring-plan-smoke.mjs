#!/usr/bin/env node
/**
 * Real-map acceptance for cross-domain plans (currently single UI member).
 *
 *   node scripts/authoring-plan-smoke.mjs pvp-4e55bb-imported
 *
 * What it proves: the plan tools exist on the live runtime, a UI proposal can be
 * grouped, applied, saved, reverted and saved again, and the UI tree returns to
 * its original content/revision.
 * What it does not prove: cross-domain atomicity or visual quality.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { authoringSmokeClient } from './lib/authoring-smoke-client.mjs';

const project = process.argv[2];
const evidencePath = path.join('.local-evidence', 'authoring-plan-smoke.json');
const stages = [];
const record = (stage, data = {}) => { stages.push({ stage, at: new Date().toISOString(), ...data }); };

const client = authoringSmokeClient(project, ['terrainInfo', 'uiContext', 'authoringPlan', 'authoringProposals']);

try {
  await client.restart('terrainInfo');
  record('runtime-ready');

  const catalogue = await client.request('internal/ai-tool');
  const names = (catalogue.tools || []).map(t => (typeof t === 'string' ? t : t.name));
  for (const required of ['authoringProposePlan', 'authoringPlan', 'authoringPlans', 'authoringApplyPlan', 'authoringRevertPlan', 'authoringDiscardPlan']) {
    assert.ok(names.includes(required), `${required} is not exposed on the live runtime`);
  }
  record('tools-exposed', { tools: names.length });

  await client.stopped();
  const before = await client.tool('uiContext', { limit: 256 });
  assert.ok(before.revision, 'UI context must return a revision');
  const props = n => n?.value?.data?.data || {};
  const byId = (list, id) => (list || []).find(n => n.id === id);
  const node = (before.nodes || []).find(n => 'backgroundColor' in props(n)) || (before.nodes || [])[0];
  assert.ok(node, 'no UI node available for a property-only edit');

  const proposal = await client.tool('authoringProposeUi', {
    expectedRevision: before.revision,
    patches: [{ nodeId: node.id, properties: { backgroundColor: [12, 34, 56] } }],
  });
  assert.equal((await client.tool('uiContext', { limit: 1 })).revision, before.revision, 'proposal must not write');
  record('proposal', { proposalId: proposal.proposalId, nodeId: node.id });

  const plan = await client.tool('authoringProposePlan', { proposalIds: [proposal.proposalId] });
  assert.equal(plan.atomic, false);
  record('plan-created', { planId: plan.planId });

  const applied = await client.tool('authoringApplyPlan', { planId: plan.planId }, `plan-apply-${plan.planId}`);
  assert.equal(applied.success, true);
  const afterApply = await client.tool('uiContext', { limit: 256 });
  assert.notEqual(afterApply.revision, before.revision, 'apply must change UI revision');
  assert.deepEqual(props(byId(afterApply.nodes, node.id)).backgroundColor, [12, 34, 56]);
  await client.save();
  record('applied-saved', { revision: afterApply.revision });

  assert.equal((await client.tool('authoringPlan', { planId: plan.planId })).status, 'applied');
  const reverted = await client.tool('authoringRevertPlan', { planId: plan.planId }, `plan-revert-${plan.planId}`);
  assert.equal(reverted.success, true);
  const afterRevert = await client.tool('uiContext', { limit: 256 });
  assert.deepEqual(props(byId(afterRevert.nodes, node.id)).backgroundColor, props(node).backgroundColor, 'UI property restored');
  assert.equal(afterRevert.revision, before.revision, 'UI revision returns to its pre-plan value');
  await client.save();
  assert.equal((await client.tool('authoringPlan', { planId: plan.planId })).status, 'reverted');
  record('reverted-saved');

  const plans = await client.tool('authoringPlans', { limit: 10 });
  assert.ok(plans.plans.some(p => p.planId === plan.planId));
  record('plan-listed', { count: plans.plans.length });

  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  fs.writeFileSync(evidencePath, `${JSON.stringify({ ok: true, project, node: node.nodeId || node.id, stages }, null, 2)}\n`);
  console.log(JSON.stringify({ ok: true, stages: stages.map(s => s.stage) }));
} catch (error) {
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  fs.writeFileSync(evidencePath, `${JSON.stringify({ ok: false, project, error: error.message, stages }, null, 2)}\n`);
  throw error;
}
