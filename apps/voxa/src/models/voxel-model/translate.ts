import { vec3, vec4 } from 'gl-matrix';
import { absMod, traverseVoxels } from '@box/utils/helper';
import type { VoxelView } from '@box/utils/voxel';

export function translateVoxels(model: VoxelView, value: vec3) {
  if (vec3.equals(value, [0, 0, 0])) {
    return;
  }

  const [dx, dy, dz] = model.getDimension();
  const [sx, sy, sz] = model.shape;
  let _x: number | undefined;
  let _y: number | undefined;
  let _z: number | undefined;
  let prevX: number | undefined;
  let prevY: number | undefined;
  let prevZ: number | undefined;

  const voxels: vec4[] = [];

  traverseVoxels(model, [0, 0, 0], [dx, dy, dz], (i, j, k, d) => {
    if (d != 0) {
      voxels.push([i, j, k, d]);
      model.setVoxel(i, j, k, 0);
    }
  });

  for (let i = 0, vNum = voxels.length; i < vNum; i++) {
    // 计算每个体素位移后的坐标
    const [x, y, z, d] = voxels[i];

    if (prevX !== x) {
      _x = absMod(x + value[0], sx);
      prevX = x;
    }

    if (prevY !== y) {
      _y = absMod(y + value[1], sy);
      prevY = y;
    }

    if (prevZ !== z) {
      _z = absMod(z + value[2], sz);
      prevZ = z;
    }

    if (_x == undefined || _y == undefined || _z == undefined) {
      throw new Error('invalid voxel position');
    }

    // 将位移后的体素设置到模型中
    model.setVoxel(_x, _y, _z, d);
  }
}
