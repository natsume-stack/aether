/**
 * The one write path of slice A: `script_write`.
 *
 * Everything below exists because the engine has no CAS on
 * `scripts.update` (`updateProjectScript` reads `branch.headHash` at
 * `project-manager.js:2076-2081` but never compares it to a caller-supplied
 * revision; plan/N2 3.2 `script_write` row and 改造项 R6). The optimistic lock
 * therefore lives here, in the tool, and the tool is the only writer.
 *
 * Pipeline (order is load-bearing):
 *   validate -> resolve current revision -> compare expectedRevision (CAS)
 *   -> pre-image capture -> type gate -> (dry-run stops here) -> PUT
 *   -> read-back verification (bytes + blob-name digest, in every name form)
 *   -> optional runtime acceptance
 *   -> on any blocking (severity: 'error') failure: PUT the pre-image back.
 *
 * Findings split in two and the split is deliberate: an ERROR means the bytes
 * are wrong and triggers the rollback; a WARNING means a check could not run
 * (unverifiable blob name form, idle runtime, no read-back channel) and is
 * carried in `unverified` / `unresolved` so "status OK" can never be claimed
 * over missing evidence, but a correct write is never destroyed for it.
 */
import { contentHash, verifyBlobName } from './cid.js'
import { checkScript } from './typegate.js'
import { judgeEvents, skippedBecauseRuntimeIdle } from './acceptance.js'
import { EngineError } from './engine-client.js'

const entryPattern = /^[A-Za-z0-9._-]{1,160}$/
const scriptMaxBytes = 20 * 1024 * 1024
const mapLocalEntries = new Set(['index.js', 'clientIndex.js'])

export class GuardError extends Error {
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'GuardError'
    this.code = code
    this.detail = extra
  }
}

function validate(args) {
  const side = args.side
  if (side !== 'client' && side !== 'server') {
    throw new GuardError('SCRIPT_SIDE_INVALID', 'side 必须是 client 或 server（packages/cli/src/index.ts:73-75）')
  }
  const entry = String(args.entry || '')
  if (!entryPattern.test(entry) || entry.includes('..')) {
    throw new GuardError('SCRIPT_ENTRY_INVALID', 'entry 必须是 1-160 位 [A-Za-z0-9._-] 且不含 ..')
  }
  if (typeof args.content !== 'string') {
    throw new GuardError('SCRIPT_CONTENT_REQUIRED', 'content 必须是字符串')
  }
  const bytes = Buffer.byteLength(args.content, 'utf8')
  if (bytes > scriptMaxBytes) {
    throw new GuardError('SCRIPT_CONTENT_TOO_LARGE', `content ${bytes} B 超过 20 MiB 协议上限`)
  }
  if (!String(args.mapId || '').trim()) throw new GuardError('MAP_ID_REQUIRED', 'mapId 必须是非空字符串')
  return { side, entry, content: args.content, bytes, mapId: String(args.mapId).trim() }
}

/**
 * Engine-side read of the revision chain. Disk is the only place
 * `branch.headHash` is observable without a new scope, so a missing
 * `BOX_MAP_PROJECTS_ROOT` degrades the lock to the script content hash
 * (still a real CAS for shared scripts, useless for map-local entries).
 */
function currentRevision(args, ctx, meta) {
  if (ctx.store && ctx.store.available) {
    try {
      const revision = ctx.store.readRevision(meta.mapId)
      return {
        source: 'branch.headHash',
        authority: 'local-disk(project-state.json -> permissionHash -> versionControl)',
        value: revision.headHash,
        branchName: revision.branchName,
        permissionHash: revision.permissionHash,
      }
    } catch (error) {
      if (!(error instanceof EngineError)) {
        throw new GuardError('REVISION_UNREADABLE', `乐观锁无法读取当前 headHash：${error.message}`, {
          code: error.code,
        })
      }
    }
  }
  if (!mapLocalEntries.has(meta.entry)) return undefined
  throw new GuardError(
    'REVISION_SOURCE_UNAVAILABLE',
    `乐观锁读不到 ${meta.entry} 的 revision：map-local 入口脚本不进共享脚本表，` +
      'GET .../scripts/{side}/{entry} 对它必定 404（project-manager.js:2200-2237），' +
      '请把 MCP 跑在能读工程目录的位置并设置 BOX_MAP_PROJECTS_ROOT。',
  )
}

