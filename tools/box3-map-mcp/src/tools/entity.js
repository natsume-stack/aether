/**
 * ENTITY domain: the placement half of the map (create / create-from-model /
 * update / move / delete / copy), wired to the engine's `createEntityTools`
 * (entity-tools.ts:247-812) through the loopback internal tool route.
 *
 * CAS reality, stated instead of faked: NONE of these engine tools take an
 * `expectedRevision`. The engine writes straight into the authoritative
 * transaction. So the lock is computed here, over a canonical snapshot of
 * `listEntities`, immediately before the call — check-then-write, not atomic.
 * `revisionAuthority` in every result says exactly which side holds the lock,
 * and `snapshotIncomplete` flags the case where the engine's 50-row echo makes
 * the snapshot partial (entity-tools.ts:461-464).
 */
import {
  BUDGETS,
  assertWritable,
  callEngineTool,
  dangerScan,
  fail,
  requireClientRevision,
  snapshotRevision,
} from './_shared.js'

const KIND = 'entity'

const readAnnotations = (title) => ({
  title,
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
})

const writeAnnotations = (title, destructive = false) => ({
  title,
  readOnlyHint: false,
  destructiveHint: destructive,
  idempotentHint: false,
  openWorldHint: true,
})

const mapIdProperty = {
  mapId: { type: 'string', minLength: 1, maxLength: 63, description: '永久地图 ID（20 位小写十六进制）或本地工程目录名' },
}

const expectedRevisionProperty = (how) => ({
  type: 'string',
  description:
    `乐观锁令牌：${how} 返回的 revision。引擎这类工具本身没有 CAS，锁由本层在调用前校验；` +
    '不匹配就 REVISION_CONFLICT 拒绝，绝不覆盖。确认不需要锁才传 allowUnhedged:true。',
})

const positionProperty = {
  type: 'array',
  description: '世界坐标 [x,y,z]（实体中心）；三个数字，不是对象',
  minItems: 3,
  maxItems: 3,
}

/** Canonical, order-independent projection of what `listEntities` echoes. */
export function entitySnapshot(entities) {
  const rows = (entities || []).map((node) => ({
    id: String(node.id),
    name: node.name === undefined ? null : node.name,
    parentId: node.parentId === undefined ? null : String(node.parentId),
    mesh: node.mesh === undefined ? null : node.mesh,
    position: Array.isArray(node.position) ? node.position : null,
  }))
  rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return rows
}

async function readEntityList(ctx, mapId) {
  const result = await callEngineTool(ctx, mapId, 'listEntities', {})
  const rows = entitySnapshot(result.entities)
  return {
    revision: snapshotRevision(KIND, { total: result.total ?? rows.length, rows }),
    rows,
    total: result.total ?? rows.length,
    snapshotIncomplete: (result.total ?? rows.length) > rows.length,
  }
}

function assertEntityBudget(count, operation) {
  if (!(count > 0)) {
    fail({
      code: 'ENTITY_BATCH_EMPTY',
      message: `${operation} 至少要有一个实体`,
      retry: false,
      hint: 'entities / entityIds 不能是空数组：空数组会被引擎当成"什么也不做"，那是静默失败。',
    })
  }
  if (count > BUDGETS.ENTITY_MAX_PER_CALL) {
    fail({
      code: 'ENTITY_BUDGET_EXCEEDED',
      message: `${operation} 一次要处理 ${count} 个实体，超过本层上限 ${BUDGETS.ENTITY_MAX_PER_CALL}`,
      retry: false,
      hint:
        `分 ${Math.ceil(count / BUDGETS.ENTITY_MAX_PER_CALL)} 批以内，每批 <= ${BUDGETS.ENTITY_MAX_PER_CALL}。` +
        '依据：引擎每个实体单独 projectTransaction().commit()（entity-tools.ts:283-318），' +
        '一批 N 个就是 N 次事务，同时读回侧只回显前 50 行，批次越大 revision 快照越不可信。',
        count,
      limit: BUDGETS.ENTITY_MAX_PER_CALL,
    })
  }
}

