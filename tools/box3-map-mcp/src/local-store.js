/**
 * Read-only view of the engine's local project directory.
 *
 * WHY THIS EXISTS: `branch.headHash` is the engine's own revision token
 * (`apps/local-engine/src/project-manager.js:2073-2081`) and no `creator/v1`
 * scope exposes it (`projects.list` / `resources` / `scripts` all stop short of
 * the version chain; see plan/N2 2.1). Slice A must not touch the engine, so
 * the optimistic lock reads the same three files the engine reads, read-only:
 *
 *   <projectsRoot>/<dir>/source/project-state.json   -> permissionHash
 *   <projectsRoot>/<dir>/source/blobs/<permissionHash> -> versionControl
 *   <projectsRoot>/<dir>/source/blobs/<versionControl> -> branches[current].headHash
 *
 * This module NEVER writes. Writes go through `scripts.update` only, so the
 * engine keeps owning blob creation, the hash chain and the map-group fan-out.
 */
import fs from 'node:fs'
import path from 'node:path'

import { verifyBlobName } from './cid.js'

const projectIdPattern = /^[a-z0-9][a-z0-9-]{0,62}$/
const mapIdentityPattern = /^[0-9a-f]{20}$/

export class LocalStoreError extends Error {
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'LocalStoreError'
    this.code = code
    this.detail = extra
  }
}

function readJson(file, label) {
  if (!fs.existsSync(file)) {
    throw new LocalStoreError('LOCAL_BLOB_MISSING', `${label}不存在：${file}`)
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    throw new LocalStoreError('LOCAL_BLOB_INVALID', `${label}格式无效：${file}（${error.message}）`)
  }
}

export class LocalMapStore {
  constructor(projectsRoot) {
    this.projectsRoot = projectsRoot || ''
  }

  get available() {
    return Boolean(this.projectsRoot) && fs.existsSync(this.projectsRoot)
  }

  unavailableReason() {
    if (!this.projectsRoot) {
      return '未配置 BOX_MAP_PROJECTS_ROOT：无法离线读取 branch.headHash，只能用 script_read 的脚本哈希做降级乐观锁'
    }
    if (!fs.existsSync(this.projectsRoot)) {
      return `BOX_MAP_PROJECTS_ROOT 不存在或不可读：${this.projectsRoot}`
    }
    return ''
  }

  listProjects() {
    if (!this.available) throw new LocalStoreError('PROJECTS_ROOT_UNAVAILABLE', this.unavailableReason())
    return fs
      .readdirSync(this.projectsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && projectIdPattern.test(entry.name))
      .flatMap((entry) => {
        try {
          const metadata = readJson(path.join(this.projectsRoot, entry.name, 'project.json'), '工程元数据')
          return [
            {
              directory: entry.name,
              id: metadata.id || entry.name,
              permanentMapId: metadata.permanentMapId || '',
              name: metadata.name || '',
              mapRole: metadata.mapRole || '',
              updatedAt: metadata.updatedAt || '',
            },
          ]
        } catch {
          // Same tolerance as listProjects in project-manager.js:996-1001.
          return []
        }
      })
  }

  /** Accepts either the legacy directory id or the permanent map id. */
  resolve(mapId) {
    const value = String(mapId || '').trim()
    if (!value) throw new LocalStoreError('INVALID_MAP_ID', 'mapId 必须是非空字符串')
    const projects = this.listProjects()
    const direct = projects.find((project) => project.directory === value || project.id === value)
    if (direct) return { ...direct, root: path.join(this.projectsRoot, direct.directory) }
    if (mapIdentityPattern.test(value)) {
      const byPermanent = projects.find((project) => project.permanentMapId === value)
      if (byPermanent) {
        return { ...byPermanent, root: path.join(this.projectsRoot, byPermanent.directory) }
      }
    }
    throw new LocalStoreError('LOCAL_PROJECT_NOT_FOUND', `本地工程目录中没有这张地图：${value}`)
  }

  sourceRoot(mapId) {
    return path.join(this.resolve(mapId).root, 'source')
  }

