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
import { Logger } from 'pino';
import { z } from 'zod';
import { EditServerState } from '../edit-server-schema';
import { EditReplicaServer } from '../replica/replica-server';

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
 * A deterministic revision token for the current live terrain, computed by
 * sampling the voxel grid. Sampling (instead of hashing every cell) keeps this
 * O(<=~64k) even on 256^3 worlds; it is an optimistic-lock token, not a
 * content-identity hash.
 */
function computeTerrainRevision(voxels: {
  shape: [number, number, number];
  getVoxel: (x: number, y: number, z: number) => number;
}): string {
  const [sx, sy, sz] = voxels.shape;
  const step = (dim: number) => Math.max(1, Math.ceil(Math.cbrt((sx * sy * sz) / 65536)));
  const st = Math.min(step(sx), step(sy), step(sz));
  return fnv1a((push) => {
    push(sx);
    push(sy);
    push(sz);
    for (let x = 0; x < sx; x += st) {
      for (let y = 0; y < sy; y += st) {
        for (let z = 0; z < sz; z += st) {
          push(voxels.getVoxel(x, y, z));
        }
      }
    }
  });
}

/** Deterministic revision token for the current UI tree. */
function computeUiRevision(tree: unknown): string {
  const nodes = (tree ?? {}) as Record<string, any>;
  const ids = Object.keys(nodes).sort();
  return fnv1a((push) => {
    push(ids.length);
    for (const id of ids) {
      const node = nodes[id];
      for (let i = 0; i < id.length; ++i) push(id.charCodeAt(i));
      push(node?.type ?? -1);
      const kids = node?.childrenIds ?? [];
      push(kids.length);
      const parent = node?.parentId ?? '';
      for (let i = 0; i < parent.length; ++i) push(parent.charCodeAt(i));
    }
  });
}

const blockSchema = z
  .number()
  .int()
  .min(0)
  .max(0xffff)
  .describe(
    'Packed uint16 voxel value. Low 14 bits = block/type id, top 2 bits = rotation. ' +
      'Prefer passing a plain type id and the optional `rotation`; never exceed 0xffff.',
  );

export const createMapAuthoringTools = (
  replica: EditReplicaServer,
  state: EditServerState,
  gameId: number,
  logger: Logger,
) => {
  const voxels = () => state.game.voxel as unknown as {
    shape: [number, number, number];
    getVoxel: (x: number, y: number, z: number) => number;
    setVoxel: (x: number, y: number, z: number, b: number) => unknown;
    setVoxelRotate?: (x: number, y: number, z: number, rotate: number) => unknown;
  };
  const isPreviewRunning = () => !!state.game.state.replica.running;

  /** Bounds check that mirrors what `VoxelView.setVoxel` unfortunately omits. */
  const inBounds = (x: number, y: number, z: number) => {
    const v = voxels();
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
  }) => {
    const v = voxels();
    const cells: { x: number; y: number; z: number; b: number }[] = [];
    const x0 = Math.max(0, region.min[0]);
    const y0 = Math.max(0, region.min[1]);
    const z0 = Math.max(0, region.min[2]);
    const x1 = Math.min(v.shape[0] - 1, region.max[0]);
    const y1 = Math.min(v.shape[1] - 1, region.max[1]);
    const z1 = Math.min(v.shape[2] - 1, region.max[2]);
    for (let x = x0; x <= x1; ++x) {
      for (let y = y0; y <= y1; ++y) {
        for (let z = z0; z <= z1; ++z) {
          cells.push({ x, y, z, b: v.getVoxel(x, y, z) });
        }
      }
    }
    return cells;
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
    terrainInfo: tool({
      description:
        'Read the current terrain size, the live preview/running flag and a revision token for optimistic-locked terrain writes.',
      inputSchema: z.object({}),
      execute: async () => {
        logger.info({ gameId }, '[AI Tool] terrainInfo');
        const v = voxels();
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
          const cells = readRegion(region);
          return {
            success: true,
            total: cells.length,
            truncated: cells.length > limit,
            cells: cells.slice(0, limit),
            revision: computeTerrainRevision(voxels()),
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
        try {
          const v = voxels();
          const currentRevision = computeTerrainRevision(v);
          if (expectedRevision && expectedRevision !== currentRevision) {
            return {
              success: false,
              code: 'REVISION_CONFLICT',
              error: 'terrain changed since read; re-read then retry',
              currentRevision,
            };
          }
          if (isPreviewRunning() && !allowWhileRunning) {
            return {
              success: false,
              code: 'PREVIEW_RUNNING',
              error:
                '预览正在运行：保存时不会记录体素 chunk（replica-server.ts:1602）。' +
                '请先停止预览再写入并保存，或传 allowWhileRunning=true 仅改内存态。',
            };
          }
          const b = encodeBlock(block, rotation);
          const cells = readRegion(region);
          if (cells.length === 0) {
            return { success: false, code: 'EMPTY_REGION', error: 'region resolves to zero in-bounds cells' };
          }
          if (cells.length > 500_000) {
            return { success: false, code: 'TOO_LARGE', error: 'region exceeds 500000 cells' };
          }
          const changes: { x: number; y: number; z: number; prev: number }[] = [];
          for (const cell of cells) {
            if (!inBounds(cell.x, cell.y, cell.z)) continue;
            changes.push({ x: cell.x, y: cell.y, z: cell.z, prev: v.getVoxel(cell.x, cell.y, cell.z) });
            if (!dryRun) {
              // setVoxel stores the already-packed value (type bits + optional
              // rotation); the packed `b` carries rotation when `rotation` given.
              v.setVoxel(cell.x, cell.y, cell.z, b);
            }
          }
          return {
            success: true,
            dryRun,
            changed: changes.length,
            block: b,
            newRevision: computeTerrainRevision(v),
            // Undo token: replay these (x,y,z)->prev writes via terrainRevert to roll back.
            undoToken: JSON.stringify(changes),
            persistWarning:
              isPreviewRunning() && allowWhileRunning
                ? 'In-memory only: stop the preview before save to persist voxel chunk hashes.'
                : undefined,
          };
        } catch (error: unknown) {
          return { success: false, error: getErrorMessage(error) };
        }
      },
    }),

    terrainRevert: tool({
      description:
        'Roll back a previous terrainApply by replaying its undo token (restores prior voxel values).',
      inputSchema: z.object({
        undoToken: z.string().describe('The undoToken returned by terrainApply'),
      }),
      execute: async ({ undoToken }) => {
        logger.info({ gameId }, '[AI Tool] terrainRevert');
        try {
          const changes = JSON.parse(undoToken) as {
            x: number;
            y: number;
            z: number;
            prev: number;
          }[];
          if (!Array.isArray(changes)) {
            return { success: false, error: 'Invalid undo token' };
          }
          const v = voxels();
          let restored = 0;
          for (const c of changes) {
            if (!inBounds(c.x, c.y, c.z)) continue;
            v.setVoxel(c.x, c.y, c.z, c.prev | 0);
            restored += 1;
          }
          return {
            success: true,
            restored,
            newRevision: computeTerrainRevision(v),
          };
        } catch (error: unknown) {
          return { success: false, error: getErrorMessage(error) };
        }
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
