import createTree from 'functional-red-black-tree';
import { equals } from 'ramda';
import { allocEmptyVoxels } from '@box/utils/helper';
import {
  compareBox,
  VoxelCollisionBox,
  VoxelCollisionBoxListSchema,
  VoxelCollisionBoxSchema,
} from '../../utils/rbush/schema';
import { VoxelView } from '@box/utils/voxel';
import { blitBoxesToChunk } from '../voxel/box-decode';
import { CommonHistory } from './interface';

export interface VoxelSaveData {
  /**
   * 目标voxelView
   */
  destVoxel: VoxelView;
  /**
   * 选中的voxelView
   * 就是有网格会膨胀的那个
   */
  selectVoxel: VoxelView;
}

type VoxelCallback = (data: VoxelSaveData) => void;

type RedBlackTree = createTree.Tree<VoxelCollisionBox, void>;

/*
 * this version of history database based on functional-red-black-tree
 * all destModelMesh data is hold in two stack
 * in each stack, we stores the rbTree,each rbTree node stores one collisionBox's data
 *
 * keep display data in stackPre's head
 */
class StackData {
  public destTree: RedBlackTree;
  public selectTree: RedBlackTree;
  public para: number[] = [];

  constructor(dTree: RedBlackTree, sTree: RedBlackTree, para: number[]) {
    this.destTree = dTree;
    this.selectTree = sTree;
    this.para = para;
  }
}

export class VoxelHistory implements CommonHistory<VoxelSaveData> {
  /**
   * 撤销记录，存储的是快照数据不是diff数据
   * pop出来的数据为当前状态
   * 撤销需要还原pop后的最后一个数据
   */
  private stackPrev: StackData[] = [];
  /**
   * 重做记录，存储的是快照数据不是diff数据
   */
  private stackNext: StackData[] = [];

  private voxelCallback?: VoxelCallback;

  public registerVoxelCallback = (cb: VoxelCallback) => {
    this.voxelCallback = cb;
  };

  public emptyHistory() {
    this.stackPrev = [];
    this.stackNext = [];
  }

  public undo() {
    const currData = this.stackPrev.pop();
    if (!currData) {
      return;
    }

    this.stackNext.push(currData);

    if (!this.stackPrev.length) {
      return;
    }

    const lastData = this.stackPrev[this.stackPrev.length - 1];

    const data = this.historyToVoxelData(lastData);

    this.voxelCallback && this.voxelCallback(data);
  }

  public redo() {
    const currData = this.stackNext.pop();
    if (!currData) {
      return;
    }

    this.stackPrev.push(currData);

    const data = this.historyToVoxelData(currData);

    this.voxelCallback && this.voxelCallback(data);
  }

