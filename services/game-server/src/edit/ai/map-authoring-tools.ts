import { TreeNodeType } from '@box/schema/project/murda-tree';
import {
  DEFAULT_SCREEN_ID,
  UITreeRDA,
} from '@box/schema/project/ui-rda/defs';
import {
  VOXEL_ROTATION_SHIFT,
  VOXEL_TYPE_MASK,
} from '@box/schema/voxel/voxel-protocol';
import { tool } from 'ai';
import { createHash } from 'crypto';
import { Logger } from 'pino';
import { z } from 'zod';
import { EditServerState } from '../edit-server-schema';
import { EditReplicaServer } from '../replica/replica-server';
import { readTerrainRegion } from './terrain-region';
import { registerAuthoringDomain } from './authoring-tools';
import { createUiContentDomain, readUiContent, uiContentRevision } from './ui-content-domain';

/**
 * Engine-side AI authoring tools for TERRAIN (voxels) and the UI tree.
 *
 * These live alongside `createEntityTools` / `createScriptTools` and are wired
 * into the built-in `AiServer`. They write the SAME authoritative in-memory RDA
 * tree the browser editor writes, so they are reusable by any host that can
 * drive the tools (the editor AI panel today; a future loopback HTTP tool
 * router). They depend on no LLM.
 *
 * Compatibility posture (the user's hard red line):
 *   - Pure additive surface; nothing here changes existing endpoints/contracts.
 *   - Terrain edits reuse the engine's own voxel packing masks, and never touch
 *     the rotation bits unless the caller explicitly asks.
 *   - UI writes go through `replica.projectTransaction()` whose RDATransaction
 *     already records forward+inverse actions, so a failed commit rolls back and
 *     a manual revert can replay the inverse.
 */

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Small, dependency-free FNV-1a over a UTF-16 code-unit stream. */
function fnv1a(append: (push: (n: number) => void) => void): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  const push = (n: number) => {
    n = n | 0;
    h1 = Math.imul(h1 ^ (n & 0xffff), 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ ((n >>> 16) & 0xffff), 0x811c9dc5) >>> 0;
  };
  append(push);
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

/**
 * A deterministic revision token for the current live terrain.
 *
 * N12 §6: sampling every 4th cell let a one-cell edit leave the revision
 * unchanged. Hash the full authoritative VoxelView.data buffer instead; native
 * sha256 keeps a 128^3 revision in single-digit milliseconds.
 */
function computeTerrainRevision(voxels: {
  shape: [number, number, number];
  getVoxel: (x: number, y: number, z: number) => number;
  data?: Uint16Array;
}): string {
  const [sx, sy, sz] = voxels.shape;
  const data = voxels.data;
  if (data && data.length > 0 && data.buffer) {
    const hash = createHash('sha256');
    hash.update(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
    hash.update(`${sx}x${sy}x${sz}`);
    return hash.digest('hex').slice(0, 16);
  }
  return fnv1a((push) => {
    push(sx);
    push(sy);
    push(sz);
    for (let x = 0; x < sx; ++x) {
      for (let y = 0; y < sy; ++y) {
        for (let z = 0; z < sz; ++z) push(voxels.getVoxel(x, y, z));
      }
    }
  });
}

/** Deterministic revision token for the current UI tree. */
function computeUiRevision(tree: unknown): string {
  const stable = (value: any): any => Array.isArray(value)
    ? value.map(stable)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]))
      : value;
  return createHash('sha256').update(JSON.stringify(stable(tree ?? {}))).digest('hex').slice(0, 16);
}

/**
 * `block` accepts a numeric type id or a name/alias from the map's own block
 * table. Names are resolved through `resolveBlockKey`; an unknown name is an
 * error (`UNKNOWN_BLOCK_ALIAS`), never a silent fallback to air/0.
 */
const blockKeySchema = z
  .union([z.number().int().min(0).max(0xffff), z.string().trim().min(1).max(64)])
  .describe(
    'Block type id (low 14 bits) or a block name/alias from this map ' +
      '(e.g. "grass", "stone_brick_01", "红砖"). Prefer names: unknown names fail with ' +
      'UNKNOWN_BLOCK_ALIAS instead of resolving to air. Use blockCatalog/searchBlocks/getBlock.',
  );
const blockSchema = blockKeySchema;

