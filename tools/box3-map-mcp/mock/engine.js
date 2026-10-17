/**
 * Faithful local stand-in for the Creator `creator/v1` routes used by this MCP.
 *
 * It exists so the write path (CAS, type gate, read-back, rollback, acceptance)
 * can be exercised end-to-end WITHOUT touching a real map: it implements the
 * same on-disk chain as `apps/local-engine/src/project-manager.js:2056-2198`
 * (project-state.json -> permissionHash -> versionControl -> branch.headHash ->
 * scriptAssets -> blob) over a temp directory, including the two behaviours the
 * guards depend on:
 *   - map-local `index.js` / `clientIndex.js` advance the version chain;
 *   - every other entry goes to the map-group shared table and HTTP GET can
 *     read it back.
 *
 * This is a test double, not a reimplementation of the engine, and it is only
 * ever bound to 127.0.0.1 on an ephemeral port.
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { contentHash, urlSafeSha256Name } from '../src/cid.js'

const capabilities = {
  GET: {
    '/api/creator/v1/health': undefined,
    projects: 'projects.list',
    resources: 'resources.list',
    scripts: 'scripts.read',
    storage: 'storage.read',
    runtime: 'runtime.view',
    events: 'runtime.view',
  },
  PUT: { scripts: 'scripts.update' },
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8')
}

/**
 * `form` models the two content-addressed name forms one real blob directory
 * actually holds side by side:
 *   - `cidv0`      what the factory writer produces (`storeReleaseBlob` ->
 *                  `contentHash`, project-manager.js:196-205),
 *   - `sha256-url` what a cloud-imported map already carries
 *                  (`box3-re/tmp/a9-jscripts.txt`: 4 such names inside two
 *                  `projects/<id>/source/blobs/` directories).
 * Writes always use CIDv0, exactly like the engine, so seeding with
 * `sha256-url` proves the read path accepts both forms while the write path
 * still lands on CIDv0.
 */
function storeBlob(blobRoot, content, form = 'cidv0') {
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8')
  const hash = form === 'sha256-url' ? urlSafeSha256Name(buffer) : contentHash(buffer)
  fs.mkdirSync(blobRoot, { recursive: true })
  if (!fs.existsSync(path.join(blobRoot, hash))) fs.writeFileSync(path.join(blobRoot, hash), buffer)
  return hash
}

/** Create a project directory that looks like a saved map. */
export function seedProject(projectsRoot, options) {
  const { directory, permanentMapId, name, sharedScripts = [], localScripts = {}, blobNameForm = 'cidv0' } = options
  const root = path.join(projectsRoot, directory)
  const blobRoot = path.join(root, 'source', 'blobs')
  fs.mkdirSync(blobRoot, { recursive: true })
  writeJson(path.join(root, 'project.json'), {
    formatVersion: 1,
    id: directory,
    permanentMapId,
    publicId: directory,
    name,
    mapGroupId: directory,
    mapRole: 'main',
    mainProjectId: directory,
  })

  const scriptAssets = {}
  for (const [entry, side] of Object.entries(localScripts)) {
    scriptAssets[entry] = {
      hash: storeBlob(blobRoot, `// ${entry}\n`, blobNameForm),
      size: 10,
      type: side === 'client' ? 7 : 1,
    }
  }
  const scriptAssetsHash = storeBlob(blobRoot, JSON.stringify(scriptAssets), blobNameForm)
  const projectHash = storeBlob(
    blobRoot,
    JSON.stringify({ type: 'project', version: '0.3.31', scriptAssets: scriptAssetsHash, prevHash: '', timestamp: '' }),
    blobNameForm,
  )
  const versionControlHash = storeBlob(
    blobRoot,
    JSON.stringify({ branches: { master: { headHash: projectHash } }, currentBranch: 'master' }),
    blobNameForm,
  )
  const permissionHash = storeBlob(
    blobRoot,
    JSON.stringify({ versionControl: versionControlHash, permissions: {} }),
    blobNameForm,
  )
  writeJson(path.join(root, 'source', 'project-state.json'), { formatVersion: 1, permissionHash })

  const groupBlobRoot = path.join(projectsRoot, `${directory}-group`, 'blobs')
  fs.mkdirSync(groupBlobRoot, { recursive: true })
  const extra = { scriptAssets: {} }
  for (const script of sharedScripts) {
    const fileId = `file-${script.entry.replace(/[^a-z0-9]/gi, '')}`
    extra.scriptAssets[fileId] = {
      id: fileId,
      hash: storeBlob(groupBlobRoot, script.content, blobNameForm),
      name: script.entry,
      isClient: script.side === 'client',
      isShare: true,
      order: Object.keys(extra.scriptAssets).length + 1,
      lockedMapTitle: '',
      lockedMapId: 0,
    }
  }
  const extraProjectHash = storeBlob(groupBlobRoot, JSON.stringify(extra), blobNameForm)
  writeJson(path.join(root, 'group-state.json'), { extraProjectHash, revision: 1 })
  writeJson(path.join(projectsRoot, `${directory}-group`, 'group-state.json'), { extraProjectHash, revision: 1 })

  return { root, blobRoot, groupBlobRoot, projectHash, permissionHash, versionControlHash, scriptAssetsHash }
}