  public saveHistory(data: VoxelSaveData): boolean {
    const { destVoxel, selectVoxel } = data;
    const boxesDestModel = this.encodeBoxes(destVoxel);
    const boxesSelectModel = this.encodeBoxes(selectVoxel);
    const para: number[] = [
      destVoxel.shape[0],
      destVoxel.shape[1],
      destVoxel.shape[2],
      destVoxel.offset,
    ];

    if (!this.stackPrev.length) {
      let destTree = createTree<VoxelCollisionBox, void>(compareBox);
      let selectTree = createTree<VoxelCollisionBox, void>(compareBox);
      for (let i = 0; i < boxesDestModel.length; ++i) {
        destTree = destTree.insert(boxesDestModel[i], undefined);
      }
      for (let i = 0; i < boxesSelectModel.length; ++i) {
        selectTree = selectTree.insert(boxesSelectModel[i], undefined);
      }
      this.stackPrev.push(new StackData(destTree, selectTree, para));
      return false;
    }

    const oldStack = this.stackPrev[this.stackPrev.length - 1];
    const oldDestTree = oldStack.destTree;
    const oldSelectTree = oldStack.selectTree;
    const oldPara = oldStack.para;

    const paraChanged = !equals(oldPara, para);

    let add: VoxelCollisionBox[] = [];
    let del: VoxelCollisionBox[] = [];
    let newDestTree = oldDestTree;

    //find diff between two boxes
    this.findDiff(add, del, oldDestTree, boxesDestModel);
    for (let i = 0; i < add.length; ++i) {
      newDestTree = newDestTree.insert(add[i], undefined);
    }
    for (let i = 0; i < del.length; ++i) {
      newDestTree = newDestTree.remove(del[i]);
    }

    const destChanged = add.length !== 0 || del.length !== 0;

    add = [];
    del = [];
    let newSelectTree = oldSelectTree;

    this.findDiff(add, del, oldSelectTree, boxesSelectModel);
    for (let i = 0; i < add.length; ++i) {
      newSelectTree = newSelectTree.insert(add[i], undefined);
    }
    for (let i = 0; i < del.length; ++i) {
      newSelectTree = newSelectTree.remove(del[i]);
    }

    const selectChanged = add.length !== 0 || del.length !== 0;

    if (!destChanged && !selectChanged && !paraChanged) {
      return false;
    }

    this.stackPrev.push(new StackData(newDestTree, newSelectTree, para));
    this.stackNext = [];

    return true;
  }

  private encodeBoxes(chunk: VoxelView): VoxelCollisionBox[] {
    const nx = chunk.shape[0];
    const ny = chunk.shape[1];
    const nz = chunk.shape[2];
    const VISITED = new Uint8Array(nx * ny * nz);

    const result = VoxelCollisionBoxListSchema.clone(
      VoxelCollisionBoxListSchema.identity,
    );
    const { data, offset, stride } = chunk;
    const stride0 = stride[0] | 0;
    const shape0 = nx;
    const astep0 = stride0 | 0;
    const vstep0 = 1;
    let i0 = 0;
    let j0 = 0;
    let k0 = 0;
    const stride1 = stride[1] | 0;
    const shape1 = ny;
    const astep1 = (stride1 - stride0 * shape0) | 0;
    const vstep1 = (vstep0 * shape0) | 0;
    let i1 = 0;
    let j1 = 0;
    let k1 = 0;
    let ustep1 = vstep1 | 0;
    let bstep1 = astep1 | 0;
    const stride2 = stride[2] | 0;
    const shape2 = nz;
    const astep2 = (stride2 - stride1 * shape1) | 0;
    const vstep2 = (vstep1 * shape1) | 0;
    let i2 = 0;
    let j2 = 0;
    let k2 = 0;
    let ustep2 = vstep2 | 0;
    let bstep2 = astep2 | 0;
    let a_ptr = offset >>> 0;
    let b_ptr = 0;
    let u_ptr = 0;
    let v_ptr = 0;
    let i = 0;
    let d = 0;
    let val = 0;
    let oval = 0;
    const count = shape0 * shape1 * shape2;
    for (; i < count; ++i) {
      VISITED[i] = 0;
    }
    for (i2 = 0; i2 < shape2; ++i2) {
      for (i1 = 0; i1 < shape1; ++i1) {
        for (i0 = 0; i0 < shape0; ++i0) {
          if (!VISITED[v_ptr]) {
            val = data[a_ptr];
            if (val !== 0) {
              oval = val;
              u_ptr = v_ptr + vstep0;
              b_ptr = a_ptr + stride0;
              j0_loop: for (j0 = 1 + i0; j0 < shape0; ++j0) {
                if (VISITED[u_ptr]) {
                  break j0_loop;
                }
                val = data[b_ptr];
                if (val !== oval) {
                  break j0_loop;
                }
                ++u_ptr;
                b_ptr += stride0;
              }
              d = j0 - i0;
              ustep1 = (vstep1 - vstep0 * d) | 0;
              bstep1 = (stride1 - stride0 * d) | 0;
              u_ptr = v_ptr + vstep1;
              b_ptr = a_ptr + stride1;
              j1_loop: for (j1 = 1 + i1; j1 < shape1; ++j1) {
                for (k0 = i0; k0 < j0; ++k0) {
                  if (VISITED[u_ptr]) {
                    break j1_loop;
                  }
                  val = data[b_ptr];
                  if (val !== oval) {
                    break j1_loop;
                  }
                  ++u_ptr;
                  b_ptr += stride0;
                }
                u_ptr += ustep1;
                b_ptr += bstep1;
              }
              d = j1 - i1;
              ustep2 = (vstep2 - vstep1 * d) | 0;
              bstep2 = (stride2 - stride1 * d) | 0;
              u_ptr = v_ptr + vstep2;
              b_ptr = a_ptr + stride2;
              j2_loop: for (j2 = 1 + i2; j2 < shape2; ++j2) {
                for (k1 = i1; k1 < j1; ++k1) {
                  for (k0 = i0; k0 < j0; ++k0) {
                    if (VISITED[u_ptr]) {
                      break j2_loop;
                    }
                    val = data[b_ptr];
                    if (val !== oval) {
                      break j2_loop;
                    }
                    ++u_ptr;
                    b_ptr += stride0;
                  }
                  u_ptr += ustep1;
                  b_ptr += bstep1;
                }
                u_ptr += ustep2;
                b_ptr += bstep2;
              }
              u_ptr = v_ptr;
              for (k2 = i2; k2 < j2; ++k2) {
                for (k1 = i1; k1 < j1; ++k1) {
                  for (k0 = i0; k0 < j0; ++k0) {
                    VISITED[u_ptr++] = 1;
                  }
                  u_ptr += ustep1;
                }
                u_ptr += ustep2;
              }
              const box = VoxelCollisionBoxSchema.alloc();
              box.minX = i0;
              box.minY = i1;
              box.minZ = i2;
              box.maxX = j0;
              box.maxY = j1;
              box.maxZ = j2;
              box.block = oval;
              box.faces = 0;
              result.push(box);
            }
          }
          ++v_ptr;
          a_ptr += astep0;
        }
        a_ptr += astep1;
      }
      a_ptr += astep2;
    }
    return result;
  }