export const createMapAuthoringTools = (
  replica: EditReplicaServer,
  state: EditServerState,
  gameId: number,
  logger: Logger,
) => {
  registerAuthoringDomain(state, 'ui', createUiContentDomain(state, replica));
  // Reads/shape come from the authoritative VoxelView; writes must go through
  // VoxelServer.setVoxel so bounds/block validation and change events fire.
  const voxelView = () =>
    state.game.state
      .voxels as unknown as {
      shape: [number, number, number];
      getVoxel: (x: number, y: number, z: number) => number;
      data?: Uint16Array;
    };
  const voxelWriter = () =>
    state.game.voxel as unknown as {
      setVoxel: (x: number, y: number, z: number, b: number) => unknown;
      setVoxelRotate?: (x: number, y: number, z: number, rotate: number) => unknown;
    };
  const isPreviewRunning = () => !!state.game.state.replica.running;

  /** Bounds check that mirrors what `VoxelView.setVoxel` unfortunately omits. */
  const inBounds = (x: number, y: number, z: number) => {
    const v = voxelView();
    const [sx, sy, sz] = v.shape;
    return (
      Number.isInteger(x) &&
      Number.isInteger(y) &&
      Number.isInteger(z) &&
      x >= 0 &&
      y >= 0 &&
      z >= 0 &&
      x < sx &&
      y < sy &&
      z < sz
    );
  };

  const encodeBlock = (block: number, rotation?: number) => {
    const typeBits = block & VOXEL_TYPE_MASK;
    if (rotation === undefined) return typeBits;
    const rot = rotation & 0x3;
    return typeBits | (rot << VOXEL_ROTATION_SHIFT);
  };

  const readRegion = (region: {
    min: [number, number, number];
    max: [number, number, number];
  }, limit = 500_000, truncate = false) => {
    return readTerrainRegion(voxelView(), region, limit, truncate);
  };

  // ───────────────────────────────────────────────────────────────────────────
  // Actual-write verification (contract mirror of the feather engine fix)
  //
  // `VoxelServer.setVoxel` (voxel-server.ts:814) returns *silently* in three
  // cases: `voxelState.ready` is false, the block id is not in this map's block
  // table (`blockIndex.valid[b & 0xfff]`), or the cell sits on the outermost
  // plane (its bounds test is `< shape - 1`, not `< shape`). Before this,
  // `terrainApply` counted every cell it *asked* for as applied, so a write of
  // an invalid block id reported `success:true, changed:1` while the world was
  // unchanged. Every voxel write is now gated up front and read back after.
  // ───────────────────────────────────────────────────────────────────────────

  /** Cells at or below this are read back one by one; larger regions are sampled. */
  const VOXEL_FULL_READBACK_LIMIT = 8192;
  /** Deterministic readback sample size for large regions. */
  const VOXEL_READBACK_SAMPLE = 4096;

  const blockIndexTable = () =>
    (state.game.state as unknown as {
      blockIndex?: { valid?: ArrayLike<number | boolean>; name?: string[] };
    }).blockIndex;

  const isVoxelStateReady = () =>
    !!(state.game.state as unknown as { voxelState?: { ready?: boolean } }).voxelState
      ?.ready;

  const isValidBlockId = (b: number) => {
    const valid = blockIndexTable()?.valid;
    if (!valid) return false;
    return !!valid[b & 0xfff];
  };

  /** Mirrors setVoxel's own bounds test, which excludes the outermost plane. */
  const isWritableCell = (x: number, y: number, z: number) => {
    const [sx, sy, sz] = voxelView().shape;
    return (
      x >= 0 && y >= 0 && z >= 0 && x < sx - 1 && y < sy - 1 && z < sz - 1
    );
  };

  /**
   * The engine masks fluid blocks down to the type bits, so compare the packed
   * value only when the caller actually asked for rotation; otherwise compare
   * the type bits.
   */
  const voxelMatches = (actual: number, expected: number) => {
    if ((expected & ~VOXEL_TYPE_MASK) !== 0) return actual === expected;
    return (actual & VOXEL_TYPE_MASK) === (expected & VOXEL_TYPE_MASK);
  };

  const boundsOfCells = (
    cells: { x: number; y: number; z: number }[],
  ): { min: [number, number, number]; max: [number, number, number] } | null => {
    if (cells.length === 0) return null;
    const min: [number, number, number] = [cells[0].x, cells[0].y, cells[0].z];
    const max: [number, number, number] = [cells[0].x, cells[0].y, cells[0].z];
    for (const c of cells) {
      if (c.x < min[0]) min[0] = c.x;
      if (c.y < min[1]) min[1] = c.y;
      if (c.z < min[2]) min[2] = c.z;
      if (c.x > max[0]) max[0] = c.x;
      if (c.y > max[1]) max[1] = c.y;
      if (c.z > max[2]) max[2] = c.z;
    }
    return { min, max };
  };

  type VoxelWrite = { x: number; y: number; z: number; value: number };

  /**
   * Read the written cells back from the authoritative view. Small writes are
   * verified in full; large ones use a deterministic stride so the same region
   * always samples the same cells.
   */
  const verifyVoxelWrites = (writes: VoxelWrite[]) => {
    const v = voxelView();
    const stride =
      writes.length > VOXEL_FULL_READBACK_LIMIT
        ? Math.ceil(writes.length / VOXEL_READBACK_SAMPLE)
        : 1;
    let sampled = 0;
    let mismatch = 0;
    const mismatches: { x: number; y: number; z: number; expected: number; actual: number }[] = [];
    for (let i = 0; i < writes.length; i += stride) {
      const w = writes[i];
      const actual = v.getVoxel(w.x, w.y, w.z);
      sampled += 1;
      if (!voxelMatches(actual, w.value)) {
        mismatch += 1;
        if (mismatches.length < 8) {
          mismatches.push({ x: w.x, y: w.y, z: w.z, expected: w.value, actual });
        }
      }
    }
    return {
      mode: stride === 1 ? ('full' as const) : ('sampled' as const),
      stride,
      sampled,
      mismatch,
      mismatches,
    };
  };

  let operationSeq = 0;
  const nextOperationId = (name: string) => {
    operationSeq += 1;
    return `${name}-${Date.now().toString(36)}-${operationSeq.toString(36)}`;
  };

  /** Counts every caller sees on a write result. Additive; `changed` stays for compat. */
  type WriteTally = {
    requested: number;
    applied: number;
    verified: number;
    mismatch: number;
    rejected: number;
    unchanged: number;
  };

  const voxelWriteGuard = (
    b: number,
    tally: WriteTally,
    revision: string,
    operationId: string,
  ) => {
    // A guarded write rejects the whole request, so every requested cell counts
    // as rejected. Geometry-level rejections are reported separately.
    const rejectedTally = { ...tally, rejected: tally.requested };
    if (!isVoxelStateReady()) {
      return {
        success: false,
        code: 'VOXEL_STATE_NOT_READY',
        error:
          '体素状态未就绪（voxelState.ready=false），引擎会静默丢弃 setVoxel。请先让地图加载完成再写。',
        ...rejectedTally,
        changed: 0,
        revisionBefore: revision,
        revisionAfter: revision,
        newRevision: revision,
        changedBounds: null,
        operationId,
        undoToken: '[]',
      };
    }
    if (!isValidBlockId(b)) {
      const name = blockIndexTable()?.name?.[b & 0xfff];
      return {
        success: false,
        code: 'INVALID_BLOCK',
        error: `block ${b & 0xfff}${name ? ` (${name})` : ''} 不在本图 block 表中，引擎不会写入。请用 searchBlocks 取有效 id 后重试。`,
        ...rejectedTally,
        changed: 0,
        revisionBefore: revision,
        revisionAfter: revision,
        newRevision: revision,
        changedBounds: null,
        operationId,
        undoToken: '[]',
      };
    }
    return null;
  };

  // ───────────────────────────────────────────────────────────────────────────
  // Block catalog (N12 P1, contract mirror of the feather engine).
  // Ids/names come from this map's own runtime blockIndex; unknown names are
  // errors, never a fallback to 0/air.
  // ───────────────────────────────────────────────────────────────────────────

  type BlockIndexLoose = {
    id?: Record<string, number>;
    valid?: ArrayLike<number | boolean>;
    name?: string[];
    emissive?: ArrayLike<number>;
    texture?: ArrayLike<number>;
    mass?: ArrayLike<number>;
    restitution?: ArrayLike<number>;
    friction?: ArrayLike<number>;
    fluid?: ArrayLike<number>;
    velocity?: ArrayLike<number>;
  };

  type BlockEntry = {
    id: number;
    name: string;
    aliases: string[];
    category: string;
    valid: boolean;
    solid: boolean;
    fluid: boolean;
    collision: boolean;
    emissive: number;
    mass: number;
    friction: number;
    restitution: number;
    texture: number[];
    textureFrames: number[];
    velocity: [number, number, number];
    rotation: { bits: 2; supported: boolean };
    visualTags: string[];
  };

  const BLOCK_ALIAS_EXTRAS: Record<string, string[]> = {
    grass: ['草', '草地', '草坪', '青草'],
    dirt: ['泥土', '土', '土壤'],
    stone: ['石头', '岩石', '石块'],
    sand: ['沙', '沙子', '沙地'],
    water: ['水', '海水', '水面', '水池', '河流'],
    snow: ['雪', '雪地', '积雪'],
    ice: ['冰', '冰块'],
    green_leaf: ['树叶', '叶子', '树冠'],
    leaf_01: ['树叶', '叶子'],
    wood: ['木头', '木材', '原木'],
    plank_01: ['木板', '木板路'],
    red_brick: ['红砖', '砖墙', '砖块', '砖'],
    stone_brick_01: ['石砖'],
    light_grey_stone_brick: ['浅灰石砖'],
    glass: ['玻璃'],
    black: ['黑', '黑色'],
    white: ['白', '白色'],
    red: ['红', '红色'],
    blue: ['蓝', '蓝色'],
    yellow: ['黄', '黄色'],
    green: ['绿', '绿色'],
    purple: ['紫', '紫色'],
    orange: ['橙', '橙色'],
    pink: ['粉', '粉色'],
    lantern_01: ['灯笼', '灯'],
    red_light: ['红灯'],
    blue_light: ['蓝灯'],
    white_light: ['白灯'],
    warm_yellow_light: ['暖黄灯'],
    roof_red: ['红屋顶'],
    roof_blue_04: ['蓝屋顶'],
    palace_roof: ['宫殿屋顶'],
    dark_grass: ['深色草', '暗草'],
    rock: ['岩石'],
    grey_stone_brick: ['灰石砖'],
  };

  const BLOCK_CATEGORY_KEYS: Record<string, string> = {
    '0': 'default',
    '1': 'symbol',
    '2': 'number',
    '3': 'letter',
    '4': 'color',
    '5': 'nature',
    '6': 'structure',
    '7': 'light',
    '8': 'food',
    '9': 'element',
    default: 'default',
  };

  let categoryCache: { info: unknown; byId: Map<number, string> } | null = null;

  const blockCategoryMap = (): Map<number, string> => {
    const info = (state.game.state as unknown as { blockInfo?: unknown }).blockInfo;
    if (categoryCache && categoryCache.info === info) return categoryCache.byId;
    const byId = new Map<number, string>();
    const dict = (info as { category?: Record<string, ArrayLike<number>> } | undefined)?.category;
    if (dict) {
      for (const [key, ids] of Object.entries(dict)) {
        const category = BLOCK_CATEGORY_KEYS[key] ?? key;
        const length = Number(ids?.length ?? 0);
        for (let i = 0; i < length; ++i) byId.set(Number(ids[i]) & 0xfff, category);
      }
    }
    categoryCache = { info, byId };
    return byId;
  };

  const normalizeAlias = (value: string): string =>
    (value || '').trim().toLowerCase().replace(/[\s._-]+/g, '');

  const aliasOf = (name: string): string[] => {
    const trimmed = (name || '').trim();
    if (!trimmed) return [];
    const out = new Set<string>();
    const push = (value: string | undefined) => {
      if (value) out.add(value);
    };
    const lower = trimmed.toLowerCase();
    push(trimmed);
    push(lower);
    push(lower.replace(/[\s.-]+/g, '_'));
    push(normalizeAlias(lower));
    push(lower.replace(/^[^\w\u4e00-\u9fff]+/, ''));
    for (const extra of BLOCK_ALIAS_EXTRAS[trimmed] ?? []) push(extra);
    return Array.from(out);
  };

  const visualTagsOf = (name: string, fluid: boolean, emissive: number): string[] => {
    const lower = (name || '').toLowerCase();
    const tags: string[] = [];
    if (fluid) tags.push('fluid');
    if (emissive > 0) tags.push('emissive');
    if (/grass|leaf|tree|plant|flower|bush|log|wood|mushroom/.test(lower)) tags.push('nature');
    if (/brick|stone|concrete|wall|metal|plate|glass|tile|marble|plank/.test(lower)) tags.push('structure');
    if (/water|lava|acid|oil/.test(lower)) tags.push('liquid');
    if (/sand|dirt|soil|mud|snow|gravel/.test(lower)) tags.push('ground');
    if (/lamp|light|torch|glow/.test(lower)) tags.push('light');
    return tags;
  };

  const fallbackCategory = (tags: string[]): string => {
    if (tags.includes('light')) return 'light';
    if (tags.includes('structure')) return 'structure';
    if (tags.includes('nature')) return 'nature';
    if (tags.includes('liquid')) return 'element';
    return 'default';
  };

  const blockEntryAt = (index: BlockIndexLoose, id: number): BlockEntry => {
    const name = index.name?.[id] ?? '';
    const fluidValue = Number(index.fluid?.[id] ?? 0);
    const emissive = Number(index.emissive?.[id] ?? 0);
    const fluid = id !== 0 && fluidValue > 0;
    const tags = visualTagsOf(name, fluid, emissive);
    const texture: number[] = [];
    const textureFrames: number[] = [];
    for (let i = 0; i < 6; ++i) {
      const raw = Number(index.texture?.[6 * id + i] ?? 0) >>> 0;
      texture.push(raw & 0xffffff);
      textureFrames.push((raw >>> 24) & 0xff);
    }
    const velocity = [0, 1, 2].map((i) => Number(index.velocity?.[3 * id + i] ?? 0));
    const valid = !!index.valid?.[id];
    return {
      id,
      name,
      aliases: aliasOf(name),
      category: blockCategoryMap().get(id) ?? fallbackCategory(tags),
      valid,
      solid: valid && id !== 0 && !fluid,
      fluid,
      collision: valid && id !== 0 && !fluid,
      emissive,
      mass: Number(index.mass?.[id] ?? 0),
      friction: Number(index.friction?.[id] ?? 0),
      restitution: Number(index.restitution?.[id] ?? 0),
      texture,
      textureFrames,
      velocity: [velocity[0] ?? 0, velocity[1] ?? 0, velocity[2] ?? 0],
      rotation: { bits: 2, supported: valid },
      visualTags: tags,
    };
  };

  const blockTableSize = (index: BlockIndexLoose): number =>
    Math.min(0x1000, Math.max(index.valid?.length ?? 0, index.name?.length ?? 0));

  const allBlockEntries = (includeInvalid = false): BlockEntry[] => {
    const index = blockIndexTable() as BlockIndexLoose | undefined;
    if (!index) return [];
    const size = blockTableSize(index);
    const out: BlockEntry[] = [];
    for (let id = 0; id < size; ++id) {
      const entry = blockEntryAt(index, id);
      if (!entry.name) continue;
      if (!includeInvalid && !entry.valid) continue;
      out.push(entry);
    }
    return out;
  };

  const findBlockEntries = (key: string): BlockEntry[] => {
    const index = blockIndexTable() as BlockIndexLoose | undefined;
    if (!index) return [];
    const wanted = key.trim();
    if (!wanted) return [];
    const dict = index.id ?? {};
    const wantedLower = wanted.toLowerCase();
    const wantedNorm = normalizeAlias(wanted);
    const found = new Map<number, BlockEntry>();
    const add = (id: number) => {
      const masked = id & 0xfff;
      found.set(masked, blockEntryAt(index, masked));
    };
    if (Object.prototype.hasOwnProperty.call(dict, wanted)) add(dict[wanted]);
    if (/^\d+$/.test(wanted)) {
      const numeric = Number(wanted);
      if (Number.isSafeInteger(numeric) && numeric <= 0xffff) add(numeric);
    }
    for (const [name, id] of Object.entries(dict)) {
      if (name.toLowerCase() === wantedLower || normalizeAlias(name) === wantedNorm) add(id);
    }
    if (found.size > 0) return Array.from(found.values());
    const names = index.name ?? [];
    for (let id = 0; id < names.length; ++id) {
      const entry = blockEntryAt(index, id);
      if (!entry.name) continue;
      if (
        entry.aliases.some(
          (alias) => alias.toLowerCase() === wantedLower || normalizeAlias(alias) === wantedNorm,
        )
      ) {
        add(id);
      }
    }
    return Array.from(found.values());
  };

  const resolveBlockKey = (key: number | string): BlockEntry | undefined => {
    const index = blockIndexTable() as BlockIndexLoose | undefined;
    if (!index) return undefined;
    if (typeof key === 'number') {
      if (!Number.isInteger(key) || key < 0 || key > 0xffff) return undefined;
      return blockEntryAt(index, key & 0xfff);
    }
    const matches = findBlockEntries(key);
    return matches.length === 1 ? matches[0] : undefined;
  };

  const blockNameOf = (id: number): string =>
    blockIndexTable()?.name?.[id & 0xfff] || `block_${id & 0xfff}`;

  const blockAliasFailure = (
    key: number | string,
    requested: number,
    revision: string,
    operationId: string,
  ) => {
    const candidates =
      typeof key === 'string'
        ? findBlockEntries(key)
            .slice(0, 8)
            .map((entry) => ({ id: entry.id, name: entry.name, category: entry.category }))
        : [];
    return {
      success: false,
      code: 'UNKNOWN_BLOCK_ALIAS',
      error:
        candidates.length > 1
          ? `block 名称 "${key}" 命中 ${candidates.length} 个块，无法唯一解析；请用更精确的名字或直接传 id。`
          : `block 名称 "${key}" 不在本图 block 表中；请用 blockCatalog/searchBlocks 查找名字，禁止猜 id。`,
      key,
      candidates,
      requested,
      applied: 0,
      verified: 0,
      mismatch: 0,
      rejected: requested,
      unchanged: 0,
      changed: 0,
      revisionBefore: revision,
      revisionAfter: revision,
      newRevision: revision,
      changedBounds: null,
      operationId,
      undoToken: '[]',
    };
  };

  const voxelTuple = z.tuple([
    z.number().int().min(0),
    z.number().int().min(0),
    z.number().int().min(0),
  ]);
  const regionSchema = z
    .object({
      min: voxelTuple.describe('Inclusive lower corner [x,y,z]'),
      max: voxelTuple.describe('Inclusive upper corner [x,y,z]'),
    })
    .describe('Axis-aligned voxel region');

  return {
    uiContext: tool({description:'Read bounded authoritative existing UI nodes and revision for property-only proposals. Names, IDs, hierarchy and scripts are retained.',
      inputSchema:z.object({ids:z.array(z.string()).max(256).optional(),offset:z.number().int().min(0).default(0),limit:z.number().int().min(1).max(256).default(64)}),
      execute:async({ids,offset,limit})=>{
        const tree=readUiContent(state);
        const nodes=Object.values(tree).filter((node:any)=>node.value && (!ids||ids.includes(node.id)));
        return {success:true,revision:uiContentRevision(tree),total:nodes.length,nodes:nodes.slice(offset,offset+limit),truncated:offset+limit<nodes.length};
      }}),
    terrainInfo: tool({
      description:
        'Read the current terrain size, the live preview/running flag and a revision token for optimistic-locked terrain writes.',
      inputSchema: z.object({}),
      execute: async () => {
        logger.info({ gameId }, '[AI Tool] terrainInfo');
        const v = voxelView();
        return {
          success: true,
          shape: v.shape,
          previewRunning: isPreviewRunning(),
          revision: computeTerrainRevision(v),
        };
      },
    }),

    terrainRead: tool({
      description:
        'Read voxels in an axis-aligned region. Returns the packed uint16 value per cell plus a revision token.',
      inputSchema: z.object({
        region: regionSchema,
        limit: z
          .number()
          .int()
          .min(1)
          .max(200_000)
          .optional()
          .describe('Max cells to return (default 20000)'),
      }),
      execute: async ({ region, limit = 20_000 }) => {
        logger.info({ region, limit }, '[AI Tool] terrainRead');
        try {
          const { cells, total } = readRegion(region, limit, true);
          return {
            success: true,
            total,
            truncated: total > limit,
            cells,
            revision: computeTerrainRevision(voxelView()),
          };
        } catch (error: unknown) {
          return { success: false, error: getErrorMessage(error) };
        }
      },
    }),

    terrainApply: tool({
      description:
        'Batch-write voxels over a region (fill a box, or a flat height floor) with a single block value. ' +
        'Requires the current revision token for optimistic locking. ' +
        'While the live preview is running the engine does NOT record voxel chunk hashes on save ' +
        '(replica-server.ts), so by default this refuses; stop the preview or pass allowWhileRunning.',
      inputSchema: z.object({
        region: regionSchema,
        block: blockSchema.describe('Block/type id to write (rotation bits ignored unless `rotation` given)'),
        rotation: z
          .number()
          .int()
          .min(0)
          .max(3)
          .optional()
          .describe('Optional 2-bit rotation to store alongside the block id'),
        expectedRevision: z.string().describe('Revision token from terrainRead/terrainInfo; write is refused on mismatch'),
        allowWhileRunning: z
          .boolean()
          .optional()
          .describe('Apply in-memory even while preview runs; persistence still requires stopping the preview'),
        dryRun: z.boolean().optional().describe('Compute the change set without writing (default false)'),
      }),
      execute: async ({
        region,
        block,
        rotation,
        expectedRevision,
        allowWhileRunning = false,
        dryRun = false,
      }) => {
        logger.info(
          { region, block, rotation, expectedRevision, dryRun },
          '[AI Tool] terrainApply',
        );
        const operationId = nextOperationId('terrainApply');
        try {
          const view = voxelView();
          const revisionBefore = computeTerrainRevision(view);
          const { cells } = readRegion(region);
          const requested = cells.length;
          const tally: WriteTally = {
            requested,
            applied: 0,
            verified: 0,
            mismatch: 0,
            rejected: 0,
            unchanged: 0,
          };
          const currentRevision = revisionBefore;
          if (expectedRevision && expectedRevision !== revisionBefore) {
            return {
              success: false,
              code: 'REVISION_CONFLICT',
              error: 'terrain changed since read; re-read then retry',
              currentRevision,
              revisionBefore,
              revisionAfter: revisionBefore,
              newRevision: revisionBefore,
              ...tally,
              changed: 0,
              changedBounds: null,
              operationId,
              undoToken: '[]',
            };
          }
          if (isPreviewRunning() && !allowWhileRunning) {
            return {
              success: false,
              code: 'PREVIEW_RUNNING',
              error:
                '预览正在运行：保存时不会记录体素 chunk（replica-server.ts:1602）。' +
                '请先停止预览再写入并保存，或传 allowWhileRunning=true 仅改内存态。',
              revisionBefore,
              revisionAfter: revisionBefore,
              newRevision: revisionBefore,
              ...tally,
              changed: 0,
              changedBounds: null,
              operationId,
              undoToken: '[]',
            };
          }
          if (requested === 0) {
            return {
              success: false,
              code: 'EMPTY_REGION',
              error: 'region resolves to zero in-bounds cells',
              ...tally,
              changed: 0,
              revisionBefore,
              revisionAfter: revisionBefore,
              newRevision: revisionBefore,
              changedBounds: null,
              operationId,
              undoToken: '[]',
            };
          }
          if (requested > 500_000) {
            return {
              success: false,
              code: 'TOO_LARGE',
              error: 'region exceeds 500000 cells',
              ...tally,
              changed: 0,
              revisionBefore,
              revisionAfter: revisionBefore,
              newRevision: revisionBefore,
              changedBounds: null,
              operationId,
              undoToken: '[]',
            };
          }

          const resolved = typeof block === 'string' ? resolveBlockKey(block) : undefined;
          if (typeof block === 'string' && !resolved) {
            return blockAliasFailure(block, requested, revisionBefore, operationId);
          }
          const blockId = resolved ? resolved.id : (block as number);
          const b = encodeBlock(blockId, rotation);
          const guard = voxelWriteGuard(b, tally, revisionBefore, operationId);
          if (guard) return guard;

          const writable: { x: number; y: number; z: number }[] = [];
          for (const cell of cells) {
            if (isWritableCell(cell.x, cell.y, cell.z)) writable.push(cell);
          }
          tally.rejected = requested - writable.length;

          if (dryRun) {
            const planned: { x: number; y: number; z: number }[] = [];
            for (const cell of writable) {
              if (voxelMatches(view.getVoxel(cell.x, cell.y, cell.z), b)) {
                tally.unchanged += 1;
              } else {
                planned.push(cell);
              }
            }
            tally.applied = 0;
            tally.verified = 0;
            return {
              success: true,
              dryRun: true,
              ...tally,
              changed: planned.length,
              planned: planned.length,
              block: b,
              readback: { mode: 'none' as const, sampled: 0, stride: 0, mismatches: [] },
              revisionBefore,
              revisionAfter: revisionBefore,
              newRevision: revisionBefore,
              changedBounds: boundsOfCells(planned),
              operationId,
              undoToken: '[]',
            };
          }

          const writer = voxelWriter();
          const writes: VoxelWrite[] = [];
          const changes: { x: number; y: number; z: number; prev: number }[] = [];
          for (const cell of writable) {
            const prev = view.getVoxel(cell.x, cell.y, cell.z);
            if (voxelMatches(prev, b)) {
              tally.unchanged += 1;
              continue;
            }
            writes.push({ x: cell.x, y: cell.y, z: cell.z, value: b });
            changes.push({ x: cell.x, y: cell.y, z: cell.z, prev });
            writer.setVoxel(cell.x, cell.y, cell.z, b);
          }

          const readback = verifyVoxelWrites(writes);
          tally.mismatch = readback.mismatch;
          tally.verified = readback.sampled - readback.mismatch;
          tally.applied = writes.length - readback.mismatch;
          const revisionAfter = computeTerrainRevision(voxelView());
          const appliedChanges =
            readback.mismatch === 0 ? changes : changes.slice(0, 0);

          if (writes.length === 0) {
            // Nothing to do is a real outcome, not a failure: the region already
            // holds `b` (or every cell was outside setVoxel's writable range).
            return {
              success: tally.rejected === 0,
              dryRun: false,
              noop: true,
              ...(tally.rejected > 0 && writable.length === 0
                ? { code: 'NOTHING_WRITABLE', error: 'region lies on the outermost plane; setVoxel cannot write it' }
                : {}),
              ...tally,
              changed: 0,
              block: b,
              readback: { ...readback, mismatches: readback.mismatches },
              revisionBefore,
              revisionAfter,
              newRevision: revisionAfter,
              changedBounds: null,
              operationId,
              undoToken: '[]',
            };
          }
          if (readback.mismatch > 0) {
            return {
              success: false,
              code: 'WRITE_NOT_APPLIED',
              error: `引擎未真正落库：回读 ${readback.sampled} 格中 ${readback.mismatch} 格与期望值不符`,
              dryRun: false,
              ...tally,
              changed: tally.applied,
              block: b,
              readback,
              revisionBefore,
              revisionAfter,
              newRevision: revisionAfter,
              changedBounds: boundsOfCells(writes),
              operationId,
              undoToken: JSON.stringify(changes),
            };
          }

          return {
            success: true,
            dryRun: false,
            ...tally,
            changed: tally.applied,
            block: b,
            readback,
            revisionBefore,
            revisionAfter,
            newRevision: revisionAfter,
            changedBounds: boundsOfCells(writes),
            // Undo token: replay these (x,y,z)->prev writes via terrainRevert to roll back.
            undoToken: JSON.stringify(appliedChanges),
            // The operation id is the caller's audit handle for this exact
            // transaction; it must be on the success path too (revert and the
            // failure branches already return it).
            operationId,
            persistWarning:
              isPreviewRunning() && allowWhileRunning
                ? 'In-memory only: stop the preview before save to persist voxel chunk hashes.'
                : undefined,
          };
        } catch (error: unknown) {
          return { success: false, error: getErrorMessage(error), operationId };
        }
      },
    }),

    terrainRevert: tool({
      description:
        'Roll back a previous terrainApply by replaying its undo token (restores prior voxel values).',
      inputSchema: z.object({
        undoToken: z.string().describe('The undoToken returned by terrainApply'),
        expectedRevision: z.string().optional().describe('Refuse rollback if terrain changed after apply'),
      }),
      execute: async ({ undoToken, expectedRevision }) => {
        logger.info({ gameId }, '[AI Tool] terrainRevert');
        const operationId = nextOperationId('terrainRevert');
        try {
          const changes = JSON.parse(undoToken) as {
            x: number;
            y: number;
            z: number;
            prev: number;
          }[];
          if (!Array.isArray(changes)) {
            return { success: false, error: 'Invalid undo token', operationId };
          }
          const view = voxelView();
          const revisionBefore = computeTerrainRevision(view);
          if (expectedRevision && expectedRevision !== revisionBefore) {
            return { success: false, code: 'REVISION_CONFLICT', error: 'Terrain changed; rollback refused', operationId, newRevision: revisionBefore };
          }
          if (isPreviewRunning()) {
            return { success: false, code: 'PREVIEW_RUNNING', error: 'Stop preview before rollback', operationId, newRevision: revisionBefore };
          }
          if (changes.length > 500_000 || changes.some(c => !c || !Number.isInteger(c.x) || !Number.isInteger(c.y) || !Number.isInteger(c.z) || !Number.isInteger(c.prev) || !inBounds(c.x, c.y, c.z) || !isWritableCell(c.x, c.y, c.z) || !isValidBlockId(c.prev))) {
            return { success: false, code: 'INVALID_UNDO_TOKEN', error: 'Undo contains invalid or unwritable cells', operationId, newRevision: revisionBefore };
          }
          const tally: WriteTally = {
            requested: changes.length,
            applied: 0,
            verified: 0,
            mismatch: 0,
            rejected: 0,
            unchanged: 0,
          };
          if (changes.length === 0) {
            return {
              success: true,
              noop: true,
              ...tally,
              restored: 0,
              revisionBefore,
              revisionAfter: revisionBefore,
              newRevision: revisionBefore,
              changedBounds: null,
              operationId,
            };
          }
          if (!isVoxelStateReady()) {
            return {
              success: false,
              code: 'VOXEL_STATE_NOT_READY',
              error: '体素状态未就绪，回滚会被引擎静默丢弃。',
              ...tally,
              restored: 0,
              revisionBefore,
              revisionAfter: revisionBefore,
              newRevision: revisionBefore,
              changedBounds: null,
              operationId,
            };
          }

          const writer = voxelWriter();
          const writes: VoxelWrite[] = [];
          for (const c of changes) {
            if (!inBounds(c.x, c.y, c.z) || !isWritableCell(c.x, c.y, c.z)) {
              tally.rejected += 1;
              continue;
            }
            const prev = c.prev | 0;
            if (!isValidBlockId(prev)) {
              tally.rejected += 1;
              continue;
            }
            if (voxelMatches(view.getVoxel(c.x, c.y, c.z), prev)) {
              tally.unchanged += 1;
              continue;
            }
            writes.push({ x: c.x, y: c.y, z: c.z, value: prev });
            writer.setVoxel(c.x, c.y, c.z, prev);
          }

          const readback = verifyVoxelWrites(writes);
          tally.mismatch = readback.mismatch;
          tally.verified = readback.sampled - readback.mismatch;
          tally.applied = writes.length - readback.mismatch;
          const revisionAfter = computeTerrainRevision(voxelView());

          return {
            success: readback.mismatch === 0,
            ...(readback.mismatch > 0
              ? {
                  code: 'WRITE_NOT_APPLIED',
                  error: `回滚未完全落库：回读 ${readback.sampled} 格中 ${readback.mismatch} 格仍是旧值`,
                }
              : {}),
            ...tally,
            restored: tally.applied,
            readback,
            revisionBefore,
            revisionAfter,
            newRevision: revisionAfter,
            changedBounds: boundsOfCells(writes),
            operationId,
          };
        } catch (error: unknown) {
          return { success: false, error: getErrorMessage(error), operationId };
        }
      },
    }),

    blockCatalog: tool({
      description:
        'List this map\'s OWN block table with authoring metadata (id, name, aliases, category, solid/fluid/collision, ' +
        'texture, rotation, visualTags). Imported maps can have different ids, so read the catalog instead of assuming ' +
        'bundled ids. Filter by category (default|symbol|number|letter|color|nature|structure|light|food|element).',
      inputSchema: z.object({
        category: z.string().optional(),
        includeInvalid: z.boolean().optional(),
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(500).optional(),
      }),
      execute: async ({ category, includeInvalid = false, offset = 0, limit = 100 }) => {
        const all = allBlockEntries(includeInvalid);
        const categories: Record<string, number> = {};
        for (const entry of all) categories[entry.category] = (categories[entry.category] ?? 0) + 1;
        const filtered = category ? all.filter((entry) => entry.category === category) : all;
        const page = filtered.slice(offset, offset + limit);
        return {
          success: true,
          total: filtered.length,
          tableSize: blockTableSize(blockIndexTable() as BlockIndexLoose),
          categories,
          offset,
          returned: page.length,
          nextOffset: offset + page.length < filtered.length ? offset + page.length : null,
          blocks: page,
        };
      },
    }),

    getBlock: tool({
      description:
        'Resolve ONE block by id, exact name or alias. Unknown or ambiguous names fail with UNKNOWN_BLOCK_ALIAS and ' +
        'candidate list; this tool never falls back to air.',
      inputSchema: z.object({ key: blockKeySchema }),
      execute: async ({ key }) => {
        const matches =
          typeof key === 'number'
            ? resolveBlockKey(key)
              ? [resolveBlockKey(key) as BlockEntry]
              : []
            : findBlockEntries(key);
        if (matches.length === 1) return { success: true, block: matches[0] };
        return {
          success: false,
          code: 'UNKNOWN_BLOCK_ALIAS',
          key,
          ambiguous: matches.length > 1,
          candidates: matches.slice(0, 16).map((entry) => ({
            id: entry.id,
            name: entry.name,
            category: entry.category,
          })),
          error:
            matches.length > 1
              ? `"${key}" 命中 ${matches.length} 个块，请用更精确的名字或直接传 id。`
              : `"${key}" 不在本图 block 表中。`,
        };
      },
    }),

    resolvePalette: tool({
      description:
        'Resolve a role -> block name/id palette in one call. Unresolved roles are reported, never replaced with air; ' +
        'strict=true fails the whole palette when any role is missing.',
      inputSchema: z.object({
        palette: z.record(z.string(), blockKeySchema),
        strict: z.boolean().optional(),
      }),
      execute: async ({ palette, strict = false }) => {
        const ids: Record<string, number> = {};
        const resolved: Record<
          string,
          { requested: number | string; id: number; name: string; category: string }
        > = {};
        const missing: { role: string; key: number | string; reason: string; candidates?: unknown[] }[] = [];
        for (const [role, key] of Object.entries(palette)) {
          const entry = resolveBlockKey(key);
          if (!entry) {
            const candidates = typeof key === 'string' ? findBlockEntries(key).slice(0, 8) : [];
            missing.push({
              role,
              key,
              reason: candidates.length > 1 ? 'ambiguous' : 'unknown',
              ...(candidates.length
                ? {
                    candidates: candidates.map((candidate) => ({
                      id: candidate.id,
                      name: candidate.name,
                    })),
                  }
                : {}),
            });
            continue;
          }
          if (!entry.valid) {
            missing.push({ role, key, reason: 'invalid-block' });
            continue;
          }
          ids[role] = entry.id;
          resolved[role] = {
            requested: key,
            id: entry.id,
            name: entry.name,
            category: entry.category,
          };
        }
        const complete = missing.length === 0;
        return {
          success: strict ? complete : true,
          complete,
          ...(strict && !complete ? { code: 'UNKNOWN_BLOCK_ALIAS' } : {}),
          ...(strict && !complete
            ? { error: `palette 有 ${missing.length} 个角色未解析：${missing.map((item) => item.role).join(', ')}` }
            : {}),
          ids,
          resolved,
          missing,
          paletteSize: Object.keys(palette).length,
        };
      },
    }),

    searchBlocks: tool({
      description:
        'Search the map block table by name/alias/category/visual tag (e.g. "grass", "stone", "砖", "light"). ' +
        'Returns full authoring metadata so terrain tools can take the NAME instead of a guessed id.',
      inputSchema: z.object({
        query: z.string().optional(),
        category: z.string().optional(),
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      }),
      execute: async ({ query = '', category, offset = 0, limit = 40 }) => {
        const catalog = allBlockEntries(false);
        const index = blockIndexTable() as BlockIndexLoose | undefined;
        const tokens = query
          .trim()
          .toLowerCase()
          .split(/\s+/)
          .filter(Boolean);
        const matches = catalog.filter((entry) => {
          if (category && entry.category !== category) return false;
          if (tokens.length === 0) return true;
          const haystack = [entry.name, ...entry.aliases, entry.category, ...entry.visualTags]
            .join(' ')
            .toLowerCase();
          const haystackNorm = normalizeAlias(haystack);
          return tokens.every(
            (token) => haystack.includes(token) || haystackNorm.includes(normalizeAlias(token)),
          );
        });
        const exact = query.trim() ? resolveBlockKey(query) : undefined;
        const ordered = exact ? [exact, ...matches.filter((entry) => entry.id !== exact.id)] : matches;
        const page = ordered.slice(offset, offset + limit);
        return {
          success: true,
          total: catalog.length,
          tableSize: index?.name?.length ?? 0,
          matchCount: ordered.length,
          offset,
          returned: page.length,
          nextOffset: offset + page.length < ordered.length ? offset + page.length : null,
          resolved: exact ? { id: exact.id, name: exact.name, category: exact.category } : null,
          matches: page,
        };
      },
    }),

    uiTreeRead: tool({
      description:
        'Read the current UI tree as JSON (screens and elements) plus a revision token for optimistic-locked writes.',
      inputSchema: z.object({}),
      execute: async () => {
        logger.info({ gameId }, '[AI Tool] uiTreeRead');
        const tree = (state.replica.project as any).uiTree ?? {};
        const nodes = Object.values(tree).map((node: any) => ({
          id: node.id,
          name: node.name,
          parentId: node.parentId,
          type: node.type,
          childrenIds: node.childrenIds,
          value: node.value,
        }));
        return {
          success: true,
          nodes,
          total: nodes.length,
          revision: computeUiRevision(tree),
        };
      },
    }),

    uiNodeAdd: tool({
      description:
        'Add a UI node (screen or element) to the UI tree through a project transaction (auto-rollback on failure). ' +
        'Requires the current UI revision token for optimistic locking.',
      inputSchema: z.object({
        parentId: z
          .string()
          .optional()
          .describe('Parent node id; defaults to the default screen node'),
        name: z.string().describe('Node name'),
        nodeType: z
          .enum(['screen', 'element'])
          .describe('UINode union discriminator: screen or element'),
        data: z
          .record(z.string(), z.any())
          .describe(
            'Union payload. For screen: { zIndex, enable, layout:{ type, data } }. ' +
              'For element: one of { box|image|text|scrollBox|input: {...} } handled by the editor.',
          ),
        expectedRevision: z.string().describe('UI revision token from uiTreeRead; refused on mismatch'),
      }),
      execute: async ({ parentId, name, nodeType, data, expectedRevision }) => {
        logger.info({ name, nodeType }, '[AI Tool] uiNodeAdd');
        try {
          const tree = (state.replica.project as any).uiTree ?? {};
          const currentRevision = computeUiRevision(tree);
          if (expectedRevision && expectedRevision !== currentRevision) {
            return {
              success: false,
              code: 'REVISION_CONFLICT',
              error: 'UI tree changed since read; re-read then retry',
              currentRevision,
            };
          }
          const tx = replica.projectTransaction();
          const nodeId = ((Math.random() * (1 << 30)) >>> 0).toString();
          tx.push((action) => {
            const newNode = UITreeRDA.nodeSchema.alloc();
            newNode.id = nodeId;
            newNode.name = name;
            newNode.parentId = parentId || DEFAULT_SCREEN_ID;
            newNode.type = TreeNodeType.leaf;
            // Value is the UINode union { screen | element }.
            // @ts-ignore - dynamic union value assignment mirrors createEntity.
            newNode.value = { type: nodeType, data };
            return action.uiTree.add(newNode);
          });
          await tx.commit();
          return {
            success: true,
            nodeId,
            newRevision: computeUiRevision((state.replica.project as any).uiTree),
          };
        } catch (error: unknown) {
          return { success: false, error: getErrorMessage(error) };
        }
      },
    }),

    uiNodeRemove: tool({
      description:
        'Remove UI nodes by id through a project transaction (auto-rollback on failure).',
      inputSchema: z.object({
        nodeIds: z.array(z.string()).describe('Node ids to remove'),
      }),
      execute: async ({ nodeIds }) => {
        logger.info({ nodeIds }, '[AI Tool] uiNodeRemove');
        try {
          const tx = replica.projectTransaction();
          tx.push((action) => action.uiTree.remove(nodeIds));
          await tx.commit();
          return {
            success: true,
            newRevision: computeUiRevision((state.replica.project as any).uiTree),
          };
        } catch (error: unknown) {
          return { success: false, error: getErrorMessage(error) };
        }
      },
    }),
  };
};
