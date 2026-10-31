import { vec3 } from 'gl-matrix';
import parseMagicaVoxel from '../models/parse-magica-voxel/src';
import { allocVoxels, VoxelView } from '@box/utils/voxel';
const URL_API =
  typeof window === 'undefined'
    ? null
    : (<any>window).URL || (<any>window).webkitURL || null;

function convertMagicaVoxel(buffer) {
  const data = parseMagicaVoxel(buffer);
  if (!data.PACK) {
    console.log(
      'WARNING, multiple chunks in file might cause error OR you are using 0.99^ MagicaVoxle which may not fully support',
    );
  }
  const shape = [data.SIZE[0].y, data.SIZE[0].z + 1, data.SIZE[0].x];

  const result = allocVoxels(shape[0], shape[1], shape[2]);
  for (let i = 0; i < result.data.length; i++) {
    result.data[i] = 0;
  }
  for (var k = 0; k < data.XYZI[0].length; ++k) {
    const { x, y, z, c } = data.XYZI[0][k];
    result.setVoxel(shape[0] - y - 1, z, shape[2] - x - 1, c | 0);
  }
  return [result, data.RGBA];
}

export function readFromMVox(
  file: File,
  callback: (params: { voxels: VoxelView; colors: unknown }) => void,
) {
  const reader = new FileReader();
  reader.onload = (e: any) => {
    try {
      const [voxels, all_color] = convertMagicaVoxel(e.target.result);
      if (callback) {
        callback({ voxels, colors: all_color });
      }
      return {
        voxels,
        colors: all_color,
      };
    } catch (error) {
      console.log('readFromMVox error', error);
      return void 0;
    }
  };
  reader.readAsArrayBuffer(file);
}

export function readFromVDFile(file, callback) {
  const reader = new FileReader();
  reader.onload = (e: any) => {
    const vdData = JSON.parse(e.target.result);
    if (callback) {
      callback(vdData);
    }
    return vdData;
  };
  reader.readAsText(file);
  return false;
}

export function loadVoxModel(voxData) {}

export function export_to_local_file(filename, data, type = 'text/plain') {
  if (!URL_API) {
    return;
  }
  let export_blob;
  export_blob = new Blob([data], { type });

  const save_link = document.createElementNS(
    'http://www.w3.org/1999/xhtml',
    'a',
  );
  save_link['href'] = URL_API.createObjectURL(export_blob);
  save_link['download'] = filename;
  function fake_click(obj) {
    const ev = document.createEvent('MouseEvents');
    ev.initMouseEvent(
      'click',
      true,
      false,
      window,
      0,
      0,
      0,
      0,
      0,
      false,
      false,
      false,
      false,
      0,
      null,
    );
    obj.dispatchEvent(ev);
  }
  fake_click(save_link);
}

export function screenShot(canvas, type?: string) {
  const sw = canvas.width;
  const sh = canvas.height;
  const short = Math.min(sw, sh);
  const sx = (sw - short) / 2;
  const sy = (sh - short) / 2;
  const thumbnail = canvasToImage(
    canvas,
    {
      sx,
      sy,
      sw: short,
      sh: short,
      dw: 250,
      dh: 250,
    },
    type,
  );
  return thumbnail;
}

let tempCanvas: HTMLCanvasElement;
let tempCtx: CanvasRenderingContext2D;
function canvasToImage(canvasEle, options, type: string = 'image/jpeg') {
  const opt = {
    sx: 0,
    sy: 0,
    sw: 0,
    sh: 0,
    dw: 0,
    dh: 0,
  };
  let sourceCanvas: HTMLCanvasElement;
  if (typeof canvasEle == 'string') {
    sourceCanvas = <HTMLCanvasElement>document.getElementById(canvasEle);
  } else {
    sourceCanvas = canvasEle;
  }
  if (tempCanvas == undefined) {
    tempCanvas = <HTMLCanvasElement>document.createElement('canvas');
  }
  if (typeof options === 'object') {
    opt.sw = options.sw || sourceCanvas.width;
    opt.sh = options.sh || sourceCanvas.height;
    opt.sx = options.sx || (sourceCanvas.width - opt.sw) / 2;
    opt.sy = options.sy || (sourceCanvas.height - opt.sh) / 2;
    opt.dw = options.dw || sourceCanvas.width;
    opt.dh = options.dh || sourceCanvas.height;
  }
  tempCanvas.width = opt.dw;
  tempCanvas.height = opt.dh;
  if (!tempCtx) {
    tempCtx = <CanvasRenderingContext2D>tempCanvas.getContext('2d');
  }
  tempCtx.drawImage(
    sourceCanvas,
    opt.sx,
    opt.sy,
    opt.sw,
    opt.sh,
    0,
    0,
    opt.dw,
    opt.dh,
  );
  return tempCanvas.toDataURL(type, 1);
}

