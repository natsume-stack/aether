import { Mesher } from '@box/mesher';
import { exportToGLTF } from '@box/mesher/gltf';
import { MuReadStream } from '@box/mudb/stream';
import { allocEmptyVoxels } from '@box/utils/helper';
import { decompress } from '@box/utils/rle-compress';
import fs from 'fs';
import path from 'path';

const projectData = JSON.parse(fs.readFileSync(process.argv[2]).toString());
const CURRENTCOLORINDEX = projectData.CURRENTCOLORINDEX;
const palette = projectData.HEXCOLORS[CURRENTCOLORINDEX].map((hex) =>
  hex ? parseInt(hex, 16) : 0xffffff,
);
const emissivePalette = projectData.PBRATTRBS[CURRENTCOLORINDEX].map(
  (a: number[]) => a[2],
);

const inp = new MuReadStream(new Uint8Array(projectData.ENCODEVOXELS));
const nx = inp.readInt32();
const ny = inp.readInt32();
const nz = inp.readInt32();

const voxel = allocEmptyVoxels(nx, ny, nz);
decompress(inp, voxel);

const mesher = new Mesher(true, true, false);
mesher.addModel(voxel);
(async () => {
  const filename = process.argv[3];
  const basename = path.basename(filename);
  const extName = path.extname(basename).toLowerCase();
  const name = basename.replace(/\.[^\.]+$/, '');
  const dir = path.dirname(filename);
  if (extName === '.obj') {
    const files = await mesher.exportToOBJ(name, palette, emissivePalette);
    for (const file in files) {
      fs.writeFileSync(path.join(dir, file), files[file]);
      console.log('writing to ' + file);
    }
  } else {
    fs.writeFileSync(
      filename,
      await exportToGLTF(name, mesher, palette, emissivePalette),
    );
    console.log('writing to ' + filename);
  }

  console.log('DONE!');
})();
