/**
 * Test double for the LOOPBACK map-authoring surface — the half of the engine
 * the write domains talk to:
 *
 *   Next routes   apps/game/pages/api/internal/map-authoring/[projectId]/
 *                   status.ts   GET  -> {projectId, runtimeActive, preview, headlessWriteRoute}
 *                   preview.ts  POST -> forwards {action:'start'|'stop'}, 400 INVALID_ACTION
 *                   save.ts     POST -> 409 PREVIEW_RUNNING unless force, else {permissionHash}
 *                   tool.ts     GET|POST -> pre-checks the runtime, 409 RUNTIME_NOT_ACTIVE,
 *                                 then forwards {tool, args} to the runtime
 *   runtime       services/game-server/src/edit/ai/ai-tool-route.ts
 *                   loopback gate, GET -> {tools:[{name,description}], usage}
 *                   POST -> zod safeParse (400 TOOL_ARGS_INVALID) -> tool.execute
 *                        -> 200 {tool, result} | 409 for PREVIEW_RUNNING /
 *                           REVISION_CONFLICT | 400 UNKNOWN_TOOL{available} |
 *                           501 TOOL_NOT_EXECUTABLE | 413 | 500
 *   tools         createMapAuthoringTools (terrainInfo/terrainRead/terrainApply/
 *                 terrainRevert/uiTreeRead/uiNodeAdd/uiNodeRemove) +
 *                 createEntityTools (the 10 entity/model tools). The 5 script
 *                 tools are NOT mounted there (ai-tool-route.ts:78-91), which is
 *                 exactly why this double answers 400 UNKNOWN_TOOL for them.
 *
 * Result shapes, refusal codes, refusal ORDER (revision check before preview
 * check, as in map-authoring-tools.ts:263-280) and the packed-uint16 voxel
 * semantics are copied from the engine source. In-memory state only; this
 * process binds 127.0.0.1 on an ephemeral port and writes nothing to disk.
 */
import { createHash } from 'node:crypto'

/** VOXEL_TYPE_MASK / VOXEL_ROTATION_SHIFT (internals/schema/voxel/voxel-protocol.ts:14-15) */
const VOXEL_TYPE_MASK = 0x3fff
const VOXEL_ROTATION_SHIFT = 14
const MAX_TERRAIN_CELLS = 500_000
const LIST_ENTITIES_ECHO = 50

const ENTITY_TOOLS = [
  'createEntity',
  'deleteEntity',
  'updateEntity',
  'listEntities',
  'moveEntity',
  'copyEntities',
  'getProjectModels',
  'searchPublicModels',
  'addModelToProject',
  'createEntityFromModel',
]
const AUTHORING_TOOLS = [
  'terrainInfo',
  'terrainRead',
  'terrainApply',
  'terrainRevert',
  'uiTreeRead',
  'uiNodeAdd',
  'uiNodeRemove',
]
/** Declared on the router but without `execute` (entity-tools.ts:676-683). */
const NO_EXECUTE = new Set(['addModelToProject'])
const MOUNTED = [...AUTHORING_TOOLS, ...ENTITY_TOOLS]

function digest(parts) {
  return createHash('sha256').update(parts.join('|'), 'utf8').digest('hex').slice(0, 16)
}

