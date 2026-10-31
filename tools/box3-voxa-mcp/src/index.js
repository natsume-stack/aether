#!/usr/bin/env node
/**
 * box3-voxa-mcp — VOXA 模型构建 MCP（识别码体系·模型作用域）。
 *
 * 5 个工具：
 *   voxa_health          引擎可达性探测（只读）
 *   voxa_model_list      列出工作区已有模型
 *   voxa_model_inspect   本地解码 .voxaproject：统计 + 门禁 + dataHash 绑定校验（导入前 lint）
 *   voxa_model_import    把 bundle 导入 VOXA 工作区（识别码令牌）
 *   voxa_artifact_register   登记产物到 Agent Active 面板
 *
 * 身份：BOX_VOXA_AGENT_TOKEN（agx_ 令牌）或 BOX_VOXA_AGENT_CODE（VOX- 识别码，
 * 首次调用自动 join 换令牌，进程内持有）。stdio JSON-RPC 四方法，无第三方依赖
 * （jszip/@box/voxa-project 仅在 model_inspect 用，从 VOXA_ROOT 解析）。
 *
 * 协议面与 tools/box3-map-mcp 同风格：{ code, retryable, hint } 错误契约。
 */
import process from 'node:process'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { pathToFileURL } from 'node:url'
import { inspectProjectSource, inspectResourceIntegrity } from './bundle-integrity.js'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function loadConfig(env = process.env) {
  return {
    baseUrl: (env.BOX_VOXA_BASE_URL || 'http://127.0.0.1:3123').replace(/\/+$/, ''),
    agentCode: (env.BOX_VOXA_AGENT_CODE || '').trim(),
    agentToken: (env.BOX_VOXA_AGENT_TOKEN || '').trim(),
    agentName: (env.BOX_VOXA_AGENT_NAME || 'voxa-mcp').trim().slice(0, 60),
    voxaRoot: env.VOXA_ROOT || path.resolve(packageRoot, '..', '..', 'apps', 'voxa'),
  }
}

/* ---------------- 错误契约 ---------------- */
const HINTS = {
  VOXA_UNREACHABLE: { retryable: false, hint: 'VOXA(:3123) 没起或 BOX_VOXA_BASE_URL 不对；先起 VOXA 再 curl 基址。' },
  AGENT_AUTH_REQUIRED: { retryable: false, hint: '令牌无效/被吊销：换新识别码（BOX_VOXA_AGENT_CODE）或重新签发 agx_ 令牌。' },
  INVALID_CODE: { retryable: false, hint: '识别码不对或已轮换：去 VOXA 页面 Agent Active 面板重新复制当前码。' },
  FILE_NOT_FOUND: { retryable: false, hint: 'model_import 的 file 参数必须是已存在的 .voxaproject 绝对路径。' },
  GATE_FAILED: { retryable: true, hint: '先跑 voxa_model_inspect 修门禁项（palette/usedColors/rects/texels），再导入。' },
  VOXA_REJECTED: { retryable: false, hint: '引擎校验链拒绝（见 detail）；用 voxa_model_inspect 本地解码定位。' },
}
const fail = (code, message, extra = {}) => ({ isError: true, content: [{ type: 'text', text: JSON.stringify({ code, retryable: HINTS[code]?.retryable ?? false, hint: HINTS[code]?.hint || '', message, ...extra }, null, 2) }] })
const ok = (payload) => ({ content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] })

