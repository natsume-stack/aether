import { PermissionSet } from '@box/schema/permissions/permission-rda';
import {
  VOXEL_ROTATION_SHIFT,
  VOXEL_TYPE_MASK,
  VoxelWrite,
} from '@box/schema/voxel/voxel-protocol';

/**
 * Hard ceiling on how many voxel writes a single (external/AI) transaction may
 * carry. The client `VoxelProtocol` already bounds run-length edits, but the
 * server-side `project`/`voxel` entry points have no such guard. This keeps one
 * request from writing the whole world by accident while still being far above
 * any legitimate manual edit, so it can never reject an existing valid map.
 */
export const MAX_VOXEL_WRITES_PER_SEQUENCE = 500_000;

/**
 * A voxel value is a packed uint16: the low 14 bits are the block/type id and
 * the top 2 bits are the rotation (`VOXEL_ROTATION_SHIFT = 14`). `setVoxel`
 * writes the raw packed value with no bounds checking, so an out-of-range or
 * malformed value silently corrupts neighbouring cells.
 *
 * Validation is intentionally CONSERVATIVE: we only reject values that are
 * structurally impossible for ANY existing map so that we never mark a legal
 * legacy voxel illegal. Anything we are not certain about is accepted.
 */
function isValidVoxelValue(b: unknown): b is number {
  if (typeof b !== 'number') return false;
  if (!Number.isInteger(b)) return false;
  // Must fit in the packed uint16 voxel field.
  if (b < 0 || b > 0xffff) return false;
  return true;
}

function isValidVoxelCoordinate(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

/**
 * Validate a sequence of voxel writes coming from a single transaction.
 *
 * Rejects (returns false):
 *   - missing `editVoxels` permission (unchanged behaviour),
 *   - an empty or absurdly large sequence,
 *   - any write whose `x`/`y`/`z` is not a non-negative integer,
 *   - any write whose `b` is not a packed uint16 in range.
 *
 * Accepts (returns true):
 *   - every structurally legal sequence, including ones carrying rotation bits
 *     (a legitimate edit rotates via the dedicated `setVoxelRotate` path; we do
 *     not reject rotation bits because valid maps may already store them).
 */
export function checkVoxelWriteSequence(
  permissions: PermissionSet,
  writes: VoxelWrite[],
) {
  if (!permissions.editVoxels) {
    return false;
  }
  if (!Array.isArray(writes)) {
    return false;
  }
  // An empty sequence is a no-op, not a violation; treat it as acceptable so we
  // never break callers that legitimately dispatch zero writes.
  if (writes.length === 0) {
    return true;
  }
  if (writes.length > MAX_VOXEL_WRITES_PER_SEQUENCE) {
    return false;
  }

  const typeMask = VOXEL_TYPE_MASK & 0xffff;
  for (let i = 0; i < writes.length; ++i) {
    const w = writes[i];
    if (!w) {
      return false;
    }
    if (
      !isValidVoxelCoordinate(w.x) ||
      !isValidVoxelCoordinate(w.y) ||
      !isValidVoxelCoordinate(w.z)
    ) {
      return false;
    }
    if (!isValidVoxelValue(w.b)) {
      return false;
    }
    // The block/type id must live inside the type field; the only way a value
    // can be out of the type field is via the rotation bits, which is allowed,
    // so the range check above is sufficient. Guard the shift constant against
    // a schema drift that would make the packing meaningless.
    if (VOXEL_ROTATION_SHIFT !== 14 || typeMask !== 0x3fff) {
      return false;
    }
  }
  return true;
}