export function createAuthoringSim(options = {}) {
  const shape = options.shape || [4, 4, 4]
  const voxels = new Map()
  const entities = new Map()
  const uiNodes = new Map()
  const models = new Map(Object.entries(options.models || {}))
  const state = {
    previewRunning: options.previewRunning === true,
    /** Lets a test model "the human editor typed something" between read and write. */
    externalNonce: 0,
    saved: 0,
    lastSaveForced: false,
    calls: [],
    permissionHash: options.permissionHash || 'QmMOCKPERMISSIONHASHAAAAAAAAAAAAAAAAAAAA',
  }
  let nextEntityId = 100
  let nextUiId = 500

  for (const [entry, seed] of Object.entries(options.entities || {})) {
    entities.set(String(seed.id ?? entry), {
      id: String(seed.id ?? entry),
      name: seed.name ?? entry,
      parentId: seed.parentId,
      mesh: seed.mesh,
      position: seed.position || [0, 0, 0],
    })
  }
  for (const node of options.uiNodes || []) uiNodes.set(String(node.id), { ...node })

  const terrainRevision = () => {
    const rows = [...voxels.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
    return digest(['terrain', shape.join(','), String(state.externalNonce), rows.map(([k, v]) => `${k}=${v}`).join(',')])
  }
  const uiRevision = () => {
    const rows = [...uiNodes.values()]
      .sort((a, b) => (String(a.id) < String(b.id) ? -1 : 1))
      .map((node) => `${node.id}:${node.type}:${(node.childrenIds || []).length}:${node.parentId || ''}`)
    return digest(['ui', String(state.externalNonce), rows.join(',')])
  }
  const entityRevision = () => {
    const rows = [...entities.values()]
      .sort((a, b) => (String(a.id) < String(b.id) ? -1 : 1))
      .map((node) => `${node.id}:${node.name}:${node.parentId || ''}:${node.mesh || ''}:${(node.position || []).join(',')}`)
    return digest(['entity', String(state.externalNonce), rows.join(',')])
  }

  const clampRegion = (region) => {
    const min = [0, 1, 2].map((i) => Math.max(0, Math.trunc(region.min[i])))
    const max = [0, 1, 2].map((i) => Math.min(shape[i] - 1, Math.trunc(region.max[i])))
    const cells = []
    for (let x = min[0]; x <= max[0]; x += 1) {
      for (let y = min[1]; y <= max[1]; y += 1) {
        for (let z = min[2]; z <= max[2]; z += 1) cells.push([x, y, z])
      }
    }
    return cells
  }
  const encodeBlock = (block, rotation) => {
    const typeBits = block & VOXEL_TYPE_MASK
    if (rotation === undefined) return typeBits
    return typeBits | ((rotation & 0x3) << VOXEL_ROTATION_SHIFT)
  }

  const refused = (code, error, extra = {}) => ({ status: 200, body: { success: false, code, error, ...extra } })

  const tools = {
    terrainInfo: () => ({
      status: 200,
      body: {
        success: true,
        shape,
        previewRunning: state.previewRunning,
        revision: terrainRevision(),
      },
    }),
    terrainRead: ({ region, limit = 20_000 }) => {
      const cells = clampRegion(region)
      return {
        status: 200,
        body: {
          success: true,
          total: cells.length,
          truncated: cells.length > limit,
          cells: cells.slice(0, limit).map(([x, y, z]) => ({ x, y, z, b: voxels.get(`${x},${y},${z}`) ?? 0 })),
          revision: terrainRevision(),
        },
      }
    },
    terrainApply: ({ region, block, rotation, expectedRevision, allowWhileRunning = false, dryRun = false }) => {
      const current = terrainRevision()
      // ORDER copied from map-authoring-tools.ts:263-280 — revision first.
      if (expectedRevision && expectedRevision !== current) {
        return {
          status: 409,
          body: { success: false, code: 'REVISION_CONFLICT', error: 'terrain changed since read; re-read then retry', currentRevision: current },
        }
      }
      if (state.previewRunning && !allowWhileRunning) {
        return {
          status: 409,
          body: {
            success: false,
            code: 'PREVIEW_RUNNING',
            error:
              '预览正在运行：保存时不会记录体素 chunk（replica-server.ts:1602）。' +
              '请先停止预览再写入并保存，或传 allowWhileRunning=true 仅改内存态。',
          },
        }
      }
      const cells = clampRegion(region)
      if (!cells.length) return { status: 200, body: { success: false, code: 'EMPTY_REGION', error: 'region resolves to zero in-bounds cells' } }
      if (cells.length > MAX_TERRAIN_CELLS) {
        return { status: 200, body: { success: false, code: 'TOO_LARGE', error: 'region exceeds 500000 cells' } }
      }
      const b = encodeBlock(block, rotation)
      const changes = []
      for (const [x, y, z] of cells) {
        const key = `${x},${y},${z}`
        changes.push({ x, y, z, prev: voxels.get(key) ?? 0 })
        if (!dryRun) voxels.set(key, b)
      }
      return {
        status: 200,
        body: {
          success: true,
          dryRun,
          changed: changes.length,
          block: b,
          newRevision: terrainRevision(),
          undoToken: JSON.stringify(changes),
          persistWarning:
            state.previewRunning && allowWhileRunning
              ? 'In-memory only: stop the preview before save to persist voxel chunk hashes.'
              : undefined,
        },
      }
    },
    terrainRevert: ({ undoToken }) => {
      let changes
      try {
        changes = JSON.parse(undoToken)
      } catch (error) {
        return { status: 200, body: { success: false, error: `Unexpected token in JSON: ${error.message}` } }
      }
      if (!Array.isArray(changes)) return { status: 200, body: { success: false, error: 'Invalid undo token' } }
      let restored = 0
      for (const c of changes) {
        if (c.x < 0 || c.y < 0 || c.z < 0 || c.x >= shape[0] || c.y >= shape[1] || c.z >= shape[2]) continue
        voxels.set(`${c.x},${c.y},${c.z}`, c.prev | 0)
        restored += 1
      }
      return { status: 200, body: { success: true, restored, newRevision: terrainRevision() } }
    },

    listEntities: () => {
      const rows = [...entities.values()]
      return {
        status: 200,
        body: { entities: rows.slice(0, LIST_ENTITIES_ECHO), total: rows.length, note: 'Showing first 50 entities' },
      }
    },
    createEntity: ({ name, parentId, position, mesh }) => {
      const entityId = String(nextEntityId++)
      entities.set(entityId, { id: entityId, name, parentId, mesh, position })
      return { status: 200, body: { success: true, entityId, message: `Entity '${name}' created with ID ${entityId}` } }
    },
    createEntityFromModel: ({ modelId, name, parentId, position }) => {
      const model = [...models.entries()].find(([, value]) => value.modelId === modelId)
      if (!model) {
        return { status: 200, body: { success: false, error: `Failed to retrieve model metadata for ${modelId}` } }
      }
      const entityId = String(nextEntityId++)
      entities.set(entityId, {
        id: entityId,
        name: name || model[0],
        parentId,
        mesh: `mesh/${model[0]}.vb`,
        position: position || [0, 0, 0],
        meshId: modelId,
      })
      return { status: 200, body: { success: true, entityId, message: `Entity '${name || model[0]}' created from model ${modelId}` } }
    },
    updateEntity: ({ entityId, properties }) => {
      const node = entities.get(String(entityId))
      if (!node) return { status: 200, body: { success: false, error: `Entity ${entityId} not found` } }
      Object.assign(node, properties || {})
      return { status: 200, body: { success: true, message: `Entity ${entityId} updated` } }
    },
    moveEntity: ({ entityId, position }) => {
      const node = entities.get(String(entityId))
      if (!node) return { status: 200, body: { success: false, error: `Entity ${entityId} not found` } }
      node.position = position
      return { status: 200, body: { success: true, message: `Entity ${entityId} moved to ${position}` } }
    },
    deleteEntity: ({ entityIds }) => {
      for (const id of entityIds || []) entities.delete(String(id))
      return { status: 200, body: { success: true, message: `Entities ${(entityIds || []).join(', ')} deleted` } }
    },
    copyEntities: ({ entityIds }) => {
      const newEntityIds = []
      for (const id of entityIds || []) {
        const node = entities.get(String(id))
        if (!node) continue
        const copyId = String(nextEntityId++)
        entities.set(copyId, { ...node, id: copyId, name: `${node.name} copy` })
        newEntityIds.push(copyId)
      }
      return {
        status: 200,
        body: { success: true, message: `Entities ${(entityIds || []).join(', ')} copied`, newEntityIds },
      }
    },
    getProjectModels: ({ limit = 20, offset = 0, modelName }) => {
      let rows = [...models.keys()].map((name) => ({ id: models.get(name).modelId, name }))
      if (modelName) rows = rows.filter((row) => row.name.toLowerCase().includes(String(modelName).toLowerCase()))
      return { status: 200, body: { success: true, models: rows.slice(offset, offset + limit), total: rows.length } }
    },
    searchPublicModels: () => ({
      status: 200,
      body: { success: true, models: [], total: 0, message: 'Public model search is unavailable in the local engine.' },
    }),
    // Declared without `execute`: the router answers 501 (ai-tool-route.ts:167-173).
    addModelToProject: () => ({
      status: 501,
      body: { code: 'TOOL_NOT_EXECUTABLE', message: 'tool "addModelToProject" has no server-side execute' },
    }),

    uiTreeRead: () => {
      const nodes = [...uiNodes.values()]
      return { status: 200, body: { success: true, nodes, total: nodes.length, revision: uiRevision() } }
    },
    uiNodeAdd: ({ parentId, name, nodeType, data, expectedRevision }) => {
      const current = uiRevision()
      if (expectedRevision && expectedRevision !== current) {
        return {
          status: 409,
          body: { success: false, code: 'REVISION_CONFLICT', error: 'UI tree changed since read; re-read then retry', currentRevision: current },
        }
      }
      const nodeId = String(nextUiId++)
      uiNodes.set(nodeId, { id: nodeId, name, parentId: parentId || 'DEFAULT_SCREEN_ID', type: nodeType, childrenIds: [], value: { type: nodeType, data } })
      return { status: 200, body: { success: true, nodeId, newRevision: uiRevision() } }
    },
    uiNodeRemove: ({ nodeIds }) => {
      for (const id of nodeIds || []) uiNodes.delete(String(id))
      return { status: 200, body: { success: true, newRevision: uiRevision() } }
    },
  }

  /** Argument checks the real router would do with zod (`400 TOOL_ARGS_INVALID`). */
  function validateArgs(name, args) {
    const issues = []
    const badTriple = (value) => !Array.isArray(value) || value.length !== 3 || value.some((n) => !Number.isInteger(n) || n < 0)
    if (name === 'terrainApply' || name === 'terrainRead') {
      if (!args.region || badTriple(args.region.min) || badTriple(args.region.max)) {
        issues.push({ path: ['region'], code: 'custom', message: 'region.min / region.max must be integer tuples of length 3' })
      }
      if (name === 'terrainApply' && !Number.isInteger(args.block)) {
        issues.push({ path: ['block'], code: 'invalid_type', message: 'block must be an integer' })
      }
      if (name === 'terrainApply' && typeof args.expectedRevision !== 'string') {
        issues.push({ path: ['expectedRevision'], code: 'invalid_type', message: 'expectedRevision is required' })
      }
    }
    if (name === 'createEntity' && typeof args.name !== 'string') {
      issues.push({ path: ['name'], code: 'invalid_type', message: 'name is required' })
    }
    return issues
  }

  function callTool(name, args) {
    state.calls.push(name)
    if (!Object.prototype.hasOwnProperty.call(tools, name)) {
      return { status: 400, body: { code: 'UNKNOWN_TOOL', message: `unknown or unavailable tool: "${name}"`, available: MOUNTED } }
    }
    const issues = validateArgs(name, args || {})
    if (issues.length) return { status: 400, body: { code: 'TOOL_ARGS_INVALID', message: `invalid args for tool "${name}"`, issues } }
    if (NO_EXECUTE.has(name)) return tools[name](args || {})
    return tools[name](args || {})
  }

  return {
    state,
    mounted: MOUNTED,
    callTool,
    revision: { terrain: terrainRevision, entity: entityRevision, ui: uiRevision },
    /** Test hook: pretend the human editor / another agent touched the map. */
    mutateExternally() {
      state.externalNonce += 1
    },
    setPreviewRunning(value) {
      state.previewRunning = value === true
    },
    entities,
    uiNodes,
    models,
    /** GET .../status — verbatim shape of status.ts, including its stale field. */
    status() {
      return {
        status: 200,
        body: {
          projectId: options.projectId || 'mock-map',
          runtimeActive: options.runtimeActive !== false,
          preview: {
            phase: state.previewRunning ? 'running' : 'idle',
            running: state.previewRunning,
            message: state.previewRunning ? '预览运行中' : '预览已停止',
            updatedAt: new Date().toISOString(),
          },
          headlessWriteRoute: 'unavailable',
          headlessWriteRouteReason:
            'terrain/ui AI tools exist server-side but no runtime /internal HTTP route to invoke them headlessly (createServer.ts is out of the C4 lane).',
        },
      }
    },
    /** POST .../preview — preview.ts: only start|stop reaches the runtime. */
    preview(action) {
      if (action !== 'start' && action !== 'stop') {
        return { status: 400, body: { code: 'INVALID_ACTION', message: 'action 必须为 start 或 stop' } }
      }
      state.previewRunning = action === 'start'
      return {
        status: 200,
        body: {
          phase: state.previewRunning ? 'running' : 'idle',
          running: state.previewRunning,
          message: state.previewRunning ? '预览运行中' : '预览已停止',
          updatedAt: new Date().toISOString(),
        },
      }
    },
    /** POST .../save — save.ts refuses while the preview runs unless forced. */
    save({ force = false } = {}) {
      if (!force && state.previewRunning) {
        return {
          status: 409,
          body: {
            code: 'PREVIEW_RUNNING',
            message:
              '预览仍在运行：保存不会记录体素 chunk（replica-server.ts:1602）。' +
              '请先调用 .../preview {action:"stop"} 再保存，或传 force:true 强制保存。',
          },
        }
      }
      state.saved += 1
      state.lastSaveForced = force === true
      return { status: 200, body: { permissionHash: state.permissionHash, saved: true } }
    },
    toolCatalog() {
      return {
        status: 200,
        body: {
          tools: MOUNTED.map((name) => ({ name, description: `mock ${name}` })),
          usage:
            'POST {tool, args}. Terrain/UI writes keep the C4 semantics: expectedRevision optimistic lock, ' +
            'undoToken rollback via terrainRevert, PREVIEW_RUNNING refused while a live preview runs ' +
            '(replica-server.ts:1602). Persist afterwards with the existing /internal/save-local-project path.',
        },
      }
    },
    runtimeNotActive() {
      return options.runtimeActive === false
    },
  }
}
