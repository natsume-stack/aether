import { vec3 } from 'gl-matrix';
import { modelV5, modelSchemaToBytes, migrateModel } from '@box/voxa-project';
import type { Regl } from '@box/regl';
import type { Core } from '../../../common/core';
import { Loader } from '../../../common/loader';
import { Object3D } from '../../..//models/rendering/objects/object3d';

/**
 * 地形资源的bounds数据
 * 跟随background.json改变
 */
const BOUNDS: [number, number, number] = [
  342.2261047363281, 125.78600692749023, 230.96658325195312,
];

/**
 * game中的配置，模型和地形比是16:1
 * 人物骨骼为game中的比例
 * 因此背景也需要缩放为game中的比例
 */
const MODEL_TO_VOXEL = 16;
const DEFAULT_SCALE = 1 / MODEL_TO_VOXEL;

export class Background {
  private loader: Loader;
  private background = new Object3D();

  constructor(regl: Regl, core: Core) {
    this.loader = new Loader({ regl });
    core.scene.add(this.background);
  }

  public async init() {
    const background = await import('./background.json');
    const schemaV5 = modelV5.ModelDataV5Schema.fromJSON(background.default);
    const bytes = modelSchemaToBytes(schemaV5);
    const latestSchema = await migrateModel(bytes);
    if (!latestSchema) {
      return;
    }

    const glTexture = this.loader.loadTexture(latestSchema.texture);
    this.loader.loadNodes({
      nodes: latestSchema.nodes,
      meshes: latestSchema.meshes,
      glTexture: glTexture,
      parent: this.background,
    });

    // 背景xz轴居中
    // y轴居中偏下，让绘制的地面位置贴到（0,0,0）点上
    this.background.setPosition(
      BOUNDS[0] * DEFAULT_SCALE * -0.5,
      BOUNDS[1] * DEFAULT_SCALE * -0.82,
      BOUNDS[2] * DEFAULT_SCALE * -0.5,
    );

    vec3.set(
      this.background.scale,
      DEFAULT_SCALE,
      DEFAULT_SCALE,
      DEFAULT_SCALE,
    );
  }

  public getVisible() {
    return this.background.visible;
  }

  public setVisible(visible: boolean) {
    this.background.visible = visible;
  }
}