export function buildEntityTools(ctx) {
  return [
    {
      name: 'entity_list',
      description:
        '列出图里的实体（id / name / parentId / position / mesh）并给出本层算出的 revision。' +
        '所有 entity_* 写操作的 expectedRevision 都取自这里。' +
        '已知上限：引擎只回显前 50 行（entity-tools.ts:461），超过时 snapshotIncomplete=true，' +
        '说明这把锁只覆盖前 50 行 + 总数，别把它当全图 CAS。副作用：无。',
      inputSchema: { type: 'object', properties: { ...mapIdProperty }, required: ['mapId'], additionalProperties: false },
      annotations: readAnnotations('实体清单与 revision'),
      scope: 'loopback internal（无 creator/v1 scope）',
      handler: async (args) => {
        const snapshot = await readEntityList(ctx, args.mapId)
        const raw = await callEngineTool(ctx, args.mapId, 'listEntities', {})
        return {
          ...raw,
          revision: snapshot.revision,
          revisionAuthority: 'mcp-layer（sha256 over listEntities 回显；引擎无 CAS）',
          snapshotIncomplete: snapshot.snapshotIncomplete,
          next: snapshot.snapshotIncomplete
            ? `引擎只返回了 ${snapshot.rows.length}/${snapshot.total} 行：把 revision 当作部分锁用，或删掉不要的实体后再写。`
            : `写实体时把 revision=${snapshot.revision} 作为 expectedRevision 带回来。`,
        }
      },
    },
    {
      name: 'entity_create',
      description:
        `放实体。entities 数组一次最多 ${BUDGETS.ENTITY_MAX_PER_CALL} 个，每项二选一：` +
        'A) {name, parentId?, position?, mesh?, tags?} 走引擎 createEntity（裸节点）；' +
        'B) {modelId, name?, parentId?, position?} 走引擎 createEntityFromModel（带 meshId/bounds/scale 的完整模型实例，' +
        'modelId 取自 model_list；模型元数据取不到会报 Failed to retrieve model metadata）。' +
        '必须先 entity_list 拿 expectedRevision。任一项失败就把本次已建的实体删掉并回报 rolledBack。' +
        '副作用：写内存实体树，要 map_save 才落盘。',
      inputSchema: {
        type: 'object',
        properties: {
          ...mapIdProperty,
          entities: {
            type: 'array',
            description: `要放的实体数组，1-${BUDGETS.ENTITY_MAX_PER_CALL} 项`,
            minItems: 1,
            maxItems: BUDGETS.ENTITY_MAX_PER_CALL,
          },
          expectedRevision: expectedRevisionProperty('entity_list'),
          allowUnhedged: { type: 'boolean', description: '明知没有乐观锁也要写（默认禁止）' },
        },
        required: ['mapId', 'entities', 'expectedRevision'],
        additionalProperties: false,
      },
      annotations: writeAnnotations('放置实体（批量 + 回滚）'),
      scope: 'loopback internal（写内存实体树，map_save 才落盘）',
      handler: async (args) => {
        assertWritable(ctx, 'entity_create')
        const items = Array.isArray(args.entities) ? args.entities : []
        assertEntityBudget(items.length, 'entity_create')
        items.forEach((item, index) => dangerScan(item, `entity_create.entities[${index}]`))
        for (const item of items) {
          if (item && item.modelId !== undefined && typeof item.modelId !== 'number') {
            fail({
              code: 'MODEL_ID_TYPE',
              message: `entities[].modelId 必须是数字（引擎按 modelId === number 匹配资产，entity-tools.ts:718）`,
              retry: false,
              hint: `第 ${items.indexOf(item)} 项传的是 ${typeof item.modelId}；model_list 返回的 id 就是数字，原样用它。`,
            })
          }
        }
        const snapshot = await readEntityList(ctx, args.mapId)
        const lock = await requireClientRevision({
          current: snapshot.revision,
          expected: args.expectedRevision,
          kind: '实体树',
          authority: 'mcp-layer（引擎 createEntity/createEntityFromModel 无 CAS）',
          allowUnhedged: args.allowUnhedged,
          next: 'entity_list',
        })
        const created = []
        const failures = []
        for (const [index, item] of items.entries()) {
          const useModel = item && item.modelId !== undefined
          try {
            const result = await callEngineTool(
              ctx,
              args.mapId,
              useModel ? 'createEntityFromModel' : 'createEntity',
              useModel
                ? { modelId: item.modelId, name: item.name, parentId: item.parentId, position: item.position }
                : {
                    name: item.name,
                    parentId: item.parentId,
                    position: item.position,
                    mesh: item.mesh,
                    tags: item.tags,
                  },
            )
            if (!result || !result.entityId) {
              failures.push({ index, item, result })
              break
            }
            created.push({ index, entityId: result.entityId, via: useModel ? 'model' : 'raw' })
          } catch (error) {
            failures.push({ index, item, cause: error, error: { code: error.code, message: error.message, hint: error.hint } })
            break
          }
        }
        if (failures.length) {
          // First item failed and nothing exists yet => propagate the real code
          // instead of wrapping it (same rule as the UI domain).
          if (!created.length) throw failures[0].cause
          let rollback = { attempted: false, rolledBack: false }
          if (created.length) {
            try {
              await callEngineTool(ctx, args.mapId, 'deleteEntity', {
                entityIds: created.map((row) => row.entityId),
              })
              rollback = { attempted: true, rolledBack: true, removedIds: created.map((row) => row.entityId) }
            } catch (error) {
              rollback = {
                attempted: true,
                rolledBack: false,
                orphanIds: created.map((row) => row.entityId),
                error: { code: error.code, message: error.message, hint: error.hint },
              }
            }
          }
          fail({
            code: 'ENTITY_CREATE_FAILED',
            message: `第 ${failures[0].index} 个实体创建失败，本次共 ${created.length} 个已成功`,
            retry: true,
            hint: rollback.rolledBack
              ? `已把本次创建的 ${created.length} 个实体删掉（图回到写前状态）。按 failure 里的原因修参数，重新 entity_list 取 revision 再写。`
              : rollback.attempted
                ? `回滚也失败了：残留实体 id 见 rollback.orphanIds，用 entity_delete 手工清掉再重试，否则图里会有半成品。`
                : '没有产生残留实体。按 failure 里的原因修参数，重新 entity_list 取 revision 再写。',
            created,
            failures,
            rollback,
            revisionAuthority: lock.authority,
          })
        }
        const after = await readEntityList(ctx, args.mapId)
        return {
          success: true,
          created,
          entityIds: created.map((row) => row.entityId),
          revisionBefore: snapshot.revision,
          revision: after.revision,
          revisionAuthority: 'mcp-layer（引擎无 CAS，本层前置校验）',
          persistHint: '实体只在内存 replica 里：map_save 之后才进盘上地图。',
          next: `已放置 ${created.length} 个实体；后续写的 expectedRevision=${after.revision}；要落盘调 map_save。`,
        }
      },
    },
    {
      name: 'entity_update',
      description:
        '改一个实体的属性（position / rotation / scale / tint / mesh / bounds 等，键名按 EntitySeedRDA 的字段）。' +
        '引擎按 RDA schema 递归派发（entity-tools.ts:346-444），路径不存在的键只会 console.warn，' +
        '所以写完必须 entity_list 读回确认。改前必须 entity_list 拿 expectedRevision（写单实体也校验整棵树的快照）。' +
        '副作用：写内存实体树，要 map_save 才落盘。一次只改一个实体。',
      inputSchema: {
        type: 'object',
        properties: {
          ...mapIdProperty,
          entityId: { type: 'string', description: '实体 id（entity_list 返回的数字串，不是 name）', minLength: 1 },
          properties: { type: 'object', description: '要更新的字段集合，例如 {position:[0,10,0], scale:[1,1,1]}' },
          expectedRevision: expectedRevisionProperty('entity_list'),
          allowUnhedged: { type: 'boolean', description: '明知没有乐观锁也要写（默认禁止）' },
        },
        required: ['mapId', 'entityId', 'properties', 'expectedRevision'],
        additionalProperties: false,
      },
      annotations: writeAnnotations('改实体属性'),
      scope: 'loopback internal（写内存实体树，map_save 才落盘）',
      handler: async (args) => {
        assertWritable(ctx, 'entity_update')
        dangerScan(args.properties, 'entity_update.properties')
        const keys = Object.keys(args.properties || {})
        if (!keys.length) {
          fail({
            code: 'ENTITY_UPDATE_EMPTY',
            message: 'properties 是空对象，这次调用什么也不会改',
            retry: false,
            hint: '要么给出要改的字段，要么别调；空写会让 revision 看起来"没变"，误导后续判断。',
          })
        }
        const snapshot = await readEntityList(ctx, args.mapId)
        if (!snapshot.rows.some((row) => row.id === String(args.entityId))) {
          fail({
            code: 'ENTITY_NOT_FOUND',
            message: `entityId=${args.entityId} 不在 entity_list 的快照里`,
            retry: false,
            hint:
              `当前可见 id（前 ${snapshot.rows.length} 个）：${snapshot.rows.map((row) => row.id).join(', ') || '（空图）'}。` +
              '引擎的 updateEntity 对不存在的 id 不会报错，所以必须在这里挡住。',
            total: snapshot.total,
          })
        }
        const lock = await requireClientRevision({
          current: snapshot.revision,
          expected: args.expectedRevision,
          kind: '实体树',
          authority: 'mcp-layer（引擎 updateEntity 无 CAS）',
          allowUnhedged: args.allowUnhedged,
          next: 'entity_list',
        })
        const result = await callEngineTool(ctx, args.mapId, 'updateEntity', {
          entityId: String(args.entityId),
          properties: args.properties,
        })
        const after = await readEntityList(ctx, args.mapId)
        const readBack = after.rows.find((row) => row.id === String(args.entityId))
        return {
          ...result,
          updatedKeys: keys,
          revisionBefore: snapshot.revision,
          revision: after.revision,
          readBack,
          revisionAuthority: lock.authority,
          verifyHint:
            '引擎对无效路径只 console.warn，不报错：readBack 就是写后真实状态，字段没出现在 readBack 里说明这条更新没落地。',
          next: `核对 readBack 后继续写就用 expectedRevision=${after.revision}；落盘用 map_save。`,
        }
      },
    },
    {
      name: 'entity_move',
      description:
        '把实体搬到新的 [x,y,z]（entity_update 的窄口径版本，只动 position，参数更少更不容易写错）。' +
        '需要 entity_list 的 expectedRevision。副作用：写内存实体树，map_save 才落盘。',
      inputSchema: {
        type: 'object',
        properties: {
          ...mapIdProperty,
          entityId: { type: 'string', minLength: 1 },
          position: positionProperty,
          expectedRevision: expectedRevisionProperty('entity_list'),
          allowUnhedged: { type: 'boolean' },
        },
        required: ['mapId', 'entityId', 'position', 'expectedRevision'],
        additionalProperties: false,
      },
      annotations: writeAnnotations('搬动实体'),
      scope: 'loopback internal（写内存实体树，map_save 才落盘）',
      handler: async (args) => {
        assertWritable(ctx, 'entity_move')
        dangerScan(args.position, 'entity_move.position')
        const snapshot = await readEntityList(ctx, args.mapId)
        await requireClientRevision({
          current: snapshot.revision,
          expected: args.expectedRevision,
          kind: '实体树',
          authority: 'mcp-layer（引擎 moveEntity 无 CAS）',
          allowUnhedged: args.allowUnhedged,
          next: 'entity_list',
        })
        const result = await callEngineTool(ctx, args.mapId, 'moveEntity', {
          entityId: String(args.entityId),
          position: args.position,
        })
        const after = await readEntityList(ctx, args.mapId)
        return {
          ...result,
          revision: after.revision,
          readBack: after.rows.find((row) => row.id === String(args.entityId)),
          next: `搬完的 revision=${after.revision}；落盘 map_save。`,
        }
      },
    },
    {
      name: 'entity_delete',
      description:
        `删实体（一次最多 ${BUDGETS.ENTITY_MAX_PER_CALL} 个 id）。破坏性：默认 confirm:false 只返回将要删的清单（plan），` +
        'confirm:true 才真删；同时必须带 entity_list 的 expectedRevision，防止删掉别人刚放的东西。' +
        '注意引擎按 id 删除，父节点删掉后子节点的 parentId 不会自动重挂——要连子树一起删就把子孙 id 都列进来。' +
        '副作用：改内存实体树，map_save 才落盘；删掉的实体没有 undoToken，只能靠 map_save 之前的版本控制回退。',
      inputSchema: {
        type: 'object',
        properties: {
          ...mapIdProperty,
          entityIds: { type: 'array', minItems: 1, maxItems: BUDGETS.ENTITY_MAX_PER_CALL, description: '要删除的实体 id 数组' },
          expectedRevision: expectedRevisionProperty('entity_list'),
          confirm: { type: 'boolean', description: 'false=dry-run 只出计划；true 才真删（默认 false）' },
          allowUnhedged: { type: 'boolean' },
        },
        required: ['mapId', 'entityIds', 'expectedRevision'],
        additionalProperties: false,
      },
      annotations: writeAnnotations('删除实体（需 confirm）', true),
      scope: 'loopback internal（破坏性写，map_save 才落盘）',
      handler: async (args) => {
        assertWritable(ctx, 'entity_delete')
        const ids = (args.entityIds || []).map(String)
        assertEntityBudget(ids.length, 'entity_delete')
        const snapshot = await readEntityList(ctx, args.mapId)
        const missing = ids.filter((id) => !snapshot.rows.some((row) => row.id === id))
        if (missing.length) {
          fail({
            code: 'ENTITY_NOT_FOUND',
            message: `这些 id 不在快照里：${missing.join(', ')}`,
            retry: false,
            hint:
              '引擎 deleteEntity 对不存在的 id 静默成功，所以本层拒绝：先 entity_list 核对 id，' +
              '把确实存在的 id 再传一次（可能它已经被删掉了）。',
            missing,
            total: snapshot.total,
          })
        }
        await requireClientRevision({
          current: snapshot.revision,
          expected: args.expectedRevision,
          kind: '实体树',
          authority: 'mcp-layer（引擎 deleteEntity 无 CAS）',
          allowUnhedged: args.allowUnhedged,
          next: 'entity_list',
        })
        if (args.confirm !== true) {
          return {
            dryRun: true,
            wouldDelete: ids,
            matched: snapshot.rows.filter((row) => ids.includes(row.id)),
            revision: snapshot.revision,
            next: `带 confirm:true 且 expectedRevision=${snapshot.revision} 再调一次即真删。删除没有 undoToken，先想清楚。`,
          }
        }
        const result = await callEngineTool(ctx, args.mapId, 'deleteEntity', { entityIds: ids })
        const after = await readEntityList(ctx, args.mapId)
        const survivors = ids.filter((id) => after.rows.some((row) => row.id === id))
        return {
          ...result,
          deleted: ids,
          survivors,
          revisionBefore: snapshot.revision,
          revision: after.revision,
          persistHint: '删除只在内存里：map_save 才写回盘。',
          next: survivors.length
            ? `这些 id 删完仍在树里：${survivors.join(', ')}（引擎静默失败），别 map_save，先 entity_list 复核。`
            : `确认已删 ${ids.length} 个；新的 expectedRevision=${after.revision}；落盘 map_save。`,
        }
      },
    },
    {
      name: 'entity_copy',
      description:
        `原地复制实体（含整棵子树，entity-tools.ts:528-573）。一次最多 ${BUDGETS.ENTITY_MAX_PER_CALL} 个源 id，` +
        '返回 newEntityIds（新 id 是引擎随机数，别自己猜）。复制不会自动偏移位置，复制完通常要 entity_move。' +
        '需要 entity_list 的 expectedRevision。副作用：写内存实体树，map_save 才落盘。',
      inputSchema: {
        type: 'object',
        properties: {
          ...mapIdProperty,
          entityIds: { type: 'array', minItems: 1, maxItems: BUDGETS.ENTITY_MAX_PER_CALL },
          expectedRevision: expectedRevisionProperty('entity_list'),
          allowUnhedged: { type: 'boolean' },
        },
        required: ['mapId', 'entityIds', 'expectedRevision'],
        additionalProperties: false,
      },
      annotations: writeAnnotations('复制实体（含子树）'),
      scope: 'loopback internal（写内存实体树，map_save 才落盘）',
      handler: async (args) => {
        assertWritable(ctx, 'entity_copy')
        const ids = (args.entityIds || []).map(String)
        assertEntityBudget(ids.length, 'entity_copy')
        const snapshot = await readEntityList(ctx, args.mapId)
        const missing = ids.filter((id) => !snapshot.rows.some((row) => row.id === id))
        if (missing.length) {
          fail({
            code: 'ENTITY_NOT_FOUND',
            message: `要复制的 id 不在快照里：${missing.join(', ')}`,
            retry: false,
            hint: '引擎 copyEntities 对不存在的 id 会静默跳过（entity-tools.ts:533-536），所以这里拒绝；先 entity_list 核对。',
            missing,
          })
        }
        await requireClientRevision({
          current: snapshot.revision,
          expected: args.expectedRevision,
          kind: '实体树',
          authority: 'mcp-layer（引擎 copyEntities 无 CAS）',
          allowUnhedged: args.allowUnhedged,
          next: 'entity_list',
        })
        const before = new Set(snapshot.rows.map((row) => row.id))
        const result = await callEngineTool(ctx, args.mapId, 'copyEntities', { entityIds: ids })
        const after = await readEntityList(ctx, args.mapId)
        const fresh = after.rows.filter((row) => !before.has(row.id)).map((row) => row.id)
        return {
          ...result,
          reportedNewIds: result.newEntityIds || [],
          detectedNewIds: fresh,
          revision: after.revision,
          persistHint: '复制出来的实体同样要 map_save 才落盘。',
          next:
            (result.newEntityIds || []).length !== fresh.length
              ? `引擎回报 ${result.newEntityIds?.length ?? 0} 个新 id，但快照只看得见 ${fresh.length} 个（可能因为只回显前 50 行）；` +
                `用 detectedNewIds 做后续 move，别信 id 数量。新的 expectedRevision=${after.revision}。`
              : `复制出 ${fresh.length} 个实体：${fresh.join(', ')}。接着 entity_move 摆位，或 map_save 落盘。`,
        }
      },
    },
  ]
}