async function fetchPreImage(args, ctx, meta) {
  if (!mapLocalEntries.has(meta.entry)) {
    try {
      const read = await ctx.request({
        method: 'GET',
        path: ctx.apiPath('projects', meta.mapId, 'scripts', meta.side, meta.entry),
        capability: 'scripts.read',
      })
      return { data: read.data, source: 'http-shared' }
    } catch (error) {
      // A brand-new shared script has no pre-image at all: the engine answers
      // 404 `Shared script not found` (project-manager.js:2225). Creation is
      // still a legal move, but it is not rollback-able through this route
      // (scripts/{side}/{entry} only supports GET and PUT), so the caller has
      // to opt in explicitly.
      if (error.code === 'SHARED_SCRIPTS_NOT_FOUND' || error.status === 404) {
        return { data: undefined, source: 'new-script' }
      }
      throw error
    }
  }
  if (ctx.store && ctx.store.available) {
    try {
      return { data: ctx.store.readMapLocalScript(meta.mapId, meta.entry, meta.side), source: 'local-disk' }
    } catch (error) {
      if (error.code === 'LOCAL_SCRIPT_NOT_FOUND') return { data: undefined, source: 'new-script' }
      throw error
    }
  }
  return { data: undefined, source: 'unavailable' }
}

function sameBytes(left, right) {
  return typeof left === 'string' && typeof right === 'string' && left === right
}

/**
 * @param {object} args mapId, side, entry, content, expectedRevision,
 *   confirm, dialect, typeGateMode, verify, verifyWaitMs, allowUnhedged
 * @param {{config, request, tail, apiPath, store}} ctx
 */
