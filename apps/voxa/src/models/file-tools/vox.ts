import { mat3, quat, vec3 } from 'gl-matrix';
import type { IntlShape } from 'react-intl';
import { nanoid } from 'nanoid';
import { Modal } from '@box/box-design';
import { NodeSchema, Vec3Schema, Vec4Schema } from '../project/defs';
import { store } from '../../redux/store';
import { ValidPaletteItem, setSelectedId } from '../../redux/palette-slice';
import { RGBToHsv } from '../../utils/color';
import type { VoxelApp } from '../voxel-app';
import type { EditingHistory } from '../editing-history';
import type { Stage } from '../stage';
import type { Palette } from '../palette';
import { bakeMesh } from '../voxel-model/bake';
import { loadRawMesh } from '../voxel-model/util';
import { AnimatorMode, ProjectNodeType } from '../../redux/animator-slice';
import type { AnimatorApp } from '../animator-app';
import {
  DEFAULT_FLIP,
  DEFAULT_FLIP_KEY,
  VoxelModelProp,
} from '../voxel-app/voxel-manager';
import { SerializedVec3, serializeQuat, serializeVec3 } from '../../utils/math';
import {
  incrementalNaming,
  PALETTE_GROUP_NAME,
  SKIN_PART_GROUP_NAME,
  SKIN_PART_NAME,
} from '../../utils/naming';
import { Box3 } from '../rendering/math/box3';
import { AppMode } from '../../redux/app-slice';
import type { SwitchToAnimator } from '../interfaces';
import type { ProjectNode } from '../project/interfaces';
import { VoxParser } from '../../common/vox-parser';
import {
  VoxelInfo,
  Size,
  VoxelPoint,
  GroupNode,
  ShapeNode,
  TransformNode,
  VoxFile,
  GetColorIdx,
} from '../../common/vox-parser/interfaces';
import type { IResult } from '../result/interfaces';
import { ROOT_SKIN_ID } from '../../defs';
import {
  IDENTITY_SCALE,
  IDENTITY_SCALE_MAT3,
} from '../rendering/controls/transform/def';
import { VoxelDimension } from '../project/defs';

export interface VoxLoaderParams {
  voxelApp: VoxelApp;
  animatorApp: AnimatorApp;
  stage: Stage;
  history: EditingHistory;
  palette: Palette;
  getIntl: () => IntlShape | undefined;
  switchToAnimator: SwitchToAnimator;
}

type VoxColorGroupParams = Pick<VoxFile, 'RGBA' | 'MATL'>;

// 加载多部件时，需要旋转90°
const ROTATE_X_90 = quat.create();
quat.rotateX(ROTATE_X_90, ROTATE_X_90, -Math.PI / 2);

const TEMP_QUAT = quat.create();
const TEMP_VEC3 = vec3.create();

const TEMP_MAT3 = mat3.create();

export class VoxTool {
  private voxParser = new VoxParser();

  private voxelApp: VoxelApp;
  private animatorApp: AnimatorApp;
  private history: EditingHistory;
  private stage: Stage;
  private palette: Palette;
  private getIntl: () => IntlShape | undefined;
  private switchToAnimator: SwitchToAnimator;

  /**
   * 导入时，用于统计本次加载的体素使用到的颜色id，清理无用色时使用。
   */
  private usedTextureIds: Set<number> = new Set();

  constructor(params: VoxLoaderParams) {
    const {
      voxelApp,
      history,
      stage,
      palette,
      animatorApp,
      getIntl,
      switchToAnimator,
    } = params;

    this.voxelApp = voxelApp;
    this.animatorApp = animatorApp;
    this.history = history;
    this.stage = stage;
    this.palette = palette;
    this.getIntl = getIntl;
    this.switchToAnimator = switchToAnimator;
  }

  private transformColorIdx(textureIds: number[]): GetColorIdx {
    return (oldColorIdx: number) => {
      const newColorIdx = textureIds[oldColorIdx];
      this.usedTextureIds.add(newColorIdx);
      return newColorIdx;
    };
  }

  private async confirmClearUnusedColors(groupId: string) {
    const intl = this.getIntl();
    if (!intl) {
      console.error('Error: intl is undefined');
      return;
    }
    return new Promise<void>((resolve) => {
      const destroy = Modal.show({
        type: 'warning',
        title: intl.formatMessage({
          description: 'Title of clearing unused colors when import',
          defaultMessage: 'Clear unused colors',
        }),
        content: intl.formatMessage({
          description: 'Content of clearing unused colors when import',
          defaultMessage: 'Confirm to clear all unused colors in the group?',
        }),
        confirmText: intl.formatMessage({
          description: 'Confirm clearing unused colors when import',
          defaultMessage: 'Clear',
        }),
        cancelText: intl.formatMessage({
          description: 'Confirm clearing unused colors when import',
          defaultMessage: 'Keep',
        }),
        buttonSort: 'rtl',
        onConfirm: () => {
          const [firstId] = store.getState().palette.groups[groupId].itemIds;

          store.dispatch(setSelectedId(firstId));

          this.palette.removeUnusedItems({
            usedIds: this.usedTextureIds,
            groupId,
          });

          destroy();
          resolve();
        },
        onCancel: () => {
          destroy();
          resolve();
        },
      });
    });
  }

