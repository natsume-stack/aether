/**
 * Live, read-only evidence runner.
 *
 * Calls every read tool against the real Creator API and against the real
 * project directory, prints the raw payloads, and round-trips the MCP stdio
 * transport with a spawned child process. It never calls `script_write` and it
 * never issues a non-GET request.
 *
 *   node scripts/live-probe.js
 *   BOX3_LIVE_MAP_ID=<20 hex> node scripts/live-probe.js
 */
import childProcess from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { buildContext } from '../src/index.js'
import { createHandler } from '../src/server.js'
import { contentHash, isCidV0, verifyBlobName } from '../src/cid.js'

const readTools = [
  'engine_health',
  'map_list',
  'map_resources',
  'script_list',
  'script_read',
  'data_read',
  'runtime_status',
  'runtime_events_tail',
]

const args = process.argv.slice(2)
const show = (label, value) => {
  process.stdout.write(`\n===== ${label} =====\n`)
  process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`)
}

const ctx = buildContext()
const handle = createHandler(ctx)
const mapId = process.env.BOX3_LIVE_MAP_ID || 'yunhai-xiantu'
const scriptEntry = process.env.BOX3_LIVE_SCRIPT || 'lib.js'

show('CONFIG (token redacted)', {
  creatorBaseUrl: ctx.config.creatorBaseUrl,
  cliToken: ctx.config.cliToken ? `${ctx.config.cliToken.slice(0, 4)}…(${ctx.config.cliToken.length} chars)` : '(unset)',
  projectsRoot: ctx.config.projectsRoot || '(unset)',
  projectsRootReadable: ctx.store.available,
  profile: ctx.config.profile,
  typeGate: ctx.config.typeGate,
  repoRoot: ctx.config.repoRoot,
})

const results = []
for (const name of readTools) {
  const call = { engine_health: {}, map_list: {} }[name] || {}
  if (name === 'map_resources' || name === 'script_list' || name === 'runtime_status') call.mapId = mapId
  if (name === 'data_read') Object.assign(call, { mapId, scope: 'project', space: 'default', limit: 5 })
  if (name === 'script_read') Object.assign(call, { mapId, side: 'server', entry: scriptEntry })
  if (name === 'runtime_events_tail') Object.assign(call, { mapId, idleMs: 1200, timeoutMs: 8000 })
  const response = await handle({ jsonrpc: '2.0', id: results.length + 1, method: 'tools/call', params: { name, arguments: call } })
  const payload = response.result || response.error
  results.push({
    tool: name,
    arguments: call,
    isError: payload.isError,
    summary: summarise(name, payload.structuredContent || payload.error || payload),
    raw: payload.structuredContent || payload.error || payload,
  })
}

function summarise(name, content) {
  if (!content) return 'no payload'
  if (content.error) return `ERROR ${content.error.code}: ${content.error.message}`
  if (name === 'engine_health') return `apiVersion=${content.apiVersion} engineVersion=${content.engineVersion}`
  if (name === 'map_list') return `${(content.projects || []).length} 张图`
  if (name === 'map_resources') return `counts=${JSON.stringify(content.counts)}`
  if (name === 'script_list') return `shared=${(content.sharedScripts || []).length} local=${(content.mapLocalScripts || []).length}`
  if (name === 'script_read') {
    const form = content.nameForm && (content.nameForm.form || content.nameForm)
    return `source=${content.readBackSource} hash=${content.hash} form=${form} verified=${
      content.contentVerified !== undefined ? content.contentVerified : content.hashMatchesContent
    } bytes=${content.contentBytes ?? content.size}`
  }
  if (name === 'data_read') return `keys=${JSON.stringify((content.items || []).slice(0, 3))}`
  if (name === 'runtime_status') return `phase=${content.phase} running=${content.running}`
  if (name === 'runtime_events_tail') return `received=${content.received} verdict=${content.verdict && content.verdict.verdict}`
  return JSON.stringify(content).slice(0, 120)
}

show('READ TOOL RESULTS', results.map(({ tool, arguments: call, isError, summary }) => ({ tool, call, isError, summary })))

const revision = (() => {
  if (!ctx.store.available) return { error: ctx.store.unavailableReason() }
  try {
    const head = ctx.store.readRevision(mapId)
    return {
      mapId: head.mapId,
      permanentMapId: head.permanentMapId,
      branchName: head.branchName,
      permissionHash: head.permissionHash,
      headHash: head.headHash,
      headHashIsCidV0: isCidV0(head.headHash),
      mapLocalScripts: ctx.store.listMapLocalScripts(mapId),
    }
  } catch (error) {
    return { error: `${error.code}: ${error.message}` }
  }
})()
show(`DISK REVISION CHAIN (${mapId})`, revision)

// Real blob naming census. This is the evidence behind "blob names are either
// CIDv0 or URL-safe SHA-256": both forms live in ONE directory, so a reader or
// a guard that only knows CIDv0 silently mis-reports imported assets.
// Read-only, and CRLF-normalized names are attributed to the Windows checkout,
// not to the engine (see O3-mcp-slice-a 5.3).
const blobDir =
  process.env.BOX3_REAL_BLOBS_DIR ||
  (ctx.store.available ? path.join(ctx.store.resolve(mapId).root, 'source', 'blobs') : '')
const blobCensus = (() => {
  if (!blobDir || !fs.existsSync(blobDir)) return { error: `blobs 目录不可读：${blobDir || '(none)'}` }
  const files = fs.readdirSync(blobDir, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name)
  const census = {
    blobRoot: blobDir,
    files: files.length,
    cidv0: { total: 0, verified: 0, crlfCheckoutOnly: 0, mismatched: [] },
    sha256Url: { total: 0, verified: 0, mismatched: [] },
    legacyUuid: { total: 0, verifiable: false },
    unknown: { total: 0, sample: [] },
  }
  for (const name of files) {
    const bytes = fs.readFileSync(path.join(blobDir, name))
    const check = verifyBlobName(bytes, name)
    if (check.form === 'cidv0') {
      census.cidv0.total += 1
      if (check.verified) census.cidv0.verified += 1
      else {
        const flat = Buffer.from(bytes.toString('binary').replace(/\r\n/g, '\n'), 'binary')
        if (contentHash(flat) === name) census.cidv0.crlfCheckoutOnly += 1
        else if (census.cidv0.mismatched.length < 5) census.cidv0.mismatched.push(name)
        else census.cidv0.mismatched.push('(more)')
      }
    } else if (check.form === 'sha256-url') {
      census.sha256Url.total += 1
      if (check.verified) census.sha256Url.verified += 1
      else if (census.sha256Url.mismatched.length < 5) census.sha256Url.mismatched.push(name)
    } else if (check.form === 'legacy-uuid') census.legacyUuid.total += 1
    else {
      census.unknown.total += 1
      if (census.unknown.sample.length < 5) census.unknown.sample.push(name)
    }
  }
  census.bothFormsCoexist = census.cidv0.total > 0 && census.sha256Url.total > 0
  return census
})()
show('REAL BLOB NAME-FORM CENSUS (read-only)', blobCensus)

show('TYPE GATE ON A REAL SCRIPT (if readable)', await (async () => {
  const response = await handle({
    jsonrpc: '2.0',
    id: 900,
    method: 'tools/call',
    params: { name: 'script_typecheck', arguments: { side: 'server', content: 'world.onPlayerJoin(({player}) => console.log(player.name))\n' } },
  })
  return response.result.structuredContent
})())

// Gate + surface audit against the REAL authored scripts of every local map.
// Read-only: the content comes off disk through the same hash chain the
// factory reader follows.
const realScriptAudit = []
for (const project of ctx.store.available ? ctx.store.listProjects() : []) {
  for (const script of ctx.store.listMapLocalScripts(project.directory)) {
    try {
      const loaded = ctx.store.readMapLocalScript(project.directory, script.entry, script.side)
      const gate = await handle({
        jsonrpc: '2.0',
        id: 1000 + realScriptAudit.length,
        method: 'tools/call',
        params: {
          name: 'script_typecheck',
          arguments: { side: script.side, content: loaded.content, mode: 'syntax' },
        },
      })
      const surface = await handle({
        jsonrpc: '2.0',
        id: 2000 + realScriptAudit.length,
        method: 'tools/call',
        params: { name: 'contract_describe', arguments: { side: script.side } },
      })
      const undeclared = gate.result.structuredContent.warnings.filter(
        (item) => item.code === 'UNDECLARED_API_MEMBER',
      )
      const content = gate.result.structuredContent
      realScriptAudit.push({
        map: project.directory,
        script: `${script.side}/${script.entry}`,
        bytes: loaded.size,
        hash: loaded.hash,
        // Real data: the name can be CIDv0 or URL-safe SHA-256; `contentVerified`
        // is undefined when the form cannot be re-derived from the bytes.
        nameForm: loaded.nameForm.form,
        contentVerified: loaded.contentVerified,
        // Dialect evidence for the ESM conclusion: which side, whether the real
        // bytes contain top-level import/export, and what the gate defaulted to.
        topLevelEsmSyntax: /^\s*(?:import|export)\s/m.test(loaded.content),
        gateDialect: content.dialect,
        gateDialectSource: content.dialectSource,
        gateParser: content.notes,
        gateSatisfied: content.satisfied,
        gateErrors: content.errors,
        undeclaredApiMembers: undeclared.length,
        undeclaredSample: [...new Set(undeclared.map((item) => item.symbol))].slice(0, 12),
        declaredGlobals: surface.result.structuredContent.globals.length,
      })
    } catch (error) {
      realScriptAudit.push({ map: project.directory, script: `${script.side}/${script.entry}`, error: `${error.code}: ${error.message}` })
    }
  }
}
show('REAL MAP SCRIPTS: BYTE VERIFICATION + GATE + SURFACE AUDIT', realScriptAudit)

// Stdio transport round trip: spawn the server as a child over pipes.
const stdio = await new Promise((resolve) => {
  const child = childProcess.spawn(process.execPath, [path.resolve(import.meta.dirname, '../src/index.js')], {
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const lines = []
  let buffer = ''
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      lines.push(buffer.slice(0, index))
      buffer = buffer.slice(index + 1)
    }
    if (lines.length >= 3) {
      child.kill()
      resolve(lines)
    }
  })
  child.stderr.on('data', (chunk) => process.stderr.write(`[child] ${chunk}`))
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'live-probe', version: '0' } } })}\n`)
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`)
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'engine_health', arguments: {} } })}\n`)
  setTimeout(() => {
    child.kill()
    resolve(lines)
  }, 15_000)
})
show('STDIO ROUND TRIP', stdio.map((line) => JSON.parse(line)))

const failed = results.filter((item) => item.isError).map((item) => item.tool)
process.stdout.write(
  `\nSUMMARY: ${results.length - failed.length}/${results.length} read tools returned data; failing: ${failed.join(', ') || 'none'}; ` +
    `disk revision=${revision.headHash || 'n/a'}; blob name forms: ` +
    `${blobCensus.cidv0 ? `CIDv0 ${blobCensus.cidv0.verified}/${blobCensus.cidv0.total} (CRLF-checkout-only ${blobCensus.cidv0.crlfCheckoutOnly}), ` +
    `URL-safe ${blobCensus.sha256Url.verified}/${blobCensus.sha256Url.total}, coexist=${blobCensus.bothFormsCoexist}` : blobCensus.error}; ` +
    `real scripts: ${realScriptAudit.length} 份，gate dialect 分布 ` +
    `${JSON.stringify(realScriptAudit.reduce((acc, item) => { acc[item.gateDialect || 'error'] = (acc[item.gateDialect || 'error'] || 0) + 1; return acc }, {}))}.\n`,
)
// Never process.exit() here: stdout to a pipe is async-buffered and an early
// exit truncates the evidence this script exists to produce.
process.exitCode = failed.length === readTools.length ? 1 : 0
