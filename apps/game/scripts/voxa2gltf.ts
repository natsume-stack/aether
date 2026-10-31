import { Mesher } from '@box/mesher';
import { exportToGLTF } from '@box/mesher/gltf';
import { MuReadStream } from '@box/mudb/stream';
import { MeshSchema } from '@box/schema/mesh/voxel';
import { allocEmptyVoxels } from '@box/utils/helper';
import { decompress } from '@box/utils/rle-compress';
import { VoxelView } from '@box/utils/voxel';
import fs from 'fs';
import path from 'path';

const voxa = JSON.parse(fs.readFileSync(process.argv[2]).toString());

let palette: number[] = [];
let emissivePalette: number[] = [];

const mesher = new Mesher(true, true, false);
function checkPalette(dst: number[], src: number[]) {
  dst.length = Math.max(dst.length, src.length);
  for (let i = 0; i < src.length; i++) {
    if (!dst[i]) {
      dst[i] = src[i];
    }
  }
}

for (const mesh of voxa.meshes) {
  const m = unpackCompactModel(mesh);
  checkPalette(palette, m.palette);
  checkPalette(emissivePalette, m.emissivePalette);
  mesher.addModel(m.voxel);
}

(async () => {
  const filename = process.argv[3];
  const basename = path.basename(filename);
  const name = basename.replace(/\.[^\.]+$/, '');

  fs.writeFileSync(
    filename,
    await exportToGLTF(name, mesher, palette, emissivePalette, voxa.nodes),
  );
  console.log('writing to ' + filename);
  console.log('DONE!');
})();

function unpackCompactModel(mesh: any) {
  const model: typeof MeshSchema.identity = MeshSchema.fromJSON(mesh);
  const palette = Array(256).fill(0);
  const emissivePalette = Array(256).fill(0);
  for (const key in model.material) {
    const { rgb, pbr } = model.material[key];
    palette[key] = (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];
    emissivePalette[key] = pbr[2];
  }

  let quad_ptr = 0;
  let slice_ptr = 0;
  const begin = [0, 0, 0];
  const end = [0, 0, 0];
  const rects: number[] = [];
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
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
        rects.push(...begin, ...end, idx);
        minX = Math.min(minX, begin[0]);
        minY = Math.min(minY, begin[1]);
        minZ = Math.min(minZ, begin[2]);
        maxX = Math.max(maxX, end[0]);
        maxY = Math.max(maxY, end[1]);
        maxZ = Math.max(maxZ, end[2]);
      }
    }
  }

  const shape: [number, number, number] = [maxX + 1, maxY + 1, maxZ + 1];
  const [nx, ny, nz] = shape;
  const stride: [number, number, number] = [1, nx, nx * ny];
  const voxel = new Uint16Array(nx * ny * nz);
  for (let i = 0; i < rects.length; i += 7) {
    for (let x = rects[i + 0]; x <= rects[i + 3]; x++) {
      for (let y = rects[i + 1]; y <= rects[i + 4]; y++) {
        for (let zz = rects[i + 2]; zz <= rects[i + 5]; zz++) {
          const ptr = x * stride[0] + y * stride[1] + zz * stride[2];
          voxel[ptr] = rects[i + 6];
        }
      }
    }
  }
  return {
    voxel: new VoxelView(voxel, shape, stride, 0),
    palette,
    emissivePalette,
  };
}