/* ---------------- HTTP + 身份 ---------------- */
async function api(config, token, method, pathname, { body, raw } = {}) {
  let res
  try {
    res = await fetch(`${config.baseUrl}${pathname}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(raw ? { 'Content-Type': 'application/octet-stream' } : body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: raw ?? (body ? JSON.stringify(body) : undefined),
      signal: AbortSignal.timeout(60_000),
    })
  } catch (error) {
    throw Object.assign(new Error(`VOXA 不可达: ${error.message}`), { code: 'VOXA_UNREACHABLE' })
  }
  const text = await res.text()
  let data = null
  try { data = JSON.parse(text) } catch { data = { raw: text.slice(0, 400) } }
  if (res.status === 401) throw Object.assign(new Error(data?.message || '需要有效 agent 令牌'), { code: 'AGENT_AUTH_REQUIRED' })
  return { status: res.status, data }
}

async function resolveToken(config, state) {
  if (config.agentToken) return config.agentToken
  if (state.token) return state.token
  if (!config.agentCode) {
    throw Object.assign(new Error('未配置身份：设 BOX_VOXA_AGENT_TOKEN 或 BOX_VOXA_AGENT_CODE'), { code: 'AGENT_AUTH_REQUIRED' })
  }
  const { status, data } = await api(config, '', 'POST', '/api/agent/v1/join', {
    body: { code: config.agentCode, name: config.agentName },
  })
  if (status !== 201 || !data?.token) {
    throw Object.assign(new Error(data?.message || `join 失败 HTTP ${status}`), { code: data?.code === 'INVALID_CODE' ? 'INVALID_CODE' : 'AGENT_AUTH_REQUIRED' })
  }
  state.token = data.token
  return state.token
}

/* ---------------- 本地 inspect（无引擎依赖） ---------------- */
export function inspectBundle(config, filePath) {
  const requireFromVoxa = createRequire(path.join(config.voxaRoot, 'package.json'))
  const JSZip = requireFromVoxa('jszip')
  const vp = requireFromVoxa('@box/voxa-project')
  const bytes = fs.readFileSync(filePath)
  return JSZip.loadAsync(bytes).then(async (zip) => {
    const names = Object.keys(zip.files)
    const metaFile = zip.file('model-meta.bin')
    const dataFile = zip.file('model-data.bin')
    const metaRaw = metaFile ? await metaFile.async('nodebuffer') : null
    const dataRaw = dataFile ? await dataFile.async('nodebuffer') : null
    const projectRaw = zip.file('project.bin') ? await zip.file('project.bin').async('nodebuffer') : null
    let manifest = null
    try { manifest = JSON.parse(await zip.file('manifest.json')?.async('string')) } catch { /* report invalid manifest */ }
    const resources = new Map()
    const declaredResources = Array.isArray(manifest?.resources) ? manifest.resources : []
    for (const name of new Set(['model-data.bin', 'model-meta.bin', 'preview.bin', ...declaredResources.map(row => row?.name)])) {
      if (typeof name === 'string' && zip.file(name)) resources.set(name, await zip.file(name).async('nodebuffer'))
    }
    let meta = null
    try { meta = metaRaw ? JSON.parse(metaRaw.toString('utf8')) : null } catch { /* corrupt */ }
    const stats = { palette: 0, usedColors: 0, rects: 0, texels: 0, meshes: 0, version: null }
    if (dataRaw) {
      try {
        const decoded = vp.modelBytesToSchema(new Uint8Array(dataRaw))
        const s = decoded.schema
        stats.version = decoded.version
        stats.texels = (s.texture.data || []).length
        stats.usedColors = new Set(s.texture.data || []).size
        for (const m of s.meshes || []) for (const face of m || []) stats.rects += ((face.sizes || []).length) / 2
        stats.palette = (s.texture.palette || []).length
        stats.meshes = (s.meshes || []).length
      } catch (error) {
        stats.decodeError = String(error.message || error).slice(0, 200)
      }
    }
    const source = inspectProjectSource(vp, projectRaw)
    const integrity = inspectResourceIntegrity(manifest, meta, resources)
    const gates = {
      palette: stats.palette >= 28,
      usedColors: stats.usedColors >= 12,
      rects: stats.rects >= Math.max(48, Math.min(160, Math.round(20000 * 0.075))),
      texels: stats.texels >= 700,
    }
    return {
      file: filePath,
      bytes: bytes.length,
      entries: names,
      manifestProjectName: manifest?.projectName ?? null,
      editType: manifest?.editType ?? null,
      editorMode: manifest?.editType === 0 ? 'model' : manifest?.editType === 1 ? 'skin' : 'unknown',
      meta: meta ? { version: meta.version, bounds: meta.bounds, dataHash: meta.dataHash, motionList: meta.motionList } : null,
      stats, gates, gatesPass: Object.values(gates).every(Boolean), source, integrity,
      heuristicThresholds: { palette: 28, usedColors: 12, rects: 160, texels: 700 },
      gatesScope: 'Legacy density regression only; not visual, animation, playability or source/runtime equivalence acceptance. Other pipeline thresholds may differ.',
      checks: { hasProjectBin: Boolean(zip.file('project.bin')), hasModelData: Boolean(dataFile), hasModelMeta: Boolean(metaFile), hasPreview: Boolean(zip.file('preview.bin')), dataHashPresent: integrity.dataHashPresent, dataHashMatches: integrity.dataHashMatches },
    }
  })
}

/* ---------------- 工具目录 ---------------- */
export function buildTools(context) {
  const { config, state } = context
  const tools = [
    {
      name: 'voxa_health',
      description: 'VOXA 服务可达性探测（只读）。返回基址与身份配置状态。',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
      handler: async () => {
        const token = await resolveToken(config, state)
        const { status } = await api(config, token, 'GET', '/api/agent/v1/models')
        return ok({ baseUrl: config.baseUrl, reachable: status === 200, identity: config.agentToken ? 'token' : 'code-join' })
      },
    },
    {
      name: 'voxa_model_list',
      description: '列出 VOXA 工作区已有模型（id/名称/动画/更新时间）。导入前先看重名。',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
      handler: async () => {
        const token = await resolveToken(config, state)
        const { status, data } = await api(config, token, 'GET', '/api/agent/v1/models')
        return ok({ status, models: data?.models ?? [] })
      },
    },
    {
      name: 'voxa_model_context',
      description: '读取已有模型的已保存源工程：版本/哈希、部件树与绑定/变换、材质和动画摘要。不要求打开浏览器或截图，不含编辑器未保存更改。',
      inputSchema: { type: 'object', required: ['modelId'], properties: { modelId: {type:'integer',minimum:1}, offset:{type:'integer',minimum:0}, limit:{type:'integer',minimum:1,maximum:128}, paletteOffset:{type:'integer',minimum:0} } },
      annotations: { readOnlyHint: true },
      handler: async args => {
        if (!Number.isSafeInteger(args?.modelId) || args.modelId < 1) return fail('INVALID_ARGS','modelId 必须为正整数');
        const offset=args.offset ?? 0, limit=args.limit ?? 128, paletteOffset=args.paletteOffset ?? 0;
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 128 || !Number.isSafeInteger(paletteOffset) || paletteOffset < 0)
          return fail('INVALID_ARGS','offset≥0，limit为1–128整数');
        const token=await resolveToken(config,state);
        const {status,data}=await api(config,token,'GET',`/api/agent/v1/models/${args.modelId}/context?offset=${offset}&limit=${limit}&paletteOffset=${paletteOffset}`);
        return status === 200 ? ok(data) : fail(data?.code || 'VOXA_REJECTED','读取已保存模型源失败',{status});
      },
    },
    {
      name: 'voxa_model_inspect',
      description: '本地解码 .voxaproject（不进引擎）：调色板/面片/texel 统计 + 门禁判定 + 四件套齐全性。导入前必跑。',
      inputSchema: { type: 'object', required: ['file'], properties: { file: { type: 'string', description: '.voxaproject 绝对路径' } } },
      annotations: { readOnlyHint: true },
      handler: async (args) => {
        const file = String(args?.file || '')
        if (!file || !fs.existsSync(file)) return fail('FILE_NOT_FOUND', `文件不存在: ${file}`)
        return ok(await inspectBundle(config, file))
      },
    },
    {
      name: 'voxa_model_import',
      description: '把 .voxaproject bundle 导入 VOXA 工作区（识别码令牌；成功即登记产物）。导入前建议先 voxa_model_inspect 过门禁。',
      inputSchema: { type: 'object', required: ['file'], properties: { file: { type: 'string', description: '.voxaproject 绝对路径' } } },
      annotations: { readOnlyHint: false, destructiveHint: false },
      handler: async (args) => {
        const file = String(args?.file || '')
        if (!file || !fs.existsSync(file)) return fail('FILE_NOT_FOUND', `文件不存在: ${file}`)
        const token = await resolveToken(config, state)
        const { status, data } = await api(config, token, 'POST', '/api/agent/v1/models', { raw: fs.readFileSync(file) })
        if (status !== 201) return fail('VOXA_REJECTED', data?.message || `HTTP ${status}`, { status })
        return ok({ imported: true, modelId: data.modelId, modelName: data.modelName, editorUrl: data.editorUrl, requiresResourceResave: data.requiresResourceResave })
      },
    },
    {
      name: 'voxa_artifact_register',
      description: '登记产物到 VOXA Agent Active 面板（kind/name/detail）。',
      inputSchema: { type: 'object', required: ['name'], properties: { kind: { type: 'string' }, name: { type: 'string' }, detail: { type: 'string' } } },
      annotations: { readOnlyHint: false },
      handler: async (args) => {
        const name = String(args?.name || '').trim()
        if (!name) return fail('INVALID_ARGS', 'name 必填')
        const token = await resolveToken(config, state)
        const { status, data } = await api(config, token, 'POST', '/api/agent/v1/state', {
          body: { kind: String(args?.kind || 'voxa-model'), name, detail: String(args?.detail || '') },
        })
        if (status !== 201) return fail('VOXA_REJECTED', data?.message || `HTTP ${status}`, { status })
        return ok({ registered: true })
      },
    },
  ]
  return tools
}

/* ---------------- stdio JSON-RPC ---------------- */
const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05']

function startStdioServer(context) {
  const tools = buildTools(context)
  const byName = new Map(tools.map((t) => [t.name, t]))
  const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
  const replyError = (id, code, message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`)

  let buffered = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    buffered += chunk
    let index
    while ((index = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, index).trim()
      buffered = buffered.slice(index + 1)
      if (!line) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      handleMessage(msg, { tools, byName, reply, replyError })
    }
  })
  process.stdin.resume()
}

