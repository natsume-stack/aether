/**
 * Tool face for the live agent MCP.
 *
 * map_* authoring tools use the authoritative runtime and revision checks.
 * Legacy agent_* tools manipulate editor presentation through the open tab;
 * their observe/recovery gates apply only to that browser command lane.
 */
import { AgentError } from './client.js';
import { buildAuthoringTools } from './authoring-tools.js';
import { buildAssetTools } from './asset-library.js';
import { buildLocalTerrainTools } from './local-terrain.js';

const vec3Schema = {
  type: 'array',
  items: { type: 'number' },
  minItems: 3,
  maxItems: 3,
  description: '世界坐标 [x, y, z]',
};

const pointSchema = {
  type: 'array',
  items: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
  description: '坐标点列表 [[x,y,z], ...]',
  minItems: 1,
};

const readOnly = (title) => ({
  title,
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
});

const write = (title) => ({
  title,
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
});

/**
 * Tools that change authored content. After a timeout or reconnect the editor
 * may have applied the command anyway, so these are refused until an observe
 * has run. The editor enforces the same rule; this gate just fails fast and
 * gives the agent a single, consistent instruction.
 */
const WRITE_TOOLS = new Set([
  'agent_place',
  'agent_erase',
  'agent_place_path',
  'agent_fill_box',
  'agent_place_model',
  'agent_script_replace',
  'agent_script_insert',
  'agent_undo',
  'agent_redo',
  'agent_save',
  'agent_preview',
  'voxa_paint',
  'voxa_erase',
  'voxa_paint_path',
  'voxa_fill_box',
  'voxa_undo',
  'voxa_redo',
  'voxa_save',
  'voxa_trim',
]);

const OBSERVE_GATING_ERRORS = new Set([
  'EDITOR_NOT_ATTACHED',
  'EDITOR_TIMEOUT',
  'EDITOR_REATTACHED',
  'EDITOR_DETACHED',
  'EDITOR_STALE',
  'OBSERVE_REQUIRED',
  'HUMAN_EDITED',
  'NETWORK_ERROR',
  'ENGINE_UNREACHABLE',
]);

const WORKFLOWS = {
  map: [
    '1. map_context 读取现有工程；按需 map_terrain_read、map_scripts、map_script_read，先理解现图和目标区域。',
    '2. map_runtime_status 确认预览状态；地形修改前用 map_runtime_preview stop。',
    '3. map_propose 对局部地形做 dry-run，查看预览后 map_apply_proposal；每次写提供稳定 operationId。',
    '4. 超时先 map_operation_status 查询同一 operationId；不得换新 ID 盲目重试。运行时重启后须重新核实内容。',
    '5. map_proposal_status 查看提案状态；需要撤销时 map_revert_proposal，遇后续编辑冲突会拒绝覆盖。',
    '6. map_runtime_save 保存；当前提案仅支持地形补偿回滚。回滚记录和回执可跨重启恢复，但回滚必须匹配当前地图 revision；待应用提案重启后过期，中断操作不自动续跑。历史成功不代表未保存修改仍然存在。',
    '7. 相机、光标、截图或未保存脚本交互才使用 agent_* 浏览器工具；其 observe 恢复门仍然有效。',
    '结构化批量修改不要求移动镜头或逐格节奏；脚本修改继续走现有类型检查链路。',
  ],
  voxa: [
    '1. voxa_status / voxa_observe：确认模型编辑器已接入，拿到模型尺寸、光标、调色板。',
    '2. voxa_look：把镜头转到要建模的面。',
    '3. voxa_cursor：把光标指到体素；voxa_paint / voxa_erase 一次只改一个体素。',
    '4. 连续笔触用 voxa_paint_path；大块用 voxa_fill_box；颜色用 voxa_set_color 先选调色板。',
    '5. 每完成一个部件就 voxa_observe；voxa_undo / voxa_redo 随时可退。',
    '6. 收尾 voxa_save。',
    '硬规则：像人一样一个部件一个部件做；不要导入整包模型冒充手工建模。',
  ],
};

function imageResult(response) {
  const result = response.result || response.snapshot || {};
  const image =
    result && typeof result.data === 'string' && result.mimeType
      ? { mimeType: result.mimeType, data: result.data }
      : undefined;
  return {
    summary: result.summary || '截图完成',
    data: {
      summary: result.summary,
      width: result.width,
      height: result.height,
    },
    image,
  };
}

