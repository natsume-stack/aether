import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore Native Node test runner needs explicit extensions.
import { AuthoringJournal } from './authoring-journal.ts';
// @ts-ignore Native Node test runner needs explicit extensions.
import { AuthoringSession } from './authoring-session.ts';

function fixture(run: (file: string) => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'box3-journal-'));
  return run(path.join(root, 'map.jsonl')).finally(() => fs.rmSync(root, { recursive: true, force: true }));
}

test('completed terrain inverses survive restart; pending plans expire and later edits are protected', () => fixture(async file => {
  let revision = 'original';
  let block = 0;
  const invoke = async (tool: string, args: Record<string, any>) => {
    if (tool === 'terrainInfo') return { success: true, revision };
    if (args.expectedRevision !== revision) throw new Error('revision mismatch');
    if (args.dryRun) return { success: true, changed: 1 };
    if (tool === 'terrainApply') { block = 3; revision = 'applied'; return { success: true, newRevision: revision, undoToken: '[0]' }; }
    assert.equal(tool, 'terrainRevert');
    assert.equal(args.undoToken, '[0]');
    block = 0; revision = 'restored';
    return { success: true, newRevision: revision };
  };
  const first = new AuthoringSession(invoke);
  const journal = new AuthoringJournal(file);
  first.attachJournal(journal);
  const steps = [{ tool: 'terrainApply', args: { secret: 'EXECUTABLE_INPUT' } }];
  const pending = await first.propose(steps);
  const rejected = await first.propose(steps);
  first.discardProposal(rejected.proposalId);
  const applied = await first.propose(steps);
  await first.applyProposal(applied.proposalId);
  assert.equal(block, 3);
  assert.equal(fs.readFileSync(`${file}.proposals.json`, 'utf8').includes('EXECUTABLE_INPUT'), false);
  journal.close();
  const recovered = new AuthoringSession(invoke);
  const nextJournal = new AuthoringJournal(file);
  try {
    recovered.attachJournal(nextJournal);
    assert.equal(recovered.proposal(rejected.proposalId).status, 'discarded');
    await assert.rejects(recovered.applyProposal(rejected.proposalId), /missing or already applied/);
    assert.equal(recovered.proposal(pending.proposalId).status, 'expired');
    recovered.discardProposal(pending.proposalId);
    assert.equal(recovered.proposal(pending.proposalId).status, 'discarded');
    await assert.rejects(recovered.applyProposal(pending.proposalId), /missing or already applied/);
    assert.equal(recovered.proposal(applied.proposalId).rollbackDurable, true);
    revision = 'human-edit';
    await assert.rejects(recovered.revertProposal(applied.proposalId), /refusing to overwrite/);
    assert.equal(block, 3);
    revision = 'applied';
    await recovered.revertProposal(applied.proposalId);
    assert.equal(block, 0);
    assert.equal(recovered.proposal(applied.proposalId).status, 'reverted');
  } finally { nextJournal.close(); }
}));

test('interrupted proposal is unknown and corrupt inverse snapshots are refused', () => fixture(async file => {
  const journal = new AuthoringJournal(file);
  journal.saveProposals([{ id: 'interrupted', baseRevision: 'r0', steps: [], previews: [], undo: ['[0]'], status: 'reverting' }]);
  journal.close();
  const next = new AuthoringJournal(file);
  const session = new AuthoringSession(async () => assert.fail('must not resume'));
  session.attachJournal(next);
  assert.equal(session.proposal('interrupted').status, 'unknown');
  await assert.rejects(session.revertProposal('interrupted'), /no reversible changes/);
  next.close();
  const snapshot = `${file}.proposals.json`;
  fs.writeFileSync(snapshot, fs.readFileSync(snapshot, 'utf8').replace('r0', 'r9'));
  const corrupt = new AuthoringJournal(file);
  try { assert.throws(() => new AuthoringSession(async () => ({})).attachJournal(corrupt), /CORRUPT/); }
  finally { corrupt.close(); }
}));