function decodeShared(groupBlobRoot, extraProjectHash) {
  if (!extraProjectHash) return { scriptAssets: {} }
  return readJson(path.join(groupBlobRoot, extraProjectHash))
}

export async function startMockEngine(spec) {
  const { projectsRoot, token = 'bxc_test_test', events = [], tamper = false } = spec
  const state = {
    events: events.map((event, index) => ({ id: index + 1, at: '2026-10-18T00:00:00.000Z', ...event })),
    nextId: events.length + 1,
    tamperBudget: tamper ? 1 : 0,
  }
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(body))
    }
    const segments = url.pathname.split('/').filter(Boolean)
    // /api/creator/v1[/projects/:id[/...]]   ->  segments[0..2] are the prefix
    if (segments[0] !== 'api' || segments[1] !== 'creator' || segments[2] !== 'v1') {
      return send(404, { code: 'NOT_FOUND' })
    }
    if (url.pathname === '/api/creator/v1/health' && req.method === 'GET') {
      return send(200, {
        apiVersion: 'v1',
        engineVersion: 'mock',
        serverInstanceId: 'mock',
        issuer: 'mock',
        deploymentMode: 'creator',
      })
    }
    const auth = String(req.headers.authorization || '')
    if (auth !== `Bearer ${token}`) {
      return send(401, { code: 'AUTH_REQUIRED', message: 'CLI Token 无效或已撤销' })
    }
    if (segments[3] !== 'projects') return send(404, { code: 'NOT_FOUND' })
    const mapId = segments[4] ? decodeURIComponent(segments[4]) : ''
    const kind = segments[5] || ''

    if (req.method === 'GET' && !kind) {
      const projects = fs
        .readdirSync(projectsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .flatMap((entry) => {
          const file = path.join(projectsRoot, entry.name, 'project.json')
          if (!fs.existsSync(file)) return []
          const metadata = readJson(file)
          return [
            {
              permanentMapId: metadata.permanentMapId,
              name: metadata.name,
              status: 'local',
              updatedAt: '2026-10-18T00:00:00.000Z',
              mapRole: metadata.mapRole,
              mainProjectId: metadata.mainProjectId,
            },
          ]
        })
      return send(200, { projects })
    }

    const directory = resolveDirectory(projectsRoot, mapId)
    if (!directory) return send(404, { code: 'PROJECT_NOT_FOUND', message: `Project not found: ${mapId}` })
    const root = path.join(projectsRoot, directory)
    const blobRoot = path.join(root, 'source', 'blobs')
    const groupRoot = path.join(projectsRoot, `${directory}-group`)
    const groupBlobRoot = path.join(groupRoot, 'blobs')
    const groupStatePath = path.join(groupRoot, 'group-state.json')

    if (req.method === 'GET' && kind === 'resources') {
      return send(200, {
        projectId: readJson(path.join(root, 'project.json')).permanentMapId,
        modelAssets: [],
        pictureAssets: [],
        audioAssets: [],
        uiTree: [],
      })
    }
    if (req.method === 'GET' && kind === 'scripts' && !segments[6]) {
      const groupState = readJson(groupStatePath)
      const extra = decodeShared(groupBlobRoot, groupState.extraProjectHash)
      const scripts = Object.values(extra.scriptAssets)
        .filter((asset) => asset.isShare === true)
        .map((asset) => ({
          entry: asset.name,
          side: asset.isClient ? 'client' : 'server',
          hash: asset.hash,
          size: fs.statSync(path.join(groupBlobRoot, asset.hash)).size,
          shared: true,
        }))
        .sort((a, b) => a.side.localeCompare(b.side) || a.entry.localeCompare(b.entry))
      return send(200, { projectId: readJson(path.join(root, 'project.json')).permanentMapId, scripts })
    }
    if (kind === 'scripts' && segments[6] && segments[7]) {
      const side = decodeURIComponent(segments[6])
      const entry = decodeURIComponent(segments[7])
      if (side !== 'client' && side !== 'server') {
        return send(422, { code: 'SCRIPT_SIDE_INVALID', message: 'side 必须是 client 或 server' })
      }
      if (!/^[A-Za-z0-9._-]{1,160}$/.test(entry) || entry.includes('..')) {
        return send(422, { code: 'SCRIPT_ENTRY_INVALID', message: 'entry 必须是有效的脚本文件名' })
      }
      const revision = readRevision(root, blobRoot)
      const groupState = readJson(groupStatePath)
      const extra = decodeShared(groupBlobRoot, groupState.extraProjectHash)

      if (req.method === 'GET') {
        const asset = Object.values(extra.scriptAssets).find(
          (value) => value.name === entry && value.isClient === (side === 'client'),
        )
        if (!asset || asset.isShare !== true) {
          return send(404, { code: 'SHARED_SCRIPTS_NOT_FOUND', message: `Shared script not found: ${side}/${entry}` })
        }
        return send(200, {
          entry,
          side,
          hash: asset.hash,
          shared: true,
          content: fs.readFileSync(path.join(groupBlobRoot, asset.hash), 'utf8'),
        })
      }

      const body = await readBody(req)
      if (typeof body.content !== 'string') {
        return send(422, { code: 'SCRIPT_CONTENT_REQUIRED', message: 'content 必须是字符串' })
      }
      // Models a storage-layer corruption exactly once, so a repair write can
      // succeed: the guard must notice the mismatch and roll back.
      const corrupted = state.tamperBudget > 0
      if (corrupted) state.tamperBudget -= 1
      const written = corrupted ? `${body.content}\n// tampered` : body.content
      const isMapLocal = ['index.js', 'clientIndex.js'].includes(entry)
      const scriptHash = storeBlob(isMapLocal ? blobRoot : groupBlobRoot, Buffer.from(written, 'utf8'))

      if (!isMapLocal) {
        const existing = Object.entries(extra.scriptAssets).find(([, asset]) => asset.name === entry)
        const fileId = existing?.[0] || `file-${contentHash(entry).slice(2, 10)}`
        extra.scriptAssets[fileId] = {
          id: fileId,
          hash: scriptHash,
          name: entry,
          isClient: side === 'client',
          isShare: true,
          order: existing?.[1]?.order ?? Object.keys(extra.scriptAssets).length + 1,
          lockedMapTitle: '',
          lockedMapId: 0,
        }
        const extraProjectHash = storeBlob(groupBlobRoot, JSON.stringify(extra))
        writeJson(groupStatePath, { ...groupState, extraProjectHash, revision: (groupState.revision || 1) + 1 })
        writeJson(path.join(root, 'group-state.json'), { extraProjectHash, revision: (groupState.revision || 1) + 1 })
        state.events.push({ id: state.nextId++, type: 'log', side: 'server', level: 3, message: `shared write ${entry}`, at: new Date().toISOString() })
        return send(200, { entry, side, revision: revision.headHash, hash: scriptHash, shared: true })
      }

      const project = readJson(path.join(blobRoot, revision.headHash))
      const scriptAssets = readJson(path.join(blobRoot, project.scriptAssets))
      scriptAssets[entry] = {
        ...scriptAssets[entry],
        hash: scriptHash,
        size: Buffer.byteLength(written, 'utf8'),
        type: side === 'server' ? 1 : 7,
      }
      const nextAssetsHash = storeBlob(blobRoot, JSON.stringify(scriptAssets))
      const nextProjectHash = storeBlob(
        blobRoot,
        JSON.stringify({ ...project, scriptAssets: nextAssetsHash, prevHash: revision.headHash, timestamp: new Date().toISOString() }),
      )
      const nextVersionControlHash = storeBlob(
        blobRoot,
        JSON.stringify({
          ...revision.versionControl,
          branches: {
            ...revision.versionControl.branches,
            [revision.branchName]: { ...revision.branch, headHash: nextProjectHash },
          },
        }),
      )
      const nextPermissionHash = storeBlob(
        blobRoot,
        JSON.stringify({ ...revision.permission, versionControl: nextVersionControlHash }),
      )
      writeJson(path.join(root, 'source', 'project-state.json'), {
        ...readJson(path.join(root, 'source', 'project-state.json')),
        permissionHash: nextPermissionHash,
      })
      return send(200, { entry, side, revision: nextProjectHash, hash: scriptHash, shared: false })
    }
    if (req.method === 'GET' && kind === 'runtime' && !segments[6]) {
      return send(200, { phase: state.running ? 'ready' : 'idle', running: Boolean(state.running), message: state.running ? '预览运行中' : '预览已停止', updatedAt: new Date().toISOString() })
    }
    if (req.method === 'GET' && kind === 'runtime' && segments[6] === 'events') {
      const lastEventId = Number.parseInt(String(req.headers['last-event-id'] || ''), 10)
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' })
      const replay = Number.isSafeInteger(lastEventId) && lastEventId > 0
        ? state.events.filter((event) => event.id > lastEventId)
        : [{ id: 0, type: 'status', phase: 'idle', running: false, message: '预览已停止', at: new Date().toISOString() }]
      for (const event of replay) {
        res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      }
      if (spec.streamEnd !== false) setTimeout(() => res.end(), 5)
      return undefined
    }
    if (req.method === 'GET' && kind === 'storage') {
      const scope = segments[6]
      const space = decodeURIComponent(segments[7] || '')
      if (!['project', 'group'].includes(scope)) return send(400, { code: 'INVALID_STORAGE_REQUEST', message: '范围必须是 project 或 group' })
      if (!/^[A-Za-z0-9_]{1,50}$/.test(space)) return send(400, { code: 'INVALID_STORAGE_REQUEST', message: '空间名无效' })
      const requested = url.searchParams.get('key')
      const items = spec.storageItems || [{ key: 'hp', value: 3 }]
      if (requested) {
        const hit = items.find((item) => item.key === requested)
        return send(200, { projectId: mapId, scope, space, item: hit ? { key: requested, value: hit.value } : null })
      }
      return send(200, { projectId: mapId, scope, space, items, total: items.length, nextCursor: undefined })
    }
    return send(404, { code: 'NOT_FOUND' })
  })
  void capabilities
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    token,
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

function resolveDirectory(projectsRoot, mapId) {
  if (!fs.existsSync(path.join(projectsRoot, mapId, 'project.json'))) {
    const entries = fs.readdirSync(projectsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    for (const entry of entries) {
      const file = path.join(projectsRoot, entry.name, 'project.json')
      if (fs.existsSync(file) && readJson(file).permanentMapId === mapId) return entry.name
    }
    return ''
  }
  return mapId
}

function readRevision(root, blobRoot) {
  const state = readJson(path.join(root, 'source', 'project-state.json'))
  const permission = readJson(path.join(blobRoot, state.permissionHash))
  const versionControl = readJson(path.join(blobRoot, permission.versionControl))
  const branchName = versionControl.currentBranch || 'master'
  const branch = versionControl.branches[branchName] || versionControl.branches.master
  return { permission, versionControl, branchName, branch, headHash: branch.headHash }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      try {
        resolve(text ? JSON.parse(text) : {})
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}
