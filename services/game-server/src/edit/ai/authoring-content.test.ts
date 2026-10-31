import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-ignore Native Node tests require explicit extension.
import { AuthoringSession } from './authoring-session.ts';

function fixture() {
  let text = 'before';
  let edits = 0;
  let refuse = false;
  let throwAfterWrite = false;
  let session: AuthoringSession;
  session = new AuthoringSession((tool, args) => tool === 'authoringApply'
    ? session.applyProposal(args.proposalId) : session.revertProposal(args.proposalId));
  session.registerDomain('script', {
    revision: () => text,
    prepare: async () => ({ baseRevision: text, step: { content: 'after' }, preview: { name: 'main.js' }, undoToken: text }),
    apply: async step => {
      if (refuse) return { success: false, code: 'PREVIEW_RUNNING', mutationStarted: false };
      text = step.content; edits++;
      if (throwAfterWrite) throw new Error('readback interrupted');
      return { success: true, newRevision: text };
    },
    revert: async token => { text = token; edits++; return { success: true, newRevision: text }; },
  });
  return { session, text: () => text, edits: () => edits, human: () => { text = 'human'; },
    refuse: () => { refuse = true; }, interrupt: () => { throwAfterWrite = true; } };
}

test('content proposal is non-writing; apply is idempotent and inverse restores original', async () => {
  const h = fixture();
  const p = await h.session.proposeContent('script', {});
  assert.equal(h.edits(), 0);
  assert.equal(p.rollbackAvailable, false);
  const first = await h.session.perform('authoringApply', { proposalId: p.proposalId }, 'apply');
  assert.equal(first.success, true);
  assert.deepEqual(await h.session.perform('authoringApply', { proposalId: p.proposalId }, 'apply'), first);
  assert.equal(h.edits(), 1);
  assert.equal(h.session.events().events.every(row => row.kind === 'script'), true);
  await h.session.perform('authoringRevert', { proposalId: p.proposalId }, 'revert');
  assert.equal(h.text(), 'before');
});

test('known refusal stays proposed; human change invalidates a prepared proposal', async () => {
  const h = fixture();
  const p = await h.session.proposeContent('script', {});
  h.refuse();
  assert.equal((await h.session.perform('authoringApply', { proposalId: p.proposalId }, 'blocked')).code, 'PREVIEW_RUNNING');
  assert.equal(h.session.proposal(p.proposalId).status, 'proposed');
  h.human();
  const conflict = await h.session.perform('authoringApply', { proposalId: p.proposalId }, 'conflict');
  assert.equal(conflict.code, 'REVISION_CONFLICT');
  assert.equal(h.text(), 'human');
  assert.equal(h.edits(), 0);
});

test('interruption after a write retains inverse but refuses blind reapply/revert', async () => {
  const h = fixture();
  const p = await h.session.proposeContent('script', {});
  h.interrupt();
  const result = await h.session.perform('authoringApply', { proposalId: p.proposalId }, 'interrupted');
  assert.equal(result.code, 'CONTENT_OUTCOME_UNKNOWN');
  assert.equal(result.inspectRequired, true);
  assert.equal(h.session.proposal(p.proposalId).status, 'unknown');
  assert.equal(h.session.proposal(p.proposalId).remainingUndoSteps, 1);
  await assert.rejects(h.session.applyProposal(p.proposalId));
  await assert.rejects(h.session.revertProposal(p.proposalId));
  assert.equal(h.edits(), 1);
});

test('a later human edit protects content from a previously valid inverse', async () => {
  const h = fixture();
  const p = await h.session.proposeContent('script', {});
  await h.session.perform('authoringApply', { proposalId: p.proposalId }, 'apply');
  h.human();
  assert.equal((await h.session.perform('authoringRevert', { proposalId: p.proposalId }, 'revert')).code, 'REVISION_CONFLICT');
  assert.equal(h.text(), 'human');
  assert.equal(h.edits(), 1);
});

test('discard is durable, does not mutate content, and cannot erase applied recovery data', async () => {
  let text='original';
  let stored: any[]=[];
  const journal: any={rows:[],reserve(){},append(){},history(){return[];},
    loadProposals:()=>structuredClone(stored),saveProposals:(values:any[])=>{stored=structuredClone(values);}};
  let session: AuthoringSession;
  const invoke=async(tool:string,args:any)=>tool==='authoringDiscard'?session.discardProposal(args.proposalId)
    :tool==='authoringApply'?session.applyProposal(args.proposalId):session.revertProposal(args.proposalId);
  session=new AuthoringSession(invoke);
  const domain={revision:()=>text,prepare:async()=>({baseRevision:text,step:{},preview:{kind:'script'},undoToken:text}),
    apply:async()=>{text='changed';return{success:true,newRevision:text};},
    revert:async(token:string)=>{text=token;return{success:true,newRevision:text};}};
  session.registerDomain('script',domain);
  session.attachJournal(journal);
  const draft=await session.proposeContent('script',{});
  assert.equal((await session.perform('authoringDiscard',{proposalId:draft.proposalId},'discard')).success,true);
  assert.equal(text,'original');
  assert.equal(session.proposal(draft.proposalId).status,'discarded');
  assert.equal(stored[0].undo.length,0);
  assert.equal(stored[0].steps.length,0);
  assert.equal((await session.perform('authoringApply',{proposalId:draft.proposalId},'apply-discarded')).success,false);
  await session.perform('authoringDiscard',{proposalId:draft.proposalId},'discard-again');
  const recovered=new AuthoringSession(invoke);
  recovered.attachJournal(journal);
  assert.equal(recovered.proposal(draft.proposalId).status,'discarded');
  const active=await session.proposeContent('script',{});
  await session.perform('authoringApply',{proposalId:active.proposalId},'apply-new');
  const refused=await session.perform('authoringDiscard',{proposalId:active.proposalId},'discard-applied');
  assert.equal(refused.code,'PROPOSAL_NOT_DISCARDABLE');
  assert.equal(session.proposal(active.proposalId).rollbackAvailable,true);
  assert.equal(text,'changed');
  await session.perform('authoringRevert',{proposalId:active.proposalId},'restore');
  assert.equal(text,'original');
});

test('queued apply wins over later discard without losing the inverse', async()=>{
  let text='before'; let session:AuthoringSession;
  session=new AuthoringSession(async(tool,args)=>tool==='authoringDiscard'?session.discardProposal(args.proposalId):session.applyProposal(args.proposalId));
  session.registerDomain('script',{revision:()=>text,prepare:async()=>({baseRevision:text,step:{},preview:{},undoToken:text}),
    apply:async()=>{await Promise.resolve();text='after';return{success:true,newRevision:text};},
    revert:async()=>({success:false})});
  const proposal=await session.proposeContent('script',{});
  const apply=session.perform('authoringApply',{proposalId:proposal.proposalId},'apply-first');
  const discard=session.perform('authoringDiscard',{proposalId:proposal.proposalId},'discard-later');
  assert.equal((await apply).success,true);
  assert.equal((await discard).code,'PROPOSAL_NOT_DISCARDABLE');
  assert.equal(session.proposal(proposal.proposalId).rollbackAvailable,true);
});