  private findDiff(
    add: VoxelCollisionBox[],
    del: VoxelCollisionBox[],
    oldTree: RedBlackTree,
    newBoxes: VoxelCollisionBox[],
  ) {
    newBoxes.forEach(function (item) {
      if (oldTree.find(item).key == null) {
        add.push(item);
      }
    });

    const hashSet: { [hash: string]: boolean } = {};
    newBoxes.forEach(function (item) {
      hashSet[JSON.stringify(item)] = true;
    });

    oldTree.forEach(function (item) {
      if (!hashSet.hasOwnProperty(JSON.stringify(item))) {
        del.push(item);
      }
    });
  }

  private historyToVoxelData(data: StackData): VoxelSaveData {
    const boxesDestModel: VoxelCollisionBox[] = [];
    const boxesSelectModel: VoxelCollisionBox[] = [];
    data.destTree.forEach(function (item) {
      boxesDestModel.push(item);
    });
    data.selectTree.forEach(function (item) {
      boxesSelectModel.push(item);
    });

    const voxelDestModel: VoxelView = allocEmptyVoxels(
      data.para[0],
      data.para[1],
      data.para[2],
    );
    const voxelSelectModel: VoxelView = allocEmptyVoxels(
      data.para[0],
      data.para[1],
      data.para[2],
    );
    voxelDestModel.offset = data.para[3];
    voxelSelectModel.offset = data.para[3];
    blitBoxesToChunk(voxelDestModel, boxesDestModel);
    blitBoxesToChunk(voxelSelectModel, boxesSelectModel);

    return {
      destVoxel: voxelDestModel,
      selectVoxel: voxelSelectModel,
    };
  }
}