export function buildTools(client, config) {
  const writeAllowed = config.allowWrite;
  const writeTool = (tool) => {
    if (writeAllowed) return tool;
    return {
      ...tool,
      handler: async () => {
        throw new AgentError('WRITE_DISABLED', '本实例以只读模式启动（BOX_AGENT_ALLOW_WRITE=0）');
      },
    };
  };

  const mapCommand = async (kind, args, options) => client.mapCommand(kind, args, options);

  const tools = [
    {
      name: 'agent_help',
      description:
        '活体建图的工作流与硬规则。第一次接入、或不确定下一步做什么时先读它。不会改动地图。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: readOnly('活体建图工作流'),
      handler: async () => ({
        summary: '读取现图 → 局部提案 → 应用/回滚 → 保存；视角交互按需使用',
        data: {
          baseUrl: config.mapBaseUrl,
          project: config.mapProject || null,
          workflow: WORKFLOWS.map,
          commands: [
            'observe', 'look', 'cursor', 'place', 'erase', 'place_path',
            'fill_box', 'entities', 'select_entity', 'place_model',
            'script_files', 'script_open', 'script_read', 'script_replace', 'script_insert',
            'undo', 'redo', 'save', 'preview_start', 'preview_stop',
            'screenshot', 'say', 'wait', 'release_camera',
          ],
        },
      }),
    },
    {
      name: 'agent_status',
      description:
        '地图编辑器是否已接入、最近一次动作、当前光标/相机状态。不排队任何编辑命令。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: readOnly('活体通道状态'),
      handler: async () => {
        const status = await client.mapStatus();
        return { summary: status.attached ? '编辑器在线' : '编辑器未接入', data: status };
      },
    },
    {
      name: 'agent_observe',
      description:
        '观察编辑器：相机、视线命中的方块、AI 光标、选中实体、实体清单、模型资源、UI/脚本数量；includeTerrain=true 时附带粗高度图。这是 AI 的眼睛，写完一步就调用。',
      inputSchema: {
        type: 'object',
        properties: {
          includeTerrain: { type: 'boolean', default: false, description: '附带 8 格步长的粗高度图' },
          projectId: { type: 'string', description: '覆盖 BOX_MAP_PROJECT' },
        },
        additionalProperties: false,
      },
      annotations: readOnly('观察地图'),
      handler: async (args) => {
        const response = await client.mapObserve(args);
        return { summary: '观察完成', data: response.snapshot || response };
      },
    },
    {
      name: 'agent_look',
      description:
        '像人一样把镜头移到目标区域。默认从等轴俯视方向看过去；durationMs 控制镜头移动时长（人能看到）。',
      inputSchema: {
        type: 'object',
        properties: {
          target: vec3Schema,
          eye: { ...vec3Schema, description: '可选：直接指定相机位置' },
          distance: { type: 'number', minimum: 2, maximum: 400, description: '相机到目标的距离，默认 24' },
          yaw: { type: 'number', description: '水平角（弧度），默认 -0.65' },
          pitch: { type: 'number', description: '俯仰角（弧度），0=水平，1.45≈俯视' },
          durationMs: { type: 'number', minimum: 0, maximum: 5000, description: '镜头移动时长，默认 650' },
          projectId: { type: 'string' },
        },
        required: ['target'],
        additionalProperties: false,
      },
      annotations: write('移动 AI 视角'),
      handler: async (args) => {
        await client.pace();
        const response = await mapCommand('look', args);
        return { summary: response.result?.summary || '镜头已移动', data: response.result };
      },
    },
    {
      name: 'agent_cursor',
      description: '把可见的 AI 光标指到一个体素格，不修改地图。',
      inputSchema: {
        type: 'object',
        properties: {
          at: vec3Schema,
          face: vec3Schema,
          projectId: { type: 'string' },
        },
        required: ['at'],
        additionalProperties: false,
      },
      annotations: write('移动 AI 光标'),
      handler: async (args) => {
        await client.pace();
        const response = await mapCommand('cursor', args);
        return { summary: response.result?.summary || '光标已移动', data: response.result };
      },
    },
    {
      name: 'agent_place',
      description:
        '在指定格放一个方块。block 可用名称（stone / grass / 石头）或数字 id；默认覆盖该格，replace=false 时只填空气。',
      inputSchema: {
        type: 'object',
        properties: {
          at: vec3Schema,
          block: { oneOf: [{ type: 'string' }, { type: 'number' }], description: '方块名或 id' },
          replace: { type: 'boolean', default: true },
          projectId: { type: 'string' },
        },
        required: ['at', 'block'],
        additionalProperties: false,
      },
      annotations: write('放置方块'),
      handler: async (args) => {
        await client.pace();
        const response = await mapCommand('place', args);
        return { summary: response.result?.summary || '已放置', data: response.result };
      },
    },
    {
      name: 'agent_erase',
      description: '移除指定格的方块（设为空气）。',
      inputSchema: {
        type: 'object',
        properties: { at: vec3Schema, projectId: { type: 'string' } },
        required: ['at'],
        additionalProperties: false,
      },
      annotations: write('移除方块'),
      handler: async (args) => {
        await client.pace();
        const response = await mapCommand('erase', args);
        return { summary: response.result?.summary || '已移除', data: response.result };
      },
    },
    {
      name: 'agent_place_path',
      description:
        '沿坐标点列表逐块放置（桥、墙、路）。编辑器每 paceMs 毫秒放一块，人能看着它长出来；一次最多 2048 点。',
      inputSchema: {
        type: 'object',
        properties: {
          points: pointSchema,
          block: { oneOf: [{ type: 'string' }, { type: 'number' }] },
          replace: { type: 'boolean', default: true },
          paceMs: { type: 'number', minimum: 0, maximum: 1000, default: 80 },
          projectId: { type: 'string' },
        },
        required: ['points', 'block'],
        additionalProperties: false,
      },
      annotations: write('沿路径搭建'),
      handler: async (args) => {
        await client.pace();
        const response = await mapCommand('place_path', args, {
          waitMs: Math.min(120_000, 15_000 + args.points.length * (args.paceMs ?? 80)),
        });
        return { summary: response.result?.summary || '路径完成', data: response.result };
      },
    },
    {
      name: 'agent_fill_box',
      description:
        '填充一个长方体区域，按 y 层逐块出现；hollow=true 只做外壳。超过 8192 块请拆分。大体积默认不延时，小体积默认 45ms/块。',
      inputSchema: {
        type: 'object',
        properties: {
          from: vec3Schema,
          to: vec3Schema,
          block: { oneOf: [{ type: 'string' }, { type: 'number' }] },
          hollow: { type: 'boolean', default: false },
          replace: { type: 'boolean', default: true },
          paceMs: { type: 'number', minimum: 0, maximum: 1000 },
          projectId: { type: 'string' },
        },
        required: ['from', 'to', 'block'],
        additionalProperties: false,
      },
      annotations: write('填充区域'),
      handler: async (args) => {
        await client.pace();
        const response = await mapCommand('fill_box', args, { waitMs: 110_000 });
        return { summary: response.result?.summary || '填充完成', data: response.result };
      },
    },
    {
      name: 'agent_entities',
      description: '列出地图实体（id/名称/模型/坐标/缩放），可按 query 过滤。',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 120, default: 40 },
          projectId: { type: 'string' },
        },
        additionalProperties: false,
      },
      annotations: readOnly('实体清单'),
      handler: async (args) => {
        const response = await mapCommand('entities', args);
        return { summary: response.result?.summary || '实体清单', data: response.result };
      },
    },
    {
      name: 'agent_select_entity',
      description: '选中一个实体（带动画地聚焦过去），让人看到 AI 正在处理哪个对象。',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          focus: { type: 'boolean', default: true },
          distance: { type: 'number', minimum: 2, maximum: 400 },
          projectId: { type: 'string' },
        },
        required: ['id'],
        additionalProperties: false,
      },
      annotations: write('选中实体'),
      handler: async (args) => {
        await client.pace();
        const response = await mapCommand('select_entity', args);
        return { summary: response.result?.summary || '已选中', data: response.result };
      },
    },
    {
      name: 'agent_place_model',
      description:
        '把工程里已有的模型资源放到场景中（mesh 从 observe.models 里选）。会选中新实体并把镜头聚焦过去。',
      inputSchema: {
        type: 'object',
        properties: {
          mesh: { type: 'string', description: '模型资源名，例如 models/xxx.vox' },
          at: vec3Schema,
          scale: { type: 'number', minimum: 0.01, maximum: 64, default: 1 },
          name: { type: 'string', maxLength: 32 },
          rotationY: { type: 'number', description: '绕 Y 轴旋转弧度' },
          focus: { type: 'boolean', default: true },
          projectId: { type: 'string' },
        },
        required: ['mesh', 'at'],
        additionalProperties: false,
      },
      annotations: write('放置模型'),
      handler: async (args) => {
        await client.pace();
        const response = await mapCommand('place_model', args);
        return { summary: response.result?.summary || '模型已放置', data: response.result };
      },
    },
    {
      name: 'agent_script_files',
      description:
        '列出地图里的脚本文件（id、名字、字符数）。写代码前先看它，拿到 file 参数。',
      inputSchema: { type: 'object', properties: { projectId: { type: 'string' } }, additionalProperties: false },
      annotations: readOnly('脚本清单'),
      handler: async (args) => {
        const response = await mapCommand('script_files', args);
        return { summary: response.result?.summary || '脚本清单', data: response.result };
      },
    },
    {
      name: 'agent_script_open',
      description:
        '在编辑器里切到脚本面板并打开某个文件，人能看到代码页出现。写代码前必须先 open。',
      inputSchema: {
        type: 'object',
        properties: {
          file: { type: 'string', description: '文件名（server / client）或 fileId；省略则用 server' },
          projectId: { type: 'string' },
        },
        additionalProperties: false,
      },
      annotations: write('打开脚本'),
      handler: async (args) => {
        await client.pace();
        const response = await mapCommand('script_open', args);
        return { summary: response.result?.summary || '脚本已打开', data: response.result };
      },
    },
    {
      name: 'agent_script_read',
      description: '读取脚本内容（人是看得见的那个文件）。改之前先读，避免覆盖别人的编辑。',
      inputSchema: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          limit: { type: 'integer', minimum: 200, maximum: 20000, default: 6000 },
          projectId: { type: 'string' },
        },
        additionalProperties: false,
      },
      annotations: readOnly('读取脚本'),
      handler: async (args) => {
        const response = await mapCommand('script_read', args);
        return { summary: response.result?.summary || '已读取', data: response.result };
      },
    },
    {
      name: 'agent_script_replace',
      description:
        '整文件改写脚本，走 Monaco 编辑器模型（和人工输入同一条同步链），人在屏幕上能看到代码变化。改完必须 agent_save。',
      inputSchema: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          content: { type: 'string', description: '完整文件内容' },
          projectId: { type: 'string' },
        },
        required: ['content'],
        additionalProperties: false,
      },
      annotations: write('改写脚本'),
      handler: async (args) => {
        await client.pace();
        const response = await mapCommand('script_replace', args, { waitMs: 45_000 });
        return { summary: response.result?.summary || '脚本已改写', data: response.result };
      },
    },
    {
      name: 'agent_script_insert',
      description: '在脚本当前光标处插入代码（不覆盖已有内容）。适合小步追加。',
      inputSchema: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          text: { type: 'string' },
          projectId: { type: 'string' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      annotations: write('插入代码'),
      handler: async (args) => {
        await client.pace();
        const response = await mapCommand('script_insert', args);
        return { summary: response.result?.summary || '已插入', data: response.result };
      },
    },
    {
      name: 'agent_undo',
      description: '撤销编辑器里的上一步（和 Ctrl+Z 同一条历史）。',
      inputSchema: { type: 'object', properties: { projectId: { type: 'string' } }, additionalProperties: false },
      annotations: write('撤销'),
      handler: async (args) => {
        const response = await mapCommand('undo', args);
        return { summary: response.result?.summary || '已撤销', data: response.result };
      },
    },
    {
      name: 'agent_redo',
      description: '重做编辑器里的下一步。',
      inputSchema: { type: 'object', properties: { projectId: { type: 'string' } }, additionalProperties: false },
      annotations: write('重做'),
      handler: async (args) => {
        const response = await mapCommand('redo', args);
        return { summary: response.result?.summary || '已重做', data: response.result };
      },
    },
    {
      name: 'agent_save',
      description: '保存地图工程。预览运行中会被拒绝（先 agent_preview stop），这是引擎的硬顺序。',
      inputSchema: { type: 'object', properties: { projectId: { type: 'string' } }, additionalProperties: false },
      annotations: write('保存地图'),
      handler: async (args) => {
        const response = await mapCommand('save', args);
        return { summary: response.result?.summary || '已保存', data: response.result };
      },
    },
    {
      name: 'agent_preview',
      description: '启动或停止预览。写地形前若预览在跑，先 stop；保存也要求先 stop。',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['start', 'stop'] },
          projectId: { type: 'string' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      annotations: write('预览控制'),
      handler: async (args) => {
        const response = await mapCommand(args.action === 'start' ? 'preview_start' : 'preview_stop', args);
        return { summary: response.result?.summary || '预览已切换', data: response.result };
      },
    },
    {
      name: 'agent_screenshot',
      description: '截取编辑器 3D 画面（JPEG，最长边 960），让 AI 看到自己改完的效果。',
      inputSchema: { type: 'object', properties: { projectId: { type: 'string' } }, additionalProperties: false },
      annotations: readOnly('编辑器截图'),
      handler: async (args) => {
        const response = await mapCommand('screenshot', args);
        return imageResult(response);
      },
    },
    {
      name: 'agent_say',
      description: '在编辑器面板上对人类说一句话（不改变地图）。适合汇报“我在做什么/为什么”。',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string', maxLength: 240 }, projectId: { type: 'string' } },
        required: ['text'],
        additionalProperties: false,
      },
      annotations: readOnly('对人类播报'),
      handler: async (args) => {
        const response = await mapCommand('say', args);
        return { summary: response.result?.summary || '已播报', data: response.result };
      },
    },
    {
      name: 'agent_wait',
      description: '停留观察，让人看清刚才的动作。最多 5 秒。',
      inputSchema: {
        type: 'object',
        properties: { ms: { type: 'integer', minimum: 0, maximum: 5000, default: 800 } },
        additionalProperties: false,
      },
      annotations: readOnly('停留观察'),
      handler: async (args) => {
        const response = await mapCommand('wait', args);
        return { summary: response.result?.summary || '已停留', data: response.result };
      },
    },
    {
      name: 'agent_release_camera',
      description: '把视角交还给人（人点击/滚动画面也会自动交还）。',
      inputSchema: { type: 'object', properties: { projectId: { type: 'string' } }, additionalProperties: false },
      annotations: write('交还视角'),
      handler: async (args) => {
        const response = await mapCommand('release_camera', args);
        return { summary: response.result?.summary || '视角已交还', data: response.result };
      },
    },

    {
      name: 'voxa_help',
      description: 'VOXA 活体建模工作流与硬规则。第一次接管模型编辑器时先读。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: readOnly('活体建模工作流'),
      handler: async () => ({
        summary: '先 observe，再 look / cursor / paint，一个部件一个部件做',
        data: {
          baseUrl: config.voxaBaseUrl,
          modelId: config.voxaModelId || null,
          workflow: WORKFLOWS.voxa,
          commands: [
            'observe', 'look', 'cursor', 'paint', 'erase', 'paint_path',
            'fill_box', 'palette', 'set_color', 'undo', 'redo', 'save',
            'screenshot', 'say', 'wait',
          ],
        },
      }),
    },
    {
      name: 'voxa_status',
      description: 'VOXA 模型编辑器是否已接入、当前模型、最近动作。不排队编辑命令。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: readOnly('VOXA 活体状态'),
      handler: async () => {
        const status = await client.voxaStatus();
        return { summary: status.attached ? 'VOXA 编辑器在线' : 'VOXA 编辑器未接入', data: status };
      },
    },
    {
      name: 'voxa_observe',
      description:
        '观察 VOXA：模型尺寸、AI 光标、当前调色板/颜色、模型占用量、相机。screenshot=true 时附截图。这是 AI 的眼睛。',
      inputSchema: {
        type: 'object',
        properties: {
          screenshot: { type: 'boolean', default: false },
          waitMs: { type: 'integer', minimum: 5000, maximum: 120000 },
        },
        additionalProperties: false,
      },
      annotations: readOnly('观察 VOXA 模型'),
      handler: async (args) => {
        const response = await client.voxaObserve(args);
        const snapshot = response.snapshot || response.result || {};
        const image =
          snapshot && typeof snapshot.image?.data === 'string'
            ? { mimeType: snapshot.image.mimeType || 'image/jpeg', data: snapshot.image.data }
            : undefined;
        return { summary: '观察完成', data: snapshot, image };
      },
    },
    {
      name: 'voxa_look',
      description: '把 VOXA 镜头转到指定点/角度；也可以指定 position 与 target 精确取景。',
      inputSchema: {
        type: 'object',
        properties: {
          target: vec3Schema,
          position: vec3Schema,
          zoom: { type: 'number', minimum: 0.05, maximum: 20 },
          durationMs: { type: 'number', minimum: 0, maximum: 5000, default: 600 },
        },
        additionalProperties: false,
      },
      annotations: write('移动 VOXA 视角'),
      handler: async (args) => {
        await client.pace();
        const response = await client.voxaCommand('look', args);
        return { summary: response.result?.summary || '镜头已移动', data: response.result };
      },
    },
    {
      name: 'voxa_cursor',
      description: '把 VOXA 体素光标指到某格（不修改模型），让人看到 AI 在点哪里。',
      inputSchema: {
        type: 'object',
        properties: { at: vec3Schema, face: vec3Schema },
        required: ['at'],
        additionalProperties: false,
      },
      annotations: write('移动 VOXA 光标'),
      handler: async (args) => {
        await client.pace();
        const response = await client.voxaCommand('cursor', args);
        return { summary: response.result?.summary || '光标已移动', data: response.result };
      },
    },
    {
      name: 'voxa_paint',
      description:
        '在指定体素格上色/放置体素。不传 color 时用当前调色板颜色；color 可以传调色板索引或颜色值（以 voxa_observe 返回的 palette 为准）。',
      inputSchema: {
        type: 'object',
        properties: {
          at: vec3Schema,
          color: { oneOf: [{ type: 'integer' }, { type: 'string' }] },
          overwrite: { type: 'boolean', default: true, description: 'false 时只填空气格' },
        },
        required: ['at'],
        additionalProperties: false,
      },
      annotations: write('VOXA 上色'),
      handler: async (args) => {
        await client.pace();
        const response = await client.voxaCommand('paint', args);
        return { summary: response.result?.summary || '已上色', data: response.result };
      },
    },
    {
      name: 'voxa_erase',
      description: '擦除指定体素格。',
      inputSchema: {
        type: 'object',
        properties: { at: vec3Schema },
        required: ['at'],
        additionalProperties: false,
      },
      annotations: write('VOXA 擦除'),
      handler: async (args) => {
        await client.pace();
        const response = await client.voxaCommand('erase', args);
        return { summary: response.result?.summary || '已擦除', data: response.result };
      },
    },
    {
      name: 'voxa_paint_path',
      description: '沿坐标点逐格上色，按 paceMs 出现（画轮廓、连接件）。最多 2048 点。',
      inputSchema: {
        type: 'object',
        properties: {
          points: pointSchema,
          color: { oneOf: [{ type: 'integer' }, { type: 'string' }] },
          paceMs: { type: 'number', minimum: 0, maximum: 1000, default: 60 },
          overwrite: { type: 'boolean', default: true },
        },
        required: ['points'],
        additionalProperties: false,
      },
      annotations: write('VOXA 路径笔触'),
      handler: async (args) => {
        await client.pace();
        const response = await client.voxaCommand('paint_path', args, {
          waitMs: Math.min(120_000, 15_000 + args.points.length * (args.paceMs ?? 60)),
        });
        return { summary: response.result?.summary || '路径完成', data: response.result };
      },
    },
    {
      name: 'voxa_fill_box',
      description: '填充长方体区域（最多 8192 格）；hollow=true 只做外壳。',
      inputSchema: {
        type: 'object',
        properties: {
          from: vec3Schema,
          to: vec3Schema,
          color: { oneOf: [{ type: 'integer' }, { type: 'string' }] },
          hollow: { type: 'boolean', default: false },
          paceMs: { type: 'number', minimum: 0, maximum: 1000 },
        },
        required: ['from', 'to'],
        additionalProperties: false,
      },
      annotations: write('VOXA 区域填充'),
      handler: async (args) => {
        await client.pace();
        const response = await client.voxaCommand('fill_box', args, { waitMs: 110_000 });
        return { summary: response.result?.summary || '填充完成', data: response.result };
      },
    },
    {
      name: 'voxa_palette',
      description: '读取当前调色板（索引、颜色、是否选中）。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: readOnly('VOXA 调色板'),
      handler: async () => {
        const response = await client.voxaCommand('palette', {});
        return { summary: response.result?.summary || '调色板', data: response.result };
      },
    },
    {
      name: 'voxa_set_color',
      description: '选择调色板颜色（index 来自 voxa_palette / observe.palette）。',
      inputSchema: {
        type: 'object',
        properties: {
          index: { type: 'integer', minimum: 0 },
          color: { type: 'string', description: '可选：按十六进制颜色匹配' },
        },
        additionalProperties: false,
      },
      annotations: write('选择颜色'),
      handler: async (args) => {
        await client.pace();
        const response = await client.voxaCommand('set_color', args);
        return { summary: response.result?.summary || '颜色已选择', data: response.result };
      },
    },
    {
      name: 'voxa_undo',
      description: '撤销 VOXA 上一步。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: write('VOXA 撤销'),
      handler: async () => {
        const response = await client.voxaCommand('undo', {});
        return { summary: response.result?.summary || '已撤销', data: response.result };
      },
    },
    {
      name: 'voxa_redo',
      description: '重做 VOXA 下一步。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: write('VOXA 重做'),
      handler: async () => {
        const response = await client.voxaCommand('redo', {});
        return { summary: response.result?.summary || '已重做', data: response.result };
      },
    },
    {
      name: 'voxa_save',
      description: '保存当前 VOXA 模型工程。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: write('VOXA 保存'),
      handler: async () => {
        const response = await client.voxaCommand('save', {}, { waitMs: 60_000 });
        return { summary: response.result?.summary || '已保存', data: response.result };
      },
    },
    {
      name: 'voxa_screenshot',
      description: '截取 VOXA 画面（JPEG），让 AI 看到自己刚做的部件。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: readOnly('VOXA 截图'),
      handler: async () => {
        const response = await client.voxaCommand('screenshot', {});
        return imageResult(response);
      },
    },
    {
      name: 'voxa_say',
      description: '在 VOXA 面板上对人类说一句话。',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string', maxLength: 240 } },
        required: ['text'],
        additionalProperties: false,
      },
      annotations: readOnly('对人类播报'),
      handler: async (args) => {
        const response = await client.voxaCommand('say', args);
        return { summary: response.result?.summary || '已播报', data: response.result };
      },
    },
    {
      name: 'voxa_wait',
      description: '停留观察，最多 5 秒。',
      inputSchema: {
        type: 'object',
        properties: { ms: { type: 'integer', minimum: 0, maximum: 5000, default: 800 } },
        additionalProperties: false,
      },
      annotations: readOnly('停留观察'),
      handler: async (args) => {
        const response = await client.voxaCommand('wait', args);
        return { summary: response.result?.summary || '已停留', data: response.result };
      },
    },
  ];

  const gate = { map: { needsObserve: false }, voxa: { needsObserve: false } };

  return [...buildAssetTools(config), ...buildLocalTerrainTools(client, config), ...buildAuthoringTools(client, config), ...tools.map((tool) => {
    const readonlyOk = tool.annotations?.readOnlyHint === false;
    const base = readonlyOk ? writeTool(tool) : tool;
    const channel = tool.name.startsWith('voxa_') ? 'voxa' : 'map';
    const gated = WRITE_TOOLS.has(tool.name);
    const observeTool = tool.name === 'agent_observe' || tool.name === 'voxa_observe';
    const statusTool = tool.name === 'agent_status' || tool.name === 'voxa_status';

    return {
      ...base,
      handler: async (args, context) => {
        if (gated && gate[channel].needsObserve) {
          throw new AgentError(
            'OBSERVE_REQUIRED',
            '上一次写命令超时或编辑器重连过，还没有重新 observe',
            {
              hint: '先调用 observe 读取当前状态；那一步可能已经生效，直接重放会写两遍',
              retryable: true,
            },
          );
        }
        try {
          const output = await base.handler(args, context);
          if (observeTool) gate[channel].needsObserve = false;
          if (statusTool && output?.data?.requiresObserve) gate[channel].needsObserve = true;
          if (gated) gate[channel].needsObserve = false;
          return output;
        } catch (error) {
          if (OBSERVE_GATING_ERRORS.has(error?.code)) gate[channel].needsObserve = true;
          throw error;
        }
      },
    };
  })];
}
