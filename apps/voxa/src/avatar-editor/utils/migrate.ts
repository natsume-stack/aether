import { bytesToCompactModel } from '@box/vb';
import type { mat4, vec3 } from 'gl-matrix';
import { voxelsToMeshes } from '@box/mesher';
import { VoxelView } from '@box/utils/voxel';
import { BodyPartName } from '../../avatar/models/defs';

type BodyPartId = keyof typeof BodyPartName;

interface Skin {
  id: BodyPartId;
  lo: vec3;
  hi: vec3;
  bind: mat4;
  mesh: number[];
}

export async function migrateJSON(skin: Skin) {
  const model = bytesToCompactModel(new Uint8Array(skin.mesh));
  if (!model) {
    return;
  }

  const palette = Array(256).fill(0);
  const emissivePalette = Array(256).fill(0);
  for (const key in model.material) {
    const { rgb, pbr } = model.material[key];
    palette[key] = (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];
    emissivePalette[key] = pbr[2];
  }

  const shape = skin.hi as [number, number, number];
  const [nx, ny, nz] = shape;
  const stride: [number, number, number] = [1, nx, nx * ny];
  const voxel = new Uint16Array(nx * ny * nz);

  let quad_ptr = 0;
  let slice_ptr = 0;
  const begin = [0, 0, 0];
  const end = [0, 0, 0];

  while (slice_ptr < model.sliceInfo.length) {
    const normal_code = model.sliceInfo[slice_ptr++];
    const normal_code_count = model.sliceInfo[slice_ptr++];
    for (let j = 0; j < normal_code_count; j++) {
      const z = model.sliceInfo[slice_ptr++];
      const z_count = model.sliceInfo[slice_ptr++];
      for (let k = 0; k < z_count; k++, quad_ptr++) {
        const x0 = model.data[quad_ptr * 6];
        const y0 = model.data[quad_ptr * 6 + 1];
        const x1 = model.data[quad_ptr * 6 + 2];
        const y1 = model.data[quad_ptr * 6 + 3];
        const idx = model.data[quad_ptr * 6 + 4];
        //const packedAO = model.data[quad_ptr * 6 + 5];
        let u;
        let v;
        let d;
        if (normal_code === 0 || normal_code === 1) {
          u = 2;
          v = 1;
          d = 0;
        } else if (normal_code === 2 || normal_code === 3) {
          u = 0;
          v = 2;
          d = 1;
        } else if (normal_code === 4 || normal_code === 5) {
          u = 1;
          v = 0;
          d = 2;
        }
        begin[u] = x0;
        begin[v] = y0;
        begin[d] = z - (normal_code & 1);
        end[u] = x1 - 1;
        end[v] = y1 - 1;
        end[d] = z - (normal_code & 1);
        for (let x = begin[0]; x <= end[0]; x++) {
          for (let y = begin[1]; y <= end[1]; y++) {
            for (let zz = begin[2]; zz <= end[2]; zz++) {
              const ptr = x * stride[0] + y * stride[1] + zz * stride[2];
              voxel[ptr] = idx;
            }
          }
        }
      }
    }
  }
  if (!voxel.length) {
    return;
  }
  const { meshes, texture } = await voxelsToMeshes(
    [new VoxelView(voxel, shape, stride, 0)],
    palette,
    emissivePalette,
  );
  return {
    mesh: meshes[0],
    texture,
    bind: skin.bind,
  };
}
