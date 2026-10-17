/**
 * Runtime configuration for the map MCP. Everything comes from environment
 * variables so that the client registration JSON stays credential-free:
 * the AI host never has to put a token on a command line.
 */
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const inferredRepoRoot = path.resolve(packageRoot, '..', '..')

const CREATOR_API_PREFIX = '/api/creator/v1'
const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/
const MAP_IDENTITY_PATTERN = /^[0-9a-f]{20}$/

function int(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback
}

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback
  return !['0', 'false', 'no', 'off'].includes(String(value).toLowerCase())
}

export function loadConfig(env = process.env) {
  const baseUrl = (env.BOX_CREATOR_BASE_URL || 'http://127.0.0.1:3127').replace(/\/+$/, '')
  const token = (env.BOX_CREATOR_CLI_TOKEN || '').trim()
  return {
    packageRoot,
    repoRoot: env.BOX_ENGINE_REPO_ROOT
      ? path.resolve(env.BOX_ENGINE_REPO_ROOT)
      : inferredRepoRoot,
    creatorBaseUrl: baseUrl,
    creatorApiPrefix: CREATOR_API_PREFIX,
    cliToken: token,
    /**
     * Readable copy of the engine's local project directory. When present the
     * MCP can resolve `branch.headHash` offline, which is the only
     * engine-authoritative revision token available without a scope extension.
     */
    projectsRoot: env.BOX_MAP_PROJECTS_ROOT ? path.resolve(env.BOX_MAP_PROJECTS_ROOT) : '',
    profile: env.BOX_MCP_PROFILE === 'readonly' ? 'readonly' : 'authoring',
    allowWrite: bool(env.BOX_MCP_ALLOW_WRITE, true),
    timeoutMs: int(env.BOX_MCP_TIMEOUT_MS, 20_000),
    sseIdleMs: int(env.BOX_MCP_SSE_IDLE_MS, 1_500),
    sseTimeoutMs: int(env.BOX_MCP_SSE_TIMEOUT_MS, 15_000),
    typeGate: ['auto', 'language-service', 'syntax', 'off'].includes(env.BOX_MCP_TYPEGATE)
      ? env.BOX_MCP_TYPEGATE
      : 'auto',
    typescriptEntry: env.BOX_TYPESCRIPT_ENTRY ? path.resolve(env.BOX_TYPESCRIPT_ENTRY) : '',
    projectIdPattern: PROJECT_ID_PATTERN,
    mapIdentityPattern: MAP_IDENTITY_PATTERN,
  }
}

/** `/api/creator/v1` path builder; mirrors `creatorApiPath` in `@box/cli`. */
export function apiPath(config, ...segments) {
  return [
    config.creatorApiPrefix,
    ...segments.map((segment) => encodeURIComponent(String(segment))),
  ].join('/')
}