  public async loadMultipleParts(
    file: File,
  ): Promise<IResult<undefined, { msg: string }>> {
    const voxFile = await this.voxParser.parseMagicaVoxel(file);
    if (!voxFile) {
      return {
        isSuccess: false,
        body: {
          msg: 'Failed to parse voxFile',
        },
      };
    }

    this.animatorApp.setMode(AnimatorMode.Setup);

    this.history.setStateRecordingEnabled(false);

    const { itemIds, groupId: newColorGroupId } = this.addVoxPalette(voxFile);

    if (itemIds.length === 0) {
      this.history.setStateRecordingEnabled(true);
      return {
        isSuccess: false,
        body: {
          msg: 'Failed to import palette',
        },
      };
    }

    const { nTRN, nGRP, nSHP, XYZI, SIZE } = voxFile;

    let groupId: string | undefined;

    if (nTRN && nGRP && nSHP) {
      groupId = this.loadByMultipleParts({
        nTRN,
        nGRP,
        nSHP,
        XYZI,
        SIZE,
        textureIds: itemIds,
      });
    } else {
      groupId = this.loadBySinglePart({
        XYZI,
        SIZE,
        textureIds: itemIds,
      });
    }

    groupId && this.alignGroupPosAndSelect(groupId);

    await this.confirmClearUnusedColors(newColorGroupId);

    this.usedTextureIds.clear();

    this.history.setStateRecordingEnabled(true);

    if (store.getState().app.mode === AppMode.Voxel) {
      this.switchToAnimator();
    }

    groupId && this.animatorApp.nodeManager.setActiveIds([groupId], true);

    return { isSuccess: true };
  }

  /**
   * 以多部件的方式加载多部件vox文件
   */
  private loadByMultipleParts(params: {
    textureIds: number[];
    nTRN: TransformNode[];
    nGRP: GroupNode[];
    nSHP: ShapeNode[];
    XYZI: VoxelPoint[][];
    SIZE: Size[];
  }) {
    const { textureIds, nGRP, nTRN, nSHP, XYZI, SIZE } = params;
    const nodeList: ProjectNode[] = [];

    const duplicatedNameList: { name: string }[] = Object.values(
      store.getState().animator.hierarchyData,
    );

    const firstGroupId = this.voxParser.parseVoxParts({
      nTRN,
      nGRP,
      nSHP,
      XYZI,
      SIZE,
      getColorIdx: this.transformColorIdx(textureIds),
      floorShape: true,
      onParseSingleVox: (params) => {
        const { nodeId, name, parentId, position, rotation, voxelInfo } =
          params;

        const defaultName = voxelInfo ? SKIN_PART_NAME : SKIN_PART_GROUP_NAME;

        const projectName = incrementalNaming(
          name || defaultName,
          duplicatedNameList,
          (val, newName) => val.name !== newName,
        );

        duplicatedNameList.push({ name: projectName });

        if (voxelInfo) {
          this.loadSkinPart({
            out: nodeList,
            id: nodeId,
            parentId: parentId || ROOT_SKIN_ID,
            name: projectName,
            position,
            voxelInfo,
          });
        } else {
          this.loadGroup({
            out: nodeList,
            id: nodeId,
            name: projectName,
            parentId: parentId || ROOT_SKIN_ID,
            position,
            rotation,
          });
        }
      },
    });

    this.animatorApp.loader.addNewNodesData(nodeList, false);

    return firstGroupId;
  }

  public async loadFirstPart(file: File) {
    const voxFile = await this.voxParser.parseMagicaVoxel(file);
    if (!voxFile) {
      return false;
    }

    this.history.setGroup();

    const { itemIds, groupId } = this.addVoxPalette(voxFile);

    if (itemIds.length === 0) {
      console.error('Failed to import palette');

      this.history.unsetGroup();
      return false;
    }

    this.loadFirstVoxel({ voxFile, textureIds: itemIds });

    await this.confirmClearUnusedColors(groupId);

    this.usedTextureIds.clear();

    this.voxelApp.saveHistory();

    this.stage.resetCamera();

    this.history.unsetGroup();

    return true;
  }

