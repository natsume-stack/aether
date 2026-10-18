/**
 * TERRAIN domain: voxel writes through the engine's own `terrainInfo/terrainRead/
 * terrainApply/terrainRevert` tools (map-authoring-tools.ts:180-352).
 *
 * Ordering the engine forces on us, enforced here so an agent never has to
 * discover it by losing work:
 *   read revision -> (stop preview) -> terrain_apply -> map_save
 * because voxel chunk hashes are NOT recorded on save while the preview runs
 * (replica-server.ts:1602, restated in tool.ts:20-25 and save.ts).
 */
import {
  BUDGETS,
  assertWritable,
  callEngineTool,
  dangerScan,
  fail,
  terrainCellCount,
} from './_shared.js'

const regionSchema = {
  type: 'object',
  description:
    '轴对齐体素区域，min/max 都是 [x,y,z] 整数三元组，两端都包含（闭区间）。' +
    '越界不会报错而是被裁剪到 shape 内，裁剪后为空则报 TERRAIN_REGION_EMPTY —— 先用 terrain_info 拿 shape。',
  properties: {
    min: { type: 'array', description: '下界 [x,y,z]，含端点，0 <= v < shape' },
    max: { type: 'array', description: '上界 [x,y,z]，含端点，必须 >= 对应 min' },
  },
  required: ['min', 'max'],
  additionalProperties: false,
}

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