  /**
   * @returns {{mapId:string, permanentMapId:string, projectDir:string,
   *   permissionHash:string, branchName:string, headHash:string,
   *   groupState:Object}} identical chain to updateProjectScript
   */
  readRevision(mapId) {
    const project = this.resolve(mapId)
    const source = path.join(project.root, 'source')
    const blobRoot = path.join(source, 'blobs')
    const state = readJson(path.join(source, 'project-state.json'), '工程状态清单')
    if (!state.permissionHash) {
      throw new LocalStoreError(
        'MISSING_PERMISSION_HASH',
        '该工程还没有 permissionHash：请先在编辑器中保存一次（project-manager.js:2414-2416 同源约束）',
      )
    }
    const permission = readJson(path.join(blobRoot, state.permissionHash), '工程权限数据')
    const versionControl = readJson(path.join(blobRoot, permission.versionControl), '工程版本数据')
    const branchName = versionControl.currentBranch || 'master'
    const branch =
      (versionControl.branches && versionControl.branches[branchName]) ||
      (versionControl.branches && versionControl.branches.master)
    if (!branch || !branch.headHash) {
      throw new LocalStoreError('MISSING_HEAD_HASH', '工程缺少当前版本头（branch.headHash）')
    }
    return {
      mapId: project.directory,
      permanentMapId: project.permanentMapId,
      projectDir: project.root,
      blobRoot,
      permissionHash: state.permissionHash,
      branchName,
      headHash: branch.headHash,
      state,
      groupState: (() => {
        const file = path.join(project.root, 'group-state.json')
        return fs.existsSync(file) ? readJson(file, '地图组状态') : undefined
      })(),
    }
  }

  /**
   * Map-local entry scripts (`index.js`, `clientIndex.js`) are deliberately NOT
   * shared, so `GET .../scripts/{side}/{entry}` cannot read them
   * (`readProjectScript` only looks at `extraProject.scriptAssets`,
   * `project-manager.js:2200-2237`). For those two entries the disk chain is
   * the only read-back path, and this is it.
   */
  readMapLocalScript(mapId, entry, side) {
    const revision = this.readRevision(mapId)
    const project = readJson(path.join(revision.blobRoot, revision.headHash), '工程地图数据')
    const scriptAssets = readJson(path.join(revision.blobRoot, project.scriptAssets), '工程脚本索引')
    const asset = scriptAssets[entry]
    if (!asset || !asset.hash) {
      throw new LocalStoreError('LOCAL_SCRIPT_NOT_FOUND', `该工程没有 map-local 脚本：${side}/${entry}`)
    }
    const expectedType = side === 'server' ? 1 : 7
    if (asset.type !== undefined && asset.type !== expectedType) {
      throw new LocalStoreError(
        'LOCAL_SCRIPT_SIDE_MISMATCH',
        `脚本 ${entry} 的类型位是 ${asset.type}（1=server, 7=client），与请求的 side=${side} 不符`,
      )
    }
    const file = path.join(revision.blobRoot, asset.hash)
    if (!fs.existsSync(file)) {
      throw new LocalStoreError('LOCAL_BLOB_MISSING', `脚本 blob 不存在：${asset.hash}`)
    }
    // Raw bytes, never a re-encoding: the name has to be checked against the
    // exact digest the engine stored, and `size` has to be the on-disk byte
    // count. Decoding to UTF-8 first would hide a corrupt blob behind a
    // replacement character and change the length.
    const bytes = fs.readFileSync(file)
    const content = bytes.toString('utf8')
    const nameForm = verifyBlobName(bytes, asset.hash)
    return {
      entry,
      side,
      hash: asset.hash,
      nameForm,
      // undefined = this name form is not content-addressed, so it can only be
      // reported as unverified, never as a pass and never as a mismatch.
      contentVerified: nameForm.verifiable ? nameForm.verified : undefined,
      size: bytes.length,
      shared: false,
      content,
      revision: revision.headHash,
      branchName: revision.branchName,
    }
  }

  listMapLocalScripts(mapId) {
    const revision = this.readRevision(mapId)
    const project = readJson(path.join(revision.blobRoot, revision.headHash), '工程地图数据')
    const scriptAssets = readJson(path.join(revision.blobRoot, project.scriptAssets), '工程脚本索引')
    return Object.entries(scriptAssets)
      .filter(([, asset]) => asset && typeof asset.hash === 'string')
      .map(([entry, asset]) => ({
        entry,
        // AssetType.JS_SCRIPT = 1, CLIENT_JS_SCRIPT = 7
        // (internals/schema/group-project/rda.ts:19-37, written by
        // project-manager.js:2165-2171). Anything else is reported as unknown
        // rather than silently guessed to be the server side.
        side: asset.type === 7 ? 'client' : asset.type === 1 ? 'server' : 'unknown',
        type: asset.type,
        hash: asset.hash,
        size: asset.size,
        shared: false,
      }))
      .sort((left, right) => left.entry.localeCompare(right.entry))
  }
}