  /**
   * 取首个部件，转换成voxelView，加载到当前体素编辑中。
   * 拖拽.vox文件到页面时会使用。
   */
  private loadFirstVoxel(options: { voxFile: VoxFile; textureIds: number[] }) {
    const { voxFile, textureIds } = options;

    const { nTRN, nSHP, XYZI, SIZE } = voxFile;

    const points = XYZI[0];
    const size = SIZE[0];

    if (!points || !size) {
      return false;
    }

    let rotation: mat3 | undefined;

    if (nSHP && nTRN) {
      const shapeNode = nSHP.find((node) => node.models[0].id === 0);

      const transformNode =
        shapeNode && this.voxParser.findChildById(nTRN, shapeNode.id);

      const transform =
        transformNode &&
        this.voxParser.getTransformByFrame(transformNode.frames[0]);

      rotation = transform?.rotation;
    }

    if (!rotation) {
      rotation = mat3.identity(TEMP_MAT3);
    }

    const result = this.voxParser.parseVoxels({
      points,
      size,
      rotation,
      getColorIdx: this.transformColorIdx(textureIds),
    });

    if (result) {
      this.voxelApp.applyVoxels([result.voxels]);
    }
  }

  /**
   * 以多部件的方式加载单部件vox文件
   */
  private loadBySinglePart(params: {
    XYZI: VoxelPoint[][];
    SIZE: Size[];
    textureIds: number[];
  }) {
    const { XYZI, SIZE, textureIds } = params;

    const nodeList: ProjectNode[] = [];

    const groupId = nanoid();

    const duplicatedNameList: { name: string }[] = Object.values(
      store.getState().animator.hierarchyData,
    );

    const groupName = incrementalNaming(
      SKIN_PART_GROUP_NAME,
      duplicatedNameList,
      (val, newName) => val.name !== newName,
    );

    duplicatedNameList.push({ name: groupName });

    vec3.zero(TEMP_VEC3);
    mat3.identity(TEMP_MAT3);

    this.loadGroup({
      out: nodeList,
      id: groupId,
      name: groupName,
      parentId: ROOT_SKIN_ID,
      position: TEMP_VEC3,
      rotation: TEMP_MAT3,
    });

    const skinPartName = incrementalNaming(
      SKIN_PART_NAME,
      duplicatedNameList,
      (val, newName) => val.name !== newName,
    );

    const voxelInfo = this.voxParser.parseVoxels({
      points: XYZI[0],
      size: SIZE[0],
      rotation: TEMP_MAT3,
      getColorIdx: this.transformColorIdx(textureIds),
    });

    if (!voxelInfo) {
      return;
    }

    this.loadSkinPart({
      out: nodeList,
      id: nanoid(),
      name: skinPartName,
      parentId: groupId,
      position: TEMP_VEC3,
      voxelInfo,
    });

    this.animatorApp.loader.addNewNodesData(nodeList, false);

    return groupId;
  }

  private loadGroup(params: {
    out: ProjectNode[];
    id: string;
    parentId: string;
    position: vec3;
    rotation: mat3;
    name: string;
  }) {
    const { id, name, parentId, position, rotation, out } = params;

    const groupNode = NodeSchema.clone(NodeSchema.identity);

    groupNode.id = id;
    groupNode.type = ProjectNodeType.Group;
    groupNode.name = name;
    groupNode.parentId = parentId;

    groupNode.position = Vec3Schema.fromJSON(serializeVec3(position));
    groupNode.quaternion = Vec4Schema.fromJSON(
      serializeQuat(quat.fromMat3(TEMP_QUAT, rotation)),
    );
    vec3.copy(groupNode.scale, IDENTITY_SCALE);
    mat3.copy(groupNode.parentScaleMat3, IDENTITY_SCALE_MAT3);

    out.push(groupNode);
  }

  private loadSkinPart(params: {
    out: ProjectNode[];
    id: string;
    parentId: string;
    name: string;
    position: vec3;
    voxelInfo: VoxelInfo;
  }) {
    const { out, id, parentId, name, position, voxelInfo } = params;

    const loadResult = this.loadVoxels(voxelInfo);

    let shape: vec3 = [0, 0, 0];
    let originBoundaryStart: vec3 = [0, 0, 0];
    let originPivot: vec3 = [0, 0, 0];
    let voxelId: string | undefined;

    if (loadResult) {
      vec3.copy(shape, loadResult.voxelModelProp.voxelView.shape);
      originBoundaryStart = loadResult.originBoundaryStart;
      originPivot = loadResult.originPivot;
      voxelId = loadResult.voxelModelProp.id;
    }

    const partNode = NodeSchema.clone(NodeSchema.identity);

    partNode.id = id;
    partNode.type = ProjectNodeType.SkinPart;
    partNode.name = name;
    partNode.voxelId = voxelId || '';
    partNode.parentId = parentId;

    vec3.transformQuat(position, position, ROTATE_X_90);

    vec3.set(TEMP_VEC3, 0, 0, 0);
    vec3.scale(TEMP_VEC3, shape, -0.5);
    partNode.pivot = Vec3Schema.fromJSON(serializeVec3(TEMP_VEC3));

    // 计算裁剪导致的位置变差，这部分不需要旋转
    const trimOffset = originBoundaryStart;

    vec3.sub(trimOffset, trimOffset, TEMP_VEC3);
    vec3.add(trimOffset, trimOffset, originPivot);

    vec3.add(position, position, trimOffset);

    partNode.position = Vec3Schema.fromJSON(serializeVec3(position));

    // 旋转信息被应用于体素，部件本身不会有旋转。
    partNode.quaternion = Vec4Schema.fromJSON([0, 0, 0, 1]);

    vec3.copy(partNode.scale, IDENTITY_SCALE);
    mat3.copy(partNode.parentScaleMat3, IDENTITY_SCALE_MAT3);

    out.push(partNode);
  }