export function buildTerrainTools(ctx) {
  return [
    {
      name: 'terrain_info',
      description:
        '读地形元信息：体素网格尺寸 shape、预览是否在跑（previewRunning）、以及本次地形写的乐观锁令牌 revision。' +
        '任何 terrain_apply 之前都要先调它：region 要夹在 shape 内，expectedRevision 要取它给的 revision。' +
        '副作用：无（只采样，不写）。',
      inputSchema: {
        type: 'object',
        properties: {
          mapId: {
            type: 'string',
            description: '永久地图 ID（20 位小写十六进制）或本地工程目录名',
            minLength: 1,
            maxLength: 63,
          },
        },
        required: ['mapId'],
        additionalProperties: false,
      },
      annotations: readAnnotations('地形尺寸与 revision'),
      scope: 'loopback internal（无 creator/v1 scope）',
      handler: async (args) => {
        const result = await callEngineTool(ctx, args.mapId, 'terrainInfo', {})
        return {
          ...result,
          next: result.previewRunning
            ? '预览正在跑：地形写要 map_preview {action:"stop"} 之后再做，否则存不下体素。'
            : `可用 revision=${result.revision} 做 terrain_apply 的 expectedRevision；shape=${result.shape}。`,
        }
      },
    },
    {
      name: 'terrain_read',
      description:
        '读一块 region 的体素（返回每格打包后的 uint16：低 14 位类型 id，高 2 位旋转）+ 当前 revision。' +
        '写之前用它看现状、写之后用它验证。返回 revision 同样可以直接当 terrain_apply 的 expectedRevision。' +
        '副作用：无。返回上限：引擎侧默认 20000 格、最大 200000 格，超出会标 truncated。',
      inputSchema: {
        type: 'object',
        properties: {
          mapId: { type: 'string', minLength: 1, maxLength: 63 },
          region: regionSchema,
          limit: { type: 'integer', minimum: 1, maximum: 200_000, description: '最多返回多少格，默认 20000' },
        },
        required: ['mapId', 'region'],
        additionalProperties: false,
      },
      annotations: readAnnotations('读体素区域'),
      scope: 'loopback internal（无 creator/v1 scope）',
      handler: async (args) => {
        const result = await callEngineTool(
          ctx,
          args.mapId,
          'terrainRead',
          { region: args.region, limit: args.limit },
        )
        return {
          ...result,
          next: result.truncated
            ? `只返回了前 ${result.cells.length}/${result.total} 格，换更小的 region 或加大 limit 再看剩下的。`
            : `改这块之前把 revision=${result.revision} 当作 terrain_apply 的 expectedRevision。`,
        }
      },
    },
    {
      name: 'terrain_apply',
      description:
        `地形写：把一个 region 全部刷成同一个 block（可选 rotation）。引擎逐格 setVoxel 并返回 undoToken（回滚用）。` +
        `硬护栏：① 必须带 expectedRevision（terrain_info/terrain_read 的 revision），不一致就 REVISION_CONFLICT 拒绝，绝不覆盖；` +
        `② 本层单次上限 ${BUDGETS.TERRAIN_MAX_CELLS_PER_CALL} 格（按裁剪进 shape 后的实际格数算），引擎自身上限 500000；` +
        `③ 预览在跑时默认拒绝（PREVIEW_RUNNING，依据 replica-server.ts:1602：运行时不记录 voxel chunk hash），除非显式 allowWhileRunning:true 只改内存；` +
        `④ dryRun:true 只算改动集不写。写完必须 map_save 才落盘。副作用：改内存里的权威体素树。`,
      inputSchema: {
        type: 'object',
        properties: {
          mapId: { type: 'string', minLength: 1, maxLength: 63 },
          region: regionSchema,
          block: {
            type: 'integer',
            minimum: 0,
            maximum: 65535,
            description:
              '要写入的体素类型 id（低 14 位）。传打包 uint16 也接受，但不给 rotation 时高 2 位会被清掉。',
          },
          rotation: { type: 'integer', minimum: 0, maximum: 3, description: '可选 2 位旋转' },
          expectedRevision: {
            type: 'string',
            description: '乐观锁令牌：terrain_info 或 terrain_read 返回的 revision；不一致直接拒绝',
          },
          allowWhileRunning: {
            type: 'boolean',
            description: '预览运行中仍要改内存态时才传 true；落盘仍然要先停预览再 map_save',
          },
          dryRun: { type: 'boolean', description: 'true 只计算改动集与体积，不写任何东西' },
        },
        required: ['mapId', 'region', 'block', 'expectedRevision'],
        additionalProperties: false,
      },
      annotations: writeAnnotations('刷体素区域（带乐观锁与体积预算）'),
      scope: 'loopback internal（写内存 replica，map_save 才落盘）',
      handler: async (args) => {
        assertWritable(ctx, 'terrain_apply')
        dangerScan(
          { region: args.region, block: args.block, rotation: args.rotation },
          'terrain_apply',
        )
        const info = await callEngineTool(ctx, args.mapId, 'terrainInfo', {})
        const cells = terrainCellCount(args.region, info.shape)
        if (cells === 0) {
          fail({
            code: 'TERRAIN_REGION_EMPTY',
            message: `region 与 shape ${JSON.stringify(info.shape)} 求交后为 0 格`,
            retry: false,
            hint: '把 min/max 夹回 [0, shape[axis)-1]，且 max >= min；再看一次 terrain_info 的 shape。',
            shape: info.shape,
            region: args.region,
          })
        }
        if (cells > BUDGETS.TERRAIN_MAX_CELLS_PER_CALL) {
          fail({
            code: 'TERRAIN_BUDGET_EXCEEDED',
            message: `本次要写 ${cells} 格，超过本层单次上限 ${BUDGETS.TERRAIN_MAX_CELLS_PER_CALL} 格`,
            retry: false,
            hint:
              `拆成 ${Math.ceil(cells / BUDGETS.TERRAIN_MAX_CELLS_PER_CALL)} 块以内，每块 <= ${BUDGETS.TERRAIN_MAX_CELLS_PER_CALL} 格，` +
              `逐块 terrain_apply（每块都要用最新 revision 重取 expectedRevision）。` +
              `依据：undoToken 每格约 45-60 B，${BUDGETS.TERRAIN_MAX_CELLS_PER_CALL} 格约 6 MiB，` +
              '留出对 32 MiB 上游体积限制（Next tool.ts + ai-tool-route.ts）的回滚余量。',
            cells,
            limit: BUDGETS.TERRAIN_MAX_CELLS_PER_CALL,
            engineLimit: 500_000,
          })
        }
        if (info.previewRunning && args.allowWhileRunning !== true) {
          fail({
            code: 'PREVIEW_RUNNING',
            message: '预览正在运行：地形写会被引擎拒（保存不记体素 chunk）',
            retry: true,
            hint:
              '固定顺序：map_preview {action:"stop"} → terrain_apply → map_save。' +
              '依据 replica-server.ts:1602：预览在跑时保存不会记录 voxel chunk hash，所以现在写进去的地形落不了盘。' +
              '只想改内存态（不落盘）才传 allowWhileRunning:true。',
            shape: info.shape,
            currentRevision: info.revision,
          })
        }
        if (
          typeof args.expectedRevision === 'string' &&
          typeof info.revision === 'string' &&
          args.expectedRevision !== info.revision
        ) {
          fail({
            code: 'REVISION_CONFLICT',
            message: `expectedRevision=${args.expectedRevision} 与当前地形 revision=${info.revision} 不一致`,
            retry: true,
            hint: '有人（编辑器/另一个 agent/上一次成功的 apply）动过地形。重新 terrain_info 取 revision 再写。',
            expected: args.expectedRevision,
            current: info.revision,
            revisionAuthority: 'engine（computeTerrainRevision，map-authoring-tools.ts:58）',
          })
        }
        const result = await callEngineTool(ctx, args.mapId, 'terrainApply', {
          region: args.region,
          block: args.block,
          rotation: args.rotation,
          expectedRevision: args.expectedRevision,
          allowWhileRunning: args.allowWhileRunning,
          dryRun: args.dryRun,
        })
        const undoBytes = Buffer.byteLength(String(result.undoToken || ''), 'utf8')
        return {
          ...result,
          requestedCells: cells,
          budgetLimit: BUDGETS.TERRAIN_MAX_CELLS_PER_CALL,
          undoTokenBytes: undoBytes,
          revertHint: result.dryRun
            ? 'dryRun 没有改动任何东西，去掉 dryRun 并用 newRevision 作为 expectedRevision 才真正落内存。'
            : `要撤销这次改动：terrain_revert {undoToken}（${undoBytes} B）。`,
          persistHint: result.dryRun
            ? undefined
            : '改动只在内存 replica 里：必须 map_save 才会写进盘上的地图；预览在跑时保存会丢体素 chunk。',
          next: result.dryRun
            ? `dryRun 通过：改动集 ${result.changed} 格，用 newRevision=${result.newRevision} 直接再调一次（dryRun 去掉）。`
            : `写后 revision=${result.newRevision}；下一步 map_save（若预览没在跑）。`,
        }
      },
    },
    {
      name: 'terrain_revert',
      description:
        '用 terrain_apply 返回的 undoToken 逐格回放旧值，把地形滚回去。写坏了先滚再说，不要拿新 apply 盖。' +
        'undoToken 可达数 MB，本层给它 120 s 的上游预算。滚完同样要 map_save 才落盘。' +
        '副作用：改内存体素树（把值改回改动前）。',
      inputSchema: {
        type: 'object',
        properties: {
          mapId: { type: 'string', minLength: 1, maxLength: 63 },
          undoToken: {
            type: 'string',
            description: 'terrain_apply 原样返回的 undoToken（JSON 数组 [{x,y,z,prev}]）',
            minLength: 2,
          },
        },
        required: ['mapId', 'undoToken'],
        additionalProperties: false,
      },
      annotations: writeAnnotations('回放 undoToken 回滚地形'),
      scope: 'loopback internal（写内存 replica，map_save 才落盘）',
      handler: async (args) => {
        assertWritable(ctx, 'terrain_revert')
        const before = await callEngineTool(ctx, args.mapId, 'terrainInfo', {})
        let parsed
        try {
          parsed = JSON.parse(args.undoToken)
        } catch (error) {
          fail({
            code: 'UNDO_TOKEN_UNPARSEABLE',
            message: `undoToken 不是合法 JSON：${error.message}`,
            retry: false,
            hint: '把 terrain_apply 返回的 undoToken 原样传回来（不要截断、不要再编码）；' +
              `本次地形 revision 仍是 ${before.revision}，可以先确认现状再决定是否需要重建改动。`,
          })
        }
        if (!Array.isArray(parsed)) {
          fail({
            code: 'UNDO_TOKEN_UNPARSEABLE',
            message: 'undoToken 解析出来不是数组，拒绝回放',
            retry: false,
            hint: '只接受 terrain_apply 原样返回的 undoToken。',
          })
        }
        if (parsed.length > BUDGETS.TERRAIN_MAX_CELLS_PER_CALL) {
          fail({
            code: 'TERRAIN_BUDGET_EXCEEDED',
            message: `undoToken 覆盖 ${parsed.length} 格，超过本层单次上限 ${BUDGETS.TERRAIN_MAX_CELLS_PER_CALL}`,
            retry: false,
            hint: '把 undoToken 按格切片，分多次 terrain_revert（每次都要重新 terrain_info 取 revision）。',
            cells: parsed.length,
          })
        }
        const result = await callEngineTool(ctx, args.mapId, 'terrainRevert', {
          undoToken: args.undoToken,
        })
        return {
          ...result,
          restoredRatio: `${result.restored}/${parsed.length}`,
          revisionBefore: before.revision,
          persistHint: '回滚只在内存里：还要 map_save 才写回盘。',
          next: `已恢复 ${result.restored} 格，当前 revision=${result.newRevision}；核对用 terrain_read，落盘用 map_save。`,
        }
      },
    },
  ]
}