export async function writeScript(args, ctx) {
  const meta = validate(args)
  if (ctx.config.profile === 'readonly' || !ctx.config.allowWrite) {
    throw new GuardError(
      'WRITE_DISABLED',
      '本 MCP 实例以只读 profile 启动（BOX_MCP_PROFILE=readonly / BOX_MCP_ALLOW_WRITE=0），写工具不可用。',
    )
  }

  const revision = currentRevision(args, ctx, meta)
  const expected = args.expectedRevision === undefined ? undefined : String(args.expectedRevision)
  const revisionSource = revision ? revision.source : 'script_hash'
  const preImage = await fetchPreImage(args, ctx, meta)
  const currentToken = revision
    ? revision.value
    : preImage.data && preImage.data.hash

  if (expected !== undefined && currentToken !== undefined && expected !== currentToken) {
    throw new GuardError(
      'REVISION_CONFLICT',
      `乐观锁失败：expectedRevision=${expected} 与引擎当前 ${revisionSource}=${currentToken} 不一致，` +
        '说明有人（编辑器或另一个 agent）已经改过这张图。拒绝写入；请重读后再写。',
      { expected, current: currentToken, revisionSource },
    )
  }
  if (expected === undefined && args.confirm === true && args.allowUnhedged !== true) {
    throw new GuardError(
      'REVISION_REQUIRED',
      'confirm:true 必须带 expectedRevision（引擎的 scripts.update 没有 CAS，见 plan/N2 R6）。' +
        '先用 confirm:false 跑一次 dry-run 拿 currentRevision，再带回来。',
      { currentRevision: currentToken, revisionSource },
    )
  }
  if (currentToken === undefined && args.confirm === true && args.allowUnhedged !== true) {
    throw new GuardError(
      'REVISION_UNAVAILABLE',
      '当前 revision 不可读（新共享脚本还没有哈希），无法做乐观锁。' +
        '若确认这是首次创建该脚本，可显式传 allowUnhedged:true。',
    )
  }

  const gate = await checkScript(
    {
      content: meta.content ?? args.content,
      side: meta.side,
      dialect: args.dialect,
      mode: args.typeGateMode,
    },
    ctx.config,
  )
  if (!gate.satisfied) {
    throw new GuardError('TYPE_GATE_FAILED', `类型门未过（mode=${gate.mode}），未落盘。`, {
      errors: gate.errors,
      warnings: gate.warnings,
      notes: gate.notes,
    })
  }

  if (args.confirm !== true) {
    return {
      dryRun: true,
      wouldWrite: true,
      mapId: meta.mapId,
      side: meta.side,
      entry: meta.entry,
      contentBytes: meta.bytes,
      predictedHash: contentHash(args.content),
      // `storeReleaseBlob` (project-manager.js:196-205) only ever emits CIDv0,
      // so a write through this route can never produce a URL-safe name. That
      // asymmetry is asserted in test/script-write.test.js rather than assumed:
      // reading is where both forms show up.
      predictedNameForm: 'cidv0',
      currentRevision: currentToken,
      revisionSource,
      revision,
      preImageSource: preImage.source,
      isNewScript: !preImage.data,
      rollbackAvailable: Boolean(preImage.data),
      gate,
      engineNotes: [
        mapLocalEntries.has(meta.entry)
          ? 'index.js / clientIndex.js 会被引擎保持为 map-local 资产（project-manager.js:2086-2090），不写入共享脚本表。'
          : '非入口脚本默认进地图组共享表，会 bump group-state.revision 并 materialize 到全组（project-manager.js:2090-2160）。',
      ],
      next: '带 expectedRevision=currentRevision 且 confirm:true 再调一次即可写入。',
    }
  }

  if (!preImage.data && args.allowBlindWrite !== true) {
    throw new GuardError(
      'ROLLBACK_PREIMAGE_UNAVAILABLE',
      preImage.source === 'new-script'
        ? '这是一次新建脚本：`scripts/{side}/{entry}` 只有 GET/PUT，写坏了无法用同一入口删掉，所以必须显式 allowBlindWrite:true 才放行。'
        : '读不到写前内容，一旦写坏就没有可回滚的原内容。' +
          '请设置 BOX_MAP_PROJECTS_ROOT（map-local 入口脚本只能从盘上读），或显式 allowBlindWrite:true。',
    )
  }

  const written = await ctx.request({
    method: 'PUT',
    path: ctx.apiPath('projects', meta.mapId, 'scripts', meta.side, meta.entry),
    capability: 'scripts.update',
    body: { content: args.content },
  })
  const result = written.data

  const verification = await verifyReadBack(meta, result, ctx)
  // Only `severity: 'error'` findings may undo a write. A warning is evidence
  // that something could not be checked, not evidence that the write is bad;
  // rolling back on it would turn "unverifiable" into "known broken".
  const failures = verification.findings.filter((item) => item.severity === 'error')
  const unverified = verification.findings.filter((item) => item.severity !== 'error')
  // REAL DATA: a blob name can be CIDv0 *or* URL-safe SHA-256 (see cid.js).
  // The old guard only checked the CIDv0 form and therefore silently skipped
  // verification for every cloud-imported asset; both forms are content
  // addressed, so both are now checked, and a form that is not content
  // addressed (legacy UUID) is reported instead of being called a pass.
  const nameCheck = verifyBlobName(args.content, result.hash)
  if (nameCheck.verifiable && !nameCheck.verified) {
    failures.push({
      severity: 'error',
      code: 'HASH_MISMATCH',
      message:
        `引擎返回的 ${nameCheck.form} blob 名 ${nameCheck.actual} 与本地按同种算法从字节重算的 ${nameCheck.expected} 不一致：` +
        '说明字节在链路上被改过，立即回滚。',
      form: nameCheck.form,
      expected: nameCheck.expected,
    })
  } else if (!nameCheck.verifiable) {
    unverified.push({
      severity: 'warning',
      code: 'BLOB_NAME_FORM_UNVERIFIED',
      message:
        `引擎返回的 blob 名 ${nameCheck.actual} 是 ${nameCheck.form} 形式，无法从内容重算摘要，` +
        '"内容寻址一致"这一条本次未经验证；读回逐字节比对仍然执行了。',
      form: nameCheck.form,
    })
  }

  let acceptance
  const unresolved = []
  if (args.verify === true) {
    acceptance = await runAcceptance(meta, ctx, args)
    if (acceptance && acceptance.verdict === 'FAIL') failures.push(...acceptance.findings)
    else if (acceptance && !acceptance.passed) {
      // Absence of evidence must never be recorded as a pass, but it is also
      // not proof that the write broke the map: keep the write, flag it.
      unresolved.push(...acceptance.findings)
    }
  }

  let rollback
  if (failures.length && preImage.data) {
    rollback = await restorePreImage(meta, preImage.data.content, ctx)
    return {
      written: false,
      rolledBack: rollback.rolledBack,
      mapId: meta.mapId,
      side: meta.side,
      entry: meta.entry,
      writeResult: result,
      revisionBefore: currentToken,
      revisionSource,
      verification,
      acceptance,
      rollback,
      failures,
      unverified,
      gate,
      status: 'FAILED_ROLLED_BACK',
    }
  }

  return {
    written: true,
    rolledBack: false,
    mapId: meta.mapId,
    side: meta.side,
    entry: meta.entry,
    writeResult: result,
    revisionBefore: currentToken,
    revisionSource,
    verification,
    acceptance,
    rollback,
    failures,
    unresolved,
    unverified,
    gate,
    status: failures.length
      ? 'WRITTEN_WITH_UNRESOLVED_FAILURE'
      : unresolved.length
        ? 'WRITTEN_ACCEPTANCE_UNVERIFIED'
        : unverified.length
          ? 'WRITTEN_WITH_UNVERIFIED_CHECKS'
          : 'OK',
    engineNotes: [
      '引擎返回值里 revision 的语义不对称：共享脚本写回的是写前 headHash（project-manager.js:2160），' +
        'map-local 入口脚本写回的是新 headHash（:2197）。不要把它当成同一种 token 用。',
      verification.readBackSource === 'local-disk'
        ? 'map-local 脚本的读回来自盘上的 headHash 链，等价于出厂 reader 的重载路径。'
        : 'map-local 脚本无法通过 HTTP 读回（GET 只查共享表）；本次读回来源：' + verification.readBackSource,
    ],
  }
}

