/**
 * THE WIRING HUB for the write domains (P0-A).
 *
 * Before this file existed, the seven domain modules below were orphan code:
 * `src/server.js` and `src/index.js` imported only `../tools.js`, so `tools/list`
 * advertised the 12 slice-A tools and `tools/call` could never reach a domain
 * tool — the ~25 `terrain_* / entity_* / model_* / ui_* / script_* / map_*` names
 * were unreachable from the protocol. This module is the single place that
 * assembles them, and `mergeToolSets()` is the place that makes a duplicate
 * registration impossible instead of merely unlikely (`byName` in server.js is
 * built with a Map, so a second tool of the same name would silently shadow the
 * first — the worst possible failure mode for a face a model depends on).
 *
 * Domain -> engine source of truth (all read directly, see _shared.js
 * ENGINE_AI_TOOLS for the line numbers):
 *   terrain.js   createMapAuthoringTools: terrainInfo/terrainRead/terrainApply/terrainRevert
 *   entity.js    createEntityTools:       createEntity/deleteEntity/updateEntity/listEntities/
 *                                         moveEntity/copyEntities/createEntityFromModel
 *   model.js     createEntityTools:       getProjectModels/searchPublicModels/addModelToProject
 *   ui.js        createMapAuthoringTools: uiTreeRead/uiNodeAdd/uiNodeRemove
 *   script.js    createScriptTools:       listScripts/readScript/updateScript/createScript/deleteScript
 *   map-ops.js   the Next internal surface: status / tool catalog / preview / save
 */
import { buildTerrainTools } from './terrain.js'
import { buildEntityTools } from './entity.js'
import { buildModelTools } from './model.js'
import { buildUiTools } from './ui.js'
import { buildScriptRuntimeTools } from './script.js'
import { buildMapOpsTools } from './map-ops.js'
import { WRITE_TOOL_NAMES } from './_shared.js'

export {
  ENGINE_AI_TOOLS,
  ENGINE_TOOLS_USED,
  ENGINE_TOOL_FOR_MCP_TOOL,
  WRITE_TOOL_NAMES,
} from './_shared.js'

const DOMAINS = [
  ['terrain', buildTerrainTools],
  ['entity', buildEntityTools],
  ['model', buildModelTools],
  ['ui', buildUiTools],
  ['script-runtime', buildScriptRuntimeTools],
  ['map-ops', buildMapOpsTools],
]

/**
 * @throws if any domain module registers a name twice, or collides with the
 * slice-A face — checked at build time (before the first tools/list), never at
 * call time.
 */
export function mergeToolSets(sets) {
  const merged = []
  const seen = new Map()
  for (const tools of sets) {
    for (const tool of tools) {
      if (!tool || typeof tool.name !== 'string' || typeof tool.handler !== 'function') {
        const problem = `工具声明不完整：${JSON.stringify({ name: tool && tool.name, hasHandler: typeof (tool && tool.handler) })}`
        throw new Error(problem)
      }
      if (seen.has(tool.name)) {
        throw new Error(`重名注册：工具 "${tool.name}" 同时来自 ${seen.get(tool.name)} 和 ${tool.domain || '?'}`)
      }
      seen.set(tool.name, tool.domain || 'base')
      merged.push(tool)
    }
  }
  return merged
}

/** All domain tools, each tagged with its domain for diagnostics. */
export function buildDomainTools(ctx) {
  const out = []
  for (const [domain, build] of DOMAINS) {
    for (const tool of build(ctx)) out.push({ ...tool, domain })
  }
  return out
}

export function domainNames() {
  return DOMAINS.map(([name]) => name)
}

/** A tool is a writer if the guard layer says so, or if it is slice-A's writer. */
export function isWriteTool(name) {
  return WRITE_TOOL_NAMES.has(name) || name === 'script_write'
}