test('inverse checkpoint failure marks in-flight proposal unknown and blocks further writes', async () => {
  let snapshots = 0;
  let session: AuthoringSession;
  session = new AuthoringSession((tool, args) => tool === 'authoringApply'
    ? session.applyProposal(args.proposalId)
    : Promise.resolve(tool === 'terrainInfo' ? { success: true, revision: 'r0' }
      : { success: true, changed: 1, newRevision: 'r1', undoToken: '[0]' }));
  session.attachJournal({ rows: [], reserve() {}, append() {}, history: () => [],
    saveProposals() { if (++snapshots === 4) throw new Error('disk full'); } });
  const proposal = await session.propose([{ tool: 'terrainApply', args: {} }]);
  const result = await session.perform('authoringApply', { proposalId: proposal.proposalId }, 'apply');
  assert.equal(result.code, 'PROPOSAL_STORE_FAILED');
  assert.equal(result.inspectRequired, true);
  assert.equal(session.proposal(proposal.proposalId).status, 'unknown');
  assert.equal((await session.perform('write', {}, 'next')).code, 'JOURNAL_UNAVAILABLE');
});

test('restart retains IDs but never blindly replays or claims unsaved content survived', () => fixture(async file => {
  let writes = 0;
  const first = new AuthoringSession(async () => { writes++; return { success: true, newRevision: 'r1', undoToken: 'SECRET_UNDO', content: 'SECRET_SCRIPT' }; });
  const firstJournal = new AuthoringJournal(file);
  first.attachJournal(firstJournal);
  await first.perform('terrainApply', { content: 'SECRET_INPUT' }, 'stable');
  assert.equal(writes, 1);
  assert.throws(() => new AuthoringJournal(file), /IN_USE/);
  firstJournal.close();
  const second = new AuthoringSession(async () => { writes++; return { success: true }; });
  second.attachJournal(new AuthoringJournal(file));
  const result = await second.perform('terrainApply', { content: 'SECRET_INPUT' }, 'stable');
  assert.equal(result.code, 'PREVIOUS_RUNTIME_OPERATION');
  assert.equal(result.historicalOutcome.success, true);
  assert.equal(result.inspectRequired, true);
  assert.equal(writes, 1);
  const receipt = second.operation('stable');
  assert.ok('status' in receipt);
  assert.equal(receipt.status, 'recovered');
  await assert.rejects(second.perform('terrainApply', {}, 'stable'), /different arguments/);
  const text = fs.readFileSync(file, 'utf8');
  assert.equal(text.includes('SECRET_'), false);
  assert.equal(second.journalHistory().events.length, 3);
}));

test('intent without result survives torn tail as unknown, not permission to retry', () => fixture(async file => {
  const journal = new AuthoringJournal(file);
  journal.append('intent', 'old', { operationId: 'interrupted', fingerprint: 'a'.repeat(64) });
  fs.appendFileSync(file, '{"partial":');
  journal.close();
  const recovered = new AuthoringSession(async () => assert.fail('must not execute'));
  recovered.attachJournal(new AuthoringJournal(file));
  const receipt = recovered.operation('interrupted');
  assert.ok('result' in receipt);
  assert.equal(receipt.result?.code, 'OPERATION_OUTCOME_UNKNOWN');
  assert.equal(fs.readFileSync(file, 'utf8').endsWith('\n'), true);
}));

test('corrupt complete records are refused and capacity failure happens before mutation', () => fixture(async file => {
  fs.writeFileSync(file, '{"row":{"version":1},"digest":"bad"}\n');
  assert.throws(() => new AuthoringJournal(file));
  fs.writeFileSync(file, '');
  let writes = 0;
  const session = new AuthoringSession(async () => { writes++; return { success: true }; });
  session.attachJournal(new AuthoringJournal(file, 100));
  const result = await session.perform('write', {}, 'capacity');
  assert.equal(result.code, 'JOURNAL_UNAVAILABLE');
  assert.equal(writes, 0);
  assert.equal((await session.perform('write', {}, 'next')).code, 'JOURNAL_UNAVAILABLE');
  assert.equal(writes, 0);
}));

test('journal failure after mutation reports uncertainty and blocks the next write', async () => {
  let writes = 0;
  const session = new AuthoringSession(async () => { writes++; return { success: true }; });
  session.attachJournal({ rows: [], reserve() {}, history: () => [], append(kind: string) { if (kind === 'result') throw new Error('disk full'); } });
  const result = await session.perform('terrainApply', {}, 'first');
  assert.equal(result.code, 'JOURNAL_COMMIT_FAILED');
  assert.equal(result.inspectRequired, true);
  assert.equal(writes, 1);
  assert.equal((await session.perform('terrainApply', {}, 'second')).code, 'JOURNAL_UNAVAILABLE');
  assert.equal(writes, 1);
  assert.equal(session.events().events.filter(row => row.operationId === 'first').at(-1)?.status, 'unknown');
});