async function verifyReadBack(meta, result, ctx) {
  // `meta.content` is what we intended to store; during a rollback the caller
  // swaps in the pre-image so the comparison stays meaningful.
  const expected = meta.expectedContent ?? meta.content
  const findings = []
  if (mapLocalEntries.has(meta.entry)) {
    if (ctx.store && ctx.store.available) {
      try {
        const after = ctx.store.readMapLocalScript(meta.mapId, meta.entry, meta.side)
        if (after.hash !== result.hash) {
          findings.push({
            severity: 'error',
            code: 'READBACK_HASH_MISMATCH',
            message: `写后盘上 ${meta.entry} 的哈希是 ${after.hash}，引擎返回 ${result.hash}。`,
          })
        }
        if (!sameBytes(after.content, expected)) {
          findings.push({
            severity: 'error',
            code: 'CONTENT_MUTATED',
            message: '写后读回的字节与提交内容不同：引擎或链路改写了脚本正文。',
          })
        }
        // The name the engine put into `scriptAssets` has to be the content
        // address of the bytes it stored, in whichever form that is. A blob
        // whose name does not match its bytes survives on disk but disappears
        // from the play package (project-manager.js:54-60, plan/N2 5.2 C6).
        if (after.nameForm && after.nameForm.verifiable && !after.nameForm.verified) {
          findings.push({
            severity: 'error',
            code: 'READBACK_BLOB_NAME_MISMATCH',
            message:
              `盘上 ${meta.entry} 的 blob 名是 ${after.nameForm.form} 形式，但按该形式从字节重算得到 ` +
              `${after.nameForm.expected}，与文件名 ${after.hash} 不符：这份脚本能读到但进不了游玩包。`,
            expected: after.nameForm.expected,
            actual: after.hash,
          })
        }
        return { readBackSource: 'local-disk', reloadable: !findings.length, script: after, findings }
      } catch (error) {
        findings.push({
          severity: 'error',
          code: 'READBACK_FAILED',
          message: `出厂 reader 的盘侧等价校验失败（${error.code || ''} ${error.message}）：这张图现在可能载不回来。`,
        })
        return { readBackSource: 'local-disk', reloadable: false, findings }
      }
    }
    return {
      readBackSource: 'none',
      reloadable: undefined,
      findings: [
        {
          severity: 'warning',
          code: 'READBACK_UNVERIFIED',
          message:
            'map-local 入口脚本无法用 HTTP 读回，且未配置 BOX_MAP_PROJECTS_ROOT：' +
            '"写完还能被出厂 reader 载入"这一条本次未经验证。',
        },
      ],
    }
  }

  const read = await ctx.request({
    method: 'GET',
    path: ctx.apiPath('projects', meta.mapId, 'scripts', meta.side, meta.entry),
    capability: 'scripts.read',
  })
  if (read.data.hash !== result.hash) {
    findings.push({
      severity: 'error',
      code: 'READBACK_HASH_MISMATCH',
      message: `写后 GET 返回 ${read.data.hash}，PUT 返回 ${result.hash}。`,
    })
  }
  if (!sameBytes(read.data.content, expected)) {
    findings.push({
      severity: 'error',
      code: 'CONTENT_MUTATED',
      message: '写后 GET 的正文与提交正文逐字节不一致。',
    })
  }
  return { readBackSource: 'http-shared', reloadable: !findings.length, script: read.data, findings }
}

