import {
  Uint16Vec3Schema,
  Uint8Vec3Schema,
  PaletteItemSchema,
  ProjectDataSchema,
  NodeSchema,
  ProjectNodeType,
} from './defs';

import {
  ROOT_ID,
  ROOT_BONE_ID,
  ROOT_SKIN_ID,
  DEFAULT_GROUP_ID,
} from '../../defs';

import { RGBToHsv } from '../../utils/color';
import type { SerializedVec3 } from '../../utils/math';
import {
  ProjectNodes,
  ProjectPaletteData,
  ProjectPaletteItems,
} from './interfaces';
import { ROOT_BONE_NAME, ROOT_NAME, ROOT_SKIN_NAME } from '../../utils/naming';

const RGB_LIST: SerializedVec3[] = [
  [255, 80, 80],
  [255, 175, 0],
  [255, 210, 54],
  [195, 235, 55],
  [35, 175, 65],
  [115, 225, 200],
  [130, 210, 240],
  [95, 167, 255],
  [65, 115, 245],
  [170, 100, 215],
  [255, 135, 245],
  [255, 180, 205],
  [175, 110, 40],
  [255, 237, 219],
  [215, 215, 215],
  [255, 255, 255],
];

// 生成默认色板数据
function generateDefaultPalette(rgbList: SerializedVec3[]): ProjectPaletteData {
  const itemIds: number[] = [];

  const items: ProjectPaletteItems = rgbList.map((rgb, idx) => {
    const id = idx + 1;

    const [r, g, b] = rgb;

    itemIds.push(id);

    const item = PaletteItemSchema.alloc();
    item.id = id;
    item.rgb = Uint8Vec3Schema.fromJSON(rgb);
    item.hsv = Uint16Vec3Schema.fromJSON(RGBToHsv(r, g, b));
    item.material.emissive = 0;

    return item;
  });

  const groups = {
    [DEFAULT_GROUP_ID]: {
      id: DEFAULT_GROUP_ID,
      name: 'Color',
      itemIds,
    },
  };

  const groupList = [DEFAULT_GROUP_ID];

  return {
    items,
    groups,
    groupList,
  };
}

function generateDefaultNodes(): ProjectNodes {
  const root = NodeSchema.clone(NodeSchema.identity);
  root.id = ROOT_ID;
  root.name = ROOT_NAME;
  root.type = ProjectNodeType.Root;
  root.childrenIds = [ROOT_BONE_ID, ROOT_SKIN_ID];

  const rootBone = NodeSchema.clone(NodeSchema.identity);
  rootBone.id = ROOT_BONE_ID;
  rootBone.name = ROOT_BONE_NAME;
  rootBone.type = ProjectNodeType.Bone;
  rootBone.parentId = ROOT_ID;
  rootBone.childrenIds = [];

  const rootSkin = NodeSchema.clone(NodeSchema.identity);
  rootSkin.id = ROOT_SKIN_ID;
  rootSkin.name = ROOT_SKIN_NAME;
  rootSkin.type = ProjectNodeType.Group;
  rootSkin.parentId = ROOT_ID;
  rootSkin.childrenIds = [];

  return {
    [root.id]: root,
    [rootBone.id]: rootBone,
    [rootSkin.id]: rootSkin,
  };
}

export const DEFAULT_PROJECT = ProjectDataSchema.alloc();
DEFAULT_PROJECT.nodes = generateDefaultNodes();
DEFAULT_PROJECT.voxels = {};
DEFAULT_PROJECT.palette = generateDefaultPalette(RGB_LIST);