export function getImageBuffer(canvas?: HTMLCanvasElement) {
  const _canvas = canvas ? canvas : tempCanvas;
  return new Promise<ArrayBuffer>((resolve, reject) => {
    if (!_canvas) {
      return reject(new Error(`getImageBuffer: canvas is not init`));
    }
    _canvas.toBlob(
      (blob) => {
        if (!blob) {
          return reject(new Error(`getImageBuffer: blob is null`));
        }
        const reader = new FileReader();
        reader.onload = (e) => {
          resolve((e.target as any).result);
        };
        reader.readAsArrayBuffer(blob);
      },
      'image/jpeg',
      0.7,
    );
  });
}

export function parseOBJ(
  file: File,
  callback: (params: {
    vertexPositions: vec3[];
    vertexNormals: vec3[];
    vertexUVs: number[][];
    facePositions: number[][];
    faceNormals: number[][];
    faceUVs: number[][];
  }) => void,
) {
  const reader = new FileReader();
  reader.onload = function ObjFileLoaded(e: any) {
    //
    const lines = e.target.result.split('\n');
    const v: vec3[] = [];
    const vn: vec3[] = [];
    const vt: number[][] = [];
    const f: number[][] = [];
    const fn: number[][] = [];
    const ft: number[][] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.length === 0 || line[0] === '#') {
        continue;
      }
      const toks = line.split(' ');
      for (let ptr = 0; ptr < toks.length; ptr++) {
        if (toks[ptr].trim() == '') {
          toks.splice(ptr, 1);
        }
      }
      switch (toks[0]) {
        case 'v':
          if (toks.length < 3) {
            throw new Error('parse-obj: Invalid vertex :' + line);
          }
          v.push([Number(toks[1]), Number(toks[2]), Number(toks[3])]);
          break;

        case 'vn':
          if (toks.length < 3) {
            throw new Error('parse-obj: Invalid vertex normal:' + line);
          }
          vn.push([Number(toks[1]), Number(toks[2]), Number(toks[3])]);
          break;

        case 'f':
          const position = new Array(3);
          const normal = new Array(3);
          const texCoord = new Array(3);
          if (toks.length == 4) {
            for (let j = 1; j < 4; ++j) {
              const indices = toks[j].split('/');
              position[j - 1] = (indices[0] | 0) - 1;
              texCoord[j - 1] = indices[1] ? (indices[1] | 0) - 1 : -1;
              normal[j - 1] = indices[2] ? (indices[2] | 0) - 1 : -1;
            }
            f.push(position);
            fn.push(normal);
            ft.push(texCoord);
            break;
          } else if (toks.length == 5) {
            for (let j = 1; j < 4; ++j) {
              const indices = toks[j].split('/');
              position[j - 1] = (indices[0] | 0) - 1;
              texCoord[j - 1] = indices[1] ? (indices[1] | 0) - 1 : -1;
              normal[j - 1] = indices[2] ? (indices[2] | 0) - 1 : -1;
            }
            const face_2_idx = [3, 4, 1];
            const position_2 = new Array(3);
            const normal_2 = new Array(3);
            const texCoord_2 = new Array(3);
            for (let j = 0; j < 3; j++) {
              const indices = toks[face_2_idx[j]].split('/');
              position_2[j] = (indices[0] | 0) - 1;
              texCoord_2[j] = indices[1] ? (indices[1] | 0) - 1 : -1;
              normal_2[j] = indices[2] ? (indices[2] | 0) - 1 : -1;
            }

            f.push(position);
            fn.push(normal);
            ft.push(texCoord);
            f.push(position_2);
            fn.push(normal_2);
            ft.push(texCoord_2);
          }

        case 'vp':
        case 'vt':
        case 's':
        case 'o':
        case 'g':
        case 'usemtl':
        case 'mtllib':
          break;

        default:
          console.log('unexpect entry :', toks[0]);
      }
    }

    callback({
      vertexPositions: v,
      vertexNormals: vn,
      vertexUVs: vt,
      facePositions: f,
      faceNormals: fn,
      faceUVs: ft,
    });
  };
  reader.readAsText(file);
}