async function restorePreImage(meta, originalContent, ctx) {
  try {
    const restored = await ctx.request({
      method: 'PUT',
      path: ctx.apiPath('projects', meta.mapId, 'scripts', meta.side, meta.entry),
      capability: 'scripts.update',
      body: { content: originalContent },
    })
    // Verified by reading back through the same path the map will use, not by
    // trusting the PUT response alone.
    const check = await verifyReadBack({ ...meta, expectedContent: originalContent }, restored.data, ctx)
    const nameCheck = verifyBlobName(originalContent, restored.data.hash)
    const contentBack =
      (!nameCheck.verifiable || nameCheck.verified) &&
      check.findings.every((item) => item.severity !== 'error')
    return {
      rolledBack: contentBack,
      verification: check,
      result: restored.data,
      note:
        '回滚写回的是原内容字节，但引擎的 blob 是内容寻址、只增不改（project-manager.js:2053-2055），' +
        '所以版本链上会留下"改坏→再改回"两个 revision；内容等价、哈希不等价。' +
        '要回到真正的旧 revision 只能用工程快照/版本控制（切片 A 未暴露）。',
    }
  } catch (error) {
    return {
      rolledBack: false,
      error: { code: error.code, message: error.message },
      note: '回滚写入本身失败了：地图现在停在坏内容上，必须人工介入（旧内容见 preImage）。',
    }
  }
}

async function runAcceptance(meta, ctx, args) {
  const status = await ctx.request({
    method: 'GET',
    path: ctx.apiPath('projects', meta.mapId, 'runtime'),
    capability: 'runtime.view',
  })
  const skip = skippedBecauseRuntimeIdle(status.data)
  if (skip) return { ...skip, runtimeStatus: status.data }
  const tail = await ctx.tail(
    {
      path: ctx.apiPath('projects', meta.mapId, 'runtime', 'events'),
      capability: 'runtime.view',
      lastEventId: args.sinceEventId,
      maxEvents: args.maxEvents ?? 200,
      idleMs: args.verifyIdleMs ?? 1_500,
      timeoutMs: args.verifyWaitMs ?? 8_000,
    },
    ctx.config,
  )
  const verdict = judgeEvents(tail.events, { sinceId: args.sinceEventId })
  return { ...verdict, stopReason: tail.stopReason, runtimeStatus: status.data }
}

export { mapLocalEntries, validate as validateScriptWriteArgs }
