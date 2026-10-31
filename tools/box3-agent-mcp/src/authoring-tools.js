const annotations = (write) => ({ readOnlyHint: !write, destructiveHint: write, idempotentHint: !write, openWorldHint: true });
const projectId = { type: 'string' };
const operationId = { type: 'string', minLength: 1, maxLength: 100, pattern: '^[\\w:.-]+$', description: 'Reuse the same ID only for exactly the same request. Query receipt after timeout; never retry with a new ID.' };
const scriptPatch = { fileId: { type: 'string' }, expectedRevision: { type: 'string' },
  edits: { type: 'array', minItems: 1, maxItems: 64, items: { type: 'object', properties: {
    index: { type: 'integer', minimum: 0 }, deleteCount: { type: 'integer', minimum: 0 }, text: { type: 'string', maxLength: 500000 },
  }, required: ['index','deleteCount','text'], additionalProperties: false } },
};

const checkedScriptPatch = { ...scriptPatch, policy: { type: 'string', enum: ['strict', 'no-new-errors'],
  description: 'Default strict requires a clean project. Explicit no-new-errors compares complete error multisets to the current snapshot. Inspect accepted separately from clean/passed.' } };

export function buildAuthoringTools(client, config) {
  const call = (name, properties, required, tool, write = false, description) => ({
    name,
    description: description || `${write ? 'Modify' : 'Read'} authoritative map content through the runtime. No camera movement or per-voxel pacing required. ${write ? 'Changes remain in memory until saved. Durable historical receipts prevent replay after restart but do not prove unsaved map content survived.' : ''}`,
    inputSchema: { type: 'object', properties: { projectId, ...properties }, required, additionalProperties: false },
    annotations: annotations(write),
    handler: async ({ projectId, operationId, ...args }) => {
      if (write && !config.allowWrite) throw Object.assign(new Error('Writes disabled'), { code: 'WRITE_DISABLED' });
      const data = await client.mapAuthoring(tool, args, { projectId, operationId });
      return { summary: name, data };
    },
  });
  return [
    ...['status', 'save', 'preview'].map(action => ({
      name: `map_runtime_${action}`,
      description: action === 'save' ? 'Save authoritative map content. Refuses while preview is running; stop preview first. Does not require an editor tab.' : action === 'preview' ? 'Start or stop the runtime preview, independently of browser camera and cursor.' : 'Read authoritative preview runtime status.',
      inputSchema: { type: 'object', properties: { projectId, ...(action === 'preview' ? { action: { type: 'string', enum: ['start', 'stop'] } } : {}) }, required: action === 'preview' ? ['action'] : [], additionalProperties: false },
      annotations: annotations(action !== 'status'),
      handler: async ({ projectId, ...body }) => {
        if (action !== 'status' && !config.allowWrite) throw Object.assign(new Error('Writes disabled'), { code: 'WRITE_DISABLED' });
        return { summary: `Runtime ${action}`, data: await client.mapRuntimeAction(action, body, projectId) };
      },
    })),
    call('map_context', {}, [], 'authoringContext'),
    call('map_ui_nodes', {ids:{type:'array',maxItems:256,items:{type:'string'}},offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:256}}, [], 'uiContext', false,
      'Read bounded authoritative UI elements/screens and UI revision. For property-only proposals; root and unavailable IDs are excluded.'),
    call('map_propose_ui', {expectedRevision:{type:'string'},patches:{type:'array',minItems:1,maxItems:64,items:{type:'object',properties:{nodeId:{type:'string'},properties:{type:'object',minProperties:1,
      description:'Existing element properties: positionOffset/positionRatio/sizeOffset/sizeRatio [x,y], anchor [0..1,0..1], visible, backgroundColor/textColor RGB 0..255, backgroundOpacity/textOpacity 0..1, textContent, textFontSize 1..255. Runtime strictly validates supported properties and real quantized schema.'}},required:['nodeId','properties'],additionalProperties:false}}}, ['expectedRevision','patches'], 'authoringProposeUi', false,
      'Prepare UI property edits with exact preview and durable inverse. Preserves IDs, names, node kinds, hierarchy, image references and scripts. Refuses absolute position under auto-layout. Apply/revert through shared proposals; save separately. No lifecycle or visual correctness claim.'),
    call('map_scripts', {}, [], 'listScripts'),
    call('map_entities', { ids: { type: 'array', maxItems: 256, items: { type: 'string' } }, offset: { type: 'integer', minimum: 0 },
      limit: { type: 'integer', minimum: 1, maximum: 256 } }, [], 'entityContext', false,
      'Read bounded existing entity nodes and their authoritative entity/asset revision. Use IDs for localized edits; full transform, parent and model references are retained.'),
    call('map_script_read', { fileId: { type: 'string' } }, ['fileId'], 'readScript'),
    call('map_script_preview', scriptPatch, ['fileId','expectedRevision','edits'], 'scriptPreview', false,
      'Read-only preview against the readScript revision. Edits use original-source UTF-16 offsets. Returns candidate content and changed ranges; does not apply or typecheck.'),
    call('map_script_check', checkedScriptPatch, ['fileId','expectedRevision','edits'], 'scriptCheck', false,
      'Check candidate syntax, TypeScript semantics and UI bindings in a bounded worker against live project snapshots. Inspect check.available, check.passed, sourceStillMatches and dependenciesStillMatch. Successful transport is not a passing/current check. Does not apply or execute scripts.'),
    call('map_terrain_state', {}, [], 'terrainInfo'),
    call('map_terrain_read', { region: { type: 'object', properties: { min: { type: 'array', items: { type: 'integer' }, minItems: 3, maxItems: 3 }, max: { type: 'array', items: { type: 'integer' }, minItems: 3, maxItems: 3 } }, required: ['min','max'], additionalProperties: false }, limit: { type: 'integer', minimum: 1, maximum: 200000 } }, ['region'], 'terrainRead'),
    call('map_blocks', { limit: { type: 'integer', minimum: 1, maximum: 500 }, offset: { type: 'integer', minimum: 0 } }, [], 'blockCatalog'),
    call('map_authoring_events', { after: { type: 'integer', minimum: 0 } }, [], 'authoringEvents'),
    call('map_authoring_history', { limit: { type: 'integer', minimum: 1, maximum: 1000 } }, [], 'authoringHistory'),
    call('map_proposal_status', { proposalId: { type: 'string' } }, ['proposalId'], 'authoringProposal'),
    call('map_propose', { expectedRevision: { type: 'string' }, steps: { type: 'array', minItems: 1, maxItems: 64, items: { type: 'object', properties: { tool: { type: 'string', enum: ['terrainApply'] }, args: { type: 'object' } }, required: ['tool','args'], additionalProperties: false } } }, ['steps'], 'authoringPropose'),
    call('map_propose_script', checkedScriptPatch, ['fileId','expectedRevision','edits'], 'authoringProposeScript', false,
      'Prepare a script proposal without modifying source. Runs isolated type/UI checks and stores inverse edits locally. Apply/revert with map_apply_proposal/map_revert_proposal; save separately. Shared scripts require an existing editor lock.'),
    call('map_propose_entity_lifecycle', { expectedRevision: { type: 'string' }, operations: { type: 'array', minItems: 1, maxItems: 16, items: { type: 'object', properties: {
      op: { type: 'string', enum: ['create', 'delete', 'move'] },
      entityId: { type: 'string' }, parentId: { type: 'string' }, name: { type: 'string', maxLength: 32 },
      position: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
      scale: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
      orientation: { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4 },
      tint: { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4 },
      mesh: { type: 'string' }, tags: { type: 'array', items: { type: 'string' }, maxItems: 64 },
      subtree: { type: 'boolean', description: 'Required to delete a node that has children; deletes the whole branch.' },
    }, required: ['op'], additionalProperties: false } } }, ['expectedRevision', 'operations'], 'authoringProposeEntityLifecycle', false,
      'Prepare entity create / delete / reparent with full-node (or full-subtree) inverse, entity/asset CAS and edit-lock checks. Deleting a branch requires subtree:true; the scene root, cycles and non-model meshes are refused. Apply/revert through shared proposals; save separately.'),
    call('map_propose_entities', { expectedRevision: { type: 'string' }, patches: { type: 'array', minItems: 1, maxItems: 64,
      items: { type: 'object', properties: { entityId: { type: 'string' }, properties: { type: 'object', minProperties: 1,
        description: 'Supported keys: name, tags, position [x,y,z], scale [x,y,z], normalized orientation [x,y,z,w], tint [r,g,b,a], mesh, collision, gravity, fixed, staticShadow, mass, friction, restitution, metalness, shininess, emissive. Runtime validates exact types and ranges; unknown keys are refused.' } }, required: ['entityId', 'properties'], additionalProperties: false } } },
      ['expectedRevision', 'patches'], 'authoringProposeEntities', false,
      'Prepare property changes to existing entity IDs. Preserves IDs/hierarchy; respects edit locks, validates model references and stores exact inverse data. Apply checks source revision after acquiring the project mutex. Does not add/delete/reparent or save.'),
    call('map_apply_proposal', { proposalId: { type: 'string' }, operationId }, ['proposalId','operationId'], 'authoringApply', true),
    call('map_discard_proposal', { proposalId: { type: 'string' }, operationId }, ['proposalId','operationId'], 'authoringDiscard', true,
      'Discard only an unapplied/expired draft. Does not change map content or undo applied changes. Keeps review/history; cannot discard applied, partial or unknown proposals.'),
    call('map_revert_proposal', { proposalId: { type: 'string' }, operationId }, ['proposalId','operationId'], 'authoringRevert', true),
    call('map_propose_plan', { proposalIds: { type: 'array', minItems: 1, maxItems: 16, items: { type: 'string' } } }, ['proposalIds'], 'authoringProposePlan', false,
      'Group already-proposed content proposals (at most one per domain) into one reviewable plan. Applying writes in order and compensates on failure; this is not a cross-domain transaction. Does not change content.'),
    call('map_plan_status', { planId: { type: 'string' } }, ['planId'], 'authoringPlan', false,
      'Read plan status, applied count and each member proposal status. No inverse data returned.'),
    call('map_plans', { limit: { type: 'integer', minimum: 1, maximum: 50 } }, [], 'authoringPlans', false,
      'List plans created in this runtime newest first, with their domains and status.'),
    call('map_apply_plan', { planId: { type: 'string' }, operationId }, ['planId','operationId'], 'authoringApplyPlan', true,
      'Apply a plan after re-checking every member revision. A failing member compensates the members already applied; inspect before retrying. Save separately.'),
    call('map_revert_plan', { planId: { type: 'string' }, operationId }, ['planId','operationId'], 'authoringRevertPlan', true,
      'Revert an applied plan in reverse order. Refuses when any member domain changed afterwards. Save separately.'),
    call('map_discard_plan', { planId: { type: 'string' }, operationId }, ['planId','operationId'], 'authoringDiscardPlan', true,
      'Discard an unapplied plan and its drafts. Applied plans must be reverted instead; content is not modified.'),
    {
      name: 'map_operation_status', description: 'Query your own operation receipt after timeout. Not found after runtime restart does not prove a write never happened.',
      inputSchema: { type: 'object', properties: { operationId, projectId }, required: ['operationId'], additionalProperties: false }, annotations: annotations(false),
      handler: async args => ({ summary: 'Operation receipt', data: await client.mapAuthoringOperation(args.operationId, args.projectId) }),
    },
  ];
}