  /**
   * 把vox的体素资源转换成voxelView，并存储到voxelManager中。
   * @returns 转换成功时，返回相关体素数据。失败时返回undefined。
   */
  private loadVoxels(voxelInfo: VoxelInfo):
    | {
        voxelModelProp: VoxelModelProp;
        originBoundaryStart: vec3;
        originPivot: vec3;
      }
    | undefined {
    const {
      voxels,
      originShape,
      boundaryStart: originBoundaryStart,
    } = voxelInfo;

    const originPivot = vec3.create();

    vec3.scale(originPivot, originShape, -0.5);

    const bakeResult = bakeMesh(voxels);

    const id = nanoid();

    let rawMeshBuffer: Uint16Array;
    let colorIndex: Uint16Array;
    let bounds: SerializedVec3;
    let boundaryStart: SerializedVec3;

    if (bakeResult.mesh) {
      const loadResult = loadRawMesh(bakeResult.mesh);

      rawMeshBuffer = loadResult.mesh;
      colorIndex = loadResult.colorIndex;
      bounds = loadResult.bounds;
      boundaryStart = loadResult.lo;
    } else {
      rawMeshBuffer = new Uint16Array();
      colorIndex = new Uint16Array();
      bounds = [0, 0, 0];
      boundaryStart = [0, 0, 0];
    }

    const flip: SerializedVec3 = [...DEFAULT_FLIP];

    const voxelModelProp: VoxelModelProp = {
      id,
      voxelView: voxels,
      dimension: VoxelDimension.XYZ,
      meshes: {
        [DEFAULT_FLIP_KEY]: {
          bounds,
          boundaryStart,
          colorIndex,
          rawMeshBuffer,
          flip,
        },
      },
    };

    this.voxelApp.voxelManager.map.set(id, voxelModelProp);

    return {
      voxelModelProp,
      originBoundaryStart,
      originPivot,
    };
  }
  /**
   * 新建分组添加.vox文件中的色表。
   * @return 返回与原本颜色id对应的新的颜色id，顺序与原本顺序一致。返回新建的颜色分组id。
   */
  private addVoxPalette(params: VoxColorGroupParams): {
    itemIds: number[];
    groupId: string;
  } {
    const { RGBA } = params;

    const items: ValidPaletteItem[] = [];

    RGBA.forEach((rgb) => {
      // RGBA[1]为null，因为体素点从1开始记。
      if (!rgb) {
        return;
      }

      const { r, g, b } = rgb;

      // TODO 根据MATL数组的对应数据来设置emissive
      const material = { emissive: 0 };

      const hsv = RGBToHsv(r, g, b);

      items.push({
        rgb: [r, g, b],
        material,
        hsv,
      });
    });

    const groupId = nanoid();

    const name = incrementalNaming(
      PALETTE_GROUP_NAME,
      Object.values(store.getState().palette.groups),
      (val, newName) => val.name !== newName,
    );

    const itemIds = this.palette
      .addGroup({
        id: groupId,
        name,
        items,
      })
      .slice();

    // 由于RGBA的首位是作为占位的，所以在这里也塞入一个作为占位，不干扰后续计算体素点的textureId。
    itemIds.unshift(1);

    return { itemIds, groupId };
  }

  /**
   * 把导入的整个组移动到底部中心与世界坐标原点对齐的位置。
   * 并选中该组。
   */
  private alignGroupPosAndSelect(groupId: string) {
    const group = this.animatorApp.nodeManager.getSkinNode(groupId);

    if (!group) {
      return;
    }

    const box = new Box3();
    const bounds = box.expandByObject(group);

    if (bounds.isEmpty()) {
      return;
    }

    const pos = vec3.create();

    vec3.sub(pos, bounds.max, bounds.min);

    vec3.scale(pos, pos, -0.5);

    vec3.sub(pos, pos, bounds.min);

    pos[1] = -bounds.min[1];

    vec3.copy(group.position, pos);
  }
}
