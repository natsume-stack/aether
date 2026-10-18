/**
 * MODEL domain: the "give the map a prop" half of the pipeline.
 *
 * Ground truth from the engine source, reflected in the tool descriptions
 * instead of being discovered at run time:
 *   - `getProjectModels` (entity-tools.ts:609-653) reads
 *     `state.replica.extraProjectInfo.meshAssets` — i.e. what is ALREADY in the
 *     project. It is the only working model read surface.
 *   - `searchPublicModels` (entity-tools.ts:655-674) is a hard-coded empty
 *     stub in the local engine ("Public model search is unavailable in the local
 *     engine"), so `model_search_public` reports `unavailable:true`.
 *   - `addModelToProject` (entity-tools.ts:676-683) declares an inputSchema but
 *     NO `execute`, so the internal router answers 501 TOOL_NOT_EXECUTABLE. The
 *     tool is still exposed (it is part of the engine surface lane A must not
 *     silently drop) but its description states the refusal up front.
 * Putting a model into the map therefore goes: model_list -> entity_create
 * with {modelId}, or entity_create with a raw mesh path.
 */
import { BUDGETS, assertWritable, callEngineTool, dangerScan } from './_shared.js'

const readAnnotations = (title) => ({
  title,
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
})

export function buildModelTools(ctx) {
  return [
    {
      name: 'model_list',
      description:
        '列工程里已有的模型资产（{id, name}，name 已剥掉 mesh/ 前缀和 .vb 后缀）。' +
        'entity_create 用 {modelId} 放实体、terrain/entity 的 mesh 字段用这个名字。' +
        '数据源是运行时副本的 extraProjectInfo.meshAssets（entity-tools.ts:625），所以只有"这张图已经带进来的资产"，' +
        '不含公共资源库（本地引擎的公共检索是空壳，见 model_search_public）。副作用：无。',
      inputSchema: {
        type: 'object',
        properties: {
          mapId: { type: 'string', minLength: 1, maxLength: 63 },
          limit: { type: 'integer', minimum: 1, maximum: 500, description: '默认 20' },
          offset: { type: 'integer', minimum: 0, description: '分页偏移，默认 0' },
          modelName: { type: 'string', maxLength: 120, description: '按名字子串过滤（不区分大小写）' },
        },
        required: ['mapId'],
        additionalProperties: false,
      },
      annotations: readAnnotations('工程模型资产清单'),
      scope: 'loopback internal（无 creator/v1 scope）',
      handler: async (args) => {
        const result = await callEngineTool(ctx, args.mapId, 'getProjectModels', {
          limit: args.limit,
          offset: args.offset,
          modelName: args.modelName,
        })
        const models = result.models || []
        return {
          ...result,
          returned: models.length,
          hasMore: (result.total ?? models.length) > (args.offset || 0) + models.length,
          next: models.length
            ? `放实体：entity_create {entities:[{modelId:${models[0].id}, name:"...", position:[x,y,z]}], expectedRevision:<entity_list 的 revision>}。`
            : '这张图还没有模型资产。本地引擎不能从公共库导入（model_add_to_project 是 501 空壳），' +
              '要么用 entity_create 的 mesh 字段直接引用已存在的 mesh 路径，要么等资源面（map_resources）里带进来的资产。',
        }
      },
    },
    {
      name: 'model_search_public',
      description:
        '搜公共模型库。**当前本地引擎里它是空实现**：引擎固定返回 models:[] 和 ' +
        '"Public model search is unavailable in the local engine."（entity-tools.ts:655-674）。' +
        '本工具照实透传并标 unavailable:true，避免让上层以为"库里没货"。' +
        '真要接公共库得等泳道 B/C 补引擎侧实现。副作用：无。',
      inputSchema: {
        type: 'object',
        properties: {
          mapId: { type: 'string', minLength: 1, maxLength: 63 },
          query: { type: 'string', minLength: 1, maxLength: 120, description: '搜索词' },
          limit: { type: 'integer', minimum: 1, maximum: 200 },
          offset: { type: 'integer', minimum: 0 },
        },
        required: ['mapId', 'query'],
        additionalProperties: false,
      },
      annotations: readAnnotations('公共模型检索（引擎为空壳）'),
      scope: 'loopback internal（无 creator/v1 scope）',
      handler: async (args) => {
        const result = await callEngineTool(ctx, args.mapId, 'searchPublicModels', {
          query: args.query,
          limit: args.limit,
          offset: args.offset,
        })
        const empty = (result.models || []).length === 0
        return {
          ...result,
          unavailable: empty && /unavailable/i.test(String(result.message || '')),
          next: empty
            ? '公共库检索在本地引擎里没有实现，别把这次空结果理解成"没有这个模型"。改走 model_list 用图内资产。'
            : '引擎返回了内容，按 model_list 的用法放实体。',
        }
      },
    },
    {
      name: 'model_add_to_project',
      description:
        `把公共模型加进工程资产。一次最多 ${BUDGETS.ENTITY_MAX_PER_CALL} 个 modelId（数字 id 数组）。` +
        '**引擎侧这是个空壳**：只有 inputSchema、没有 execute（entity-tools.ts:676-683），' +
        '内部路由会回 501 TOOL_NOT_EXECUTABLE，本层把它翻译为 ENGINE_TOOL_NOT_IMPLEMENTED。' +
        '现在能用的是：model_list 已有资产 + entity_create 放实体。副作用：调用即失败，不写任何东西。',
      inputSchema: {
        type: 'object',
        properties: {
          mapId: { type: 'string', minLength: 1, maxLength: 63 },
          modelIds: { type: 'array', minItems: 1, maxItems: BUDGETS.ENTITY_MAX_PER_CALL, description: '公共模型 id（数字）' },
          confirm: { type: 'boolean', description: 'false=dry-run 只回报这次要加的 id 与可用性判断' },
        },
        required: ['mapId', 'modelIds'],
        additionalProperties: false,
      },
      annotations: {
        title: '导入公共模型（引擎未实现）',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      scope: 'loopback internal（引擎无 execute）',
      handler: async (args) => {
        assertWritable(ctx, 'model_add_to_project')
        dangerScan(args.modelIds, 'model_add_to_project.modelIds')
        if (args.confirm !== true) {
          return {
            dryRun: true,
            wouldAdd: args.modelIds,
            engineSupport: 'none',
            next:
              '引擎侧 addModelToProject 没有 execute，真调会 501。要用公共模型必须等泳道 B/C 落地；' +
              '当前闭环用 model_list → entity_create{modelId}。带 confirm:true 可以看上游的原始拒绝。',
          }
        }
        return await callEngineTool(ctx, args.mapId, 'addModelToProject', { modelIds: args.modelIds })
      },
    },
  ]
}