export async function handleMessage(msg, { byName, reply, replyError }) {
  const { id, method, params } = msg
  try {
    if (method === 'initialize') {
      return reply(id, {
        protocolVersion: SUPPORTED.includes(params?.protocolVersion) ? params.protocolVersion : SUPPORTED[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'box3-voxa-mcp', title: 'BOX3 VOXA 模型构建 MCP（识别码体系）', version: '0.1.0' },
      })
    }
    if (method === 'initialized' || method === 'ping') return id !== undefined ? reply(id, {}) : undefined
    if (method === 'tools/list') {
      return reply(id, {
        tools: [...byName.values()].map((t) => ({
          name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations,
        })),
      })
    }
    if (method === 'tools/call') {
      const tool = byName.get(params?.name)
      if (!tool) return replyError(id, -32602, `unknown tool: ${params?.name}`)
      try {
        return reply(id, await tool.handler(params?.arguments || {}))
      } catch (error) {
        if (error?.code && HINTS[error.code]) return reply(id, fail(error.code, error.message))
        return reply(id, fail('VOXA_REJECTED', String(error?.message || error)))
      }
    }
    if (id !== undefined) return replyError(id, -32601, `unknown method: ${method}`)
  } catch (error) {
    if (id !== undefined) return replyError(id, -32603, String(error?.message || error))
  }
}

export function buildContext(env = process.env) {
  return { config: loadConfig(env), state: {} }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  if (process.argv.slice(2).includes('--config-json')) {
    const config = loadConfig()
    process.stdout.write(`${JSON.stringify({ ...config, agentToken: config.agentToken ? '(set)' : '', agentCode: config.agentCode ? '(set)' : '' }, null, 2)}\n`)
  } else {
    startStdioServer(buildContext())
  }
}
