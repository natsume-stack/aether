import type { Regl } from '@box/regl';
import type { WebGLRenderer } from '../../rendering/webgl-renderer';
import type { SkinPart } from '../../skin-part';
import { mat4, quat, vec2, vec3 } from 'gl-matrix';
import { GetCamera } from '../../editing/interfaces';

import { YELLOW } from '../../rendering/controls/transform/def';
import { Box3 } from '../../rendering/math/box3';
import { Object3D } from '../../rendering/objects/object3d';
import { ShaderMaterial } from '../../rendering/materials/shader';
import { Mesh } from '../../rendering/objects/mesh';
import { Axis } from '../../rendering/def';
import {
  basicFragmentShader,
  basicVertexShader,
} from '../../rendering/shaders';
import { SphereGeometry } from '../../rendering/geometries/sphere-geometry';
import { PlaneGeometry } from '../../rendering/geometries/plane-geometry';
import {
  worldPosToClipPos,
  clipPosToScreenPos,
} from '../../../utils/coordinate';
import { SkinNode } from './interface';
import { isSkinPart } from '../util';
import { LineBox } from '../../line-box';

const WORLD_POS = vec3.create();
const TEMP_VEC3 = vec3.create();

interface Intersection {
  interaction: Interaction;
  distance: number;
}

export class PivotHelper {
  private helpers: Map<string, Helper> = new Map<string, Helper>();
  private intersections: Intersection[] = [];
  private sphereObject: SphereObject;
  private planeObject: PlaneObject;

  constructor(
    private getCamera: GetCamera,
    private renderer: WebGLRenderer,
    private parent: Object3D,
  ) {
    this.sphereObject = new SphereObject(this.renderer.regl, this.getCamera);
    this.planeObject = new PlaneObject(this.renderer.regl);
  }

  public attachBox(id: string, lineBox: LineBox) {
    const helper = this.helpers.get(id);

    if (helper) {
      return;
    }

    const newHelper = new Helper(this.getCamera, this.renderer, lineBox);

    this.helpers.set(id, newHelper);
  }

  public detach() {
    this.helpers.clear();
    this.clear();
  }

  private clear() {
    this.parent.remove(this.sphereObject);
    this.parent.remove(this.planeObject);
  }

  public intersectPoint(point: vec3) {
    this.clear();
    this.intersections.length = 0;

    for (const helper of this.helpers.values()) {
      helper.intersectPoint(this.intersections, point);
    }

    this.intersections.sort((a, b) => a.distance - b.distance);

    if (!this.intersections.length) {
      return;
    }
    const { worldPosition, planeData, worldQuaternion } =
      this.intersections[0].interaction;
    vec3.copy(this.sphereObject.position, worldPosition);
    this.parent.add(this.sphereObject);

    if (planeData) {
      this.updatePlaneObject(planeData, worldPosition, worldQuaternion);
      this.parent.add(this.planeObject);
    }
    return worldPosition;
  }

  private updatePlaneObject(
    planeData: PlaneData,
    worldPosition: vec3,
    worldQuaternion: quat,
  ) {
    const { width, height, axis } = planeData;
    this.planeObject.update(width, height);
    vec3.copy(this.planeObject.position, worldPosition);
    quat.copy(this.planeObject.quaternion, worldQuaternion);
    if (axis === Axis.X) {
      quat.rotateY(
        this.planeObject.quaternion,
        this.planeObject.quaternion,
        Math.PI / 2,
      );
      return;
    }

    if (axis === Axis.Y) {
      quat.rotateX(
        this.planeObject.quaternion,
        this.planeObject.quaternion,
        Math.PI / 2,
      );
    }
  }
}

export class SkinPivotHelper extends PivotHelper {
  constructor(
    getCamera: GetCamera,
    renderer: WebGLRenderer,
    parent: Object3D,
    private map: Map<string, SkinNode>,
  ) {
    super(getCamera, renderer, parent);
  }

  public attach(skinPartIds: string[]) {
    skinPartIds.forEach((id) => {
      const skinNode = this.map.get(id);

      if (!skinNode || !isSkinPart(skinNode)) {
        return;
      }

      this.attachBox(id, skinNode.skinPartBox);
    });
  }
}

class Helper {
  private interactions: Interaction[];

  constructor(
    private getCamera: GetCamera,
    private renderer: WebGLRenderer,
    private target: LineBox,
  ) {
    this.interactions = [];
    // 8个顶点 + 6个面中心点 + 一个质心 = 15个点
    for (let i = 0; i < 15; i++) {
      this.interactions.push(new Interaction(this.getCamera, this.renderer));
    }

    this.attach();
  }

  private attach() {
    if (!this.target.geometry) {
      return;
    }
    const box =
      this.target.geometry.boundingBox ||
      this.target.geometry.computeBoundingBox();
    this.setPosition(box);
  }

  private setPosition(box: Box3) {
    vec3.set(this.interactions[0].position, box.min[0], box.min[1], box.min[2]);
    vec3.set(this.interactions[1].position, box.min[0], box.min[1], box.max[2]);
    vec3.set(this.interactions[2].position, box.min[0], box.max[1], box.min[2]);
    vec3.set(this.interactions[3].position, box.min[0], box.max[1], box.max[2]);
    vec3.set(this.interactions[4].position, box.max[0], box.min[1], box.min[2]);
    vec3.set(this.interactions[5].position, box.max[0], box.min[1], box.max[2]);
    vec3.set(this.interactions[6].position, box.max[0], box.max[1], box.min[2]);
    vec3.set(this.interactions[7].position, box.max[0], box.max[1], box.max[2]);

    // 立方体的质心
    box.getCenter(this.interactions[8].position);

    const halfX = (box.min[0] + box.max[0]) / 2;
    const halfY = (box.min[1] + box.max[1]) / 2;
    const halfZ = (box.min[2] + box.max[2]) / 2;

    const xLen = Math.abs(box.max[0] - box.min[0]);
    const yLen = Math.abs(box.max[1] - box.min[1]);
    const zLen = Math.abs(box.max[2] - box.min[2]);

    // 立方体6个面的中心点
    vec3.set(this.interactions[9].position, box.min[0], halfY, halfZ);
    this.interactions[9].planeData = {
      width: zLen,
      height: yLen,
      axis: Axis.X,
    };

    vec3.set(this.interactions[10].position, box.max[0], halfY, halfZ);
    this.interactions[10].planeData = {
      width: zLen,
      height: yLen,
      axis: Axis.X,
    };

    vec3.set(this.interactions[11].position, halfX, box.min[1], halfZ);
    this.interactions[11].planeData = {
      width: xLen,
      height: zLen,
      axis: Axis.Y,
    };

    vec3.set(this.interactions[12].position, halfX, box.max[1], halfZ);
    this.interactions[12].planeData = {
      width: xLen,
      height: zLen,
      axis: Axis.Y,
    };

    vec3.set(this.interactions[13].position, halfX, halfY, box.min[2]);
    this.interactions[13].planeData = {
      width: xLen,
      height: yLen,
      axis: Axis.Z,
    };

    vec3.set(this.interactions[14].position, halfX, halfY, box.max[2]);
    this.interactions[14].planeData = {
      width: xLen,
      height: yLen,
      axis: Axis.Z,
    };
  }

  public intersectPoint(out: Intersection[], point: vec3) {
    this.interactions.forEach((interaction) => {
      mat4.copy(interaction.matrixWorld, this.target.matrixWorld);
      interaction.intersectPoint(out, point);
    });
  }
}

const POINT_2D = vec2.create();
const CENTER_2D = vec2.create();
const DETECT_LENGTH = 10;

function getShaderMaterial(color: vec3, alpha: number) {
  return new ShaderMaterial({
    vertexShader: basicVertexShader,
    fragmentShader: basicFragmentShader,
    uniforms: {
      color,
      alpha,
    },
    blend: {
      enable: true,
      func: {
        srcRGB: 'src alpha',
        srcAlpha: 1,
        dstRGB: 'one minus src alpha',
        dstAlpha: 1,
      },
      equation: {
        rgb: 'add',
        alpha: 'add',
      },
      color: [1, 1, 1, 1],
    },
    depth: {
      enable: false,
      mask: false,
      func: '<=',
    },
    transparent: true,
  });
}

interface PlaneData {
  width: number;
  height: number;
  axis: Axis;
}

class Interaction {
  /**
   * 交互组件与蒙皮组件的相对位置
   */
  public position = vec3.create();

  /**
   * 绑定的蒙皮组件世界坐标矩阵
   */
  public matrixWorld = mat4.create();

  /**
   * 交互组件的世界坐标位置
   */
  public worldPosition = vec3.create();

  /**
   * 交互组件的世界坐标旋转度
   */
  public worldQuaternion = quat.create();

  /**
   * 若交互组件为 [面中心点]
   * 则存在面的宽高以及轴向等数据
   * 用于生成面中心点的视觉
   */
  public planeData?: PlaneData;

  constructor(private getCamera: GetCamera, private renderer: WebGLRenderer) {}

  public intersectPoint(out: Intersection[], point: vec3) {
    const rect = this.renderer.domElement.getBoundingClientRect();

    worldPosToClipPos(TEMP_VEC3, point, this.getCamera());
    clipPosToScreenPos(POINT_2D, TEMP_VEC3, rect);

    mat4.getRotation(this.worldQuaternion, this.matrixWorld);
    vec3.transformMat4(this.worldPosition, this.position, this.matrixWorld);
    worldPosToClipPos(TEMP_VEC3, this.worldPosition, this.getCamera());
    clipPosToScreenPos(CENTER_2D, TEMP_VEC3, rect);

    if (vec2.distance(POINT_2D, CENTER_2D) < DETECT_LENGTH) {
      out.push({
        distance: vec3.distance(point, this.worldPosition),
        interaction: this,
      });
    }
  }
}

class SphereObject extends Mesh {
  protected renderOrder = Infinity;
  constructor(regl: Regl, private getCamera: GetCamera) {
    const material = getShaderMaterial(YELLOW, 1);
    const bodyGeometry = new SphereGeometry({
      radius: 0.4,
      widthSegments: 16,
      heightSegments: 8,
    });
    super(regl, bodyGeometry, material);
  }

  public raycast() {}

  /**
   * 重写updateMatrixWorld，自动更新组件的缩放。
   * 让旋转组件跟随摄像机旋转
   */
  public updateMatrixWorld(force = false): void {
    this.getCamera().getFixedScale(
      this.scale,
      mat4.getTranslation(WORLD_POS, this.matrixWorld),
    );

    super.updateMatrixWorld(force);
  }
}

class PlaneObject extends Object3D {
  private planeGeometry: PlaneGeometry;
  private width = 1;
  private height = 1;

  constructor(regl: Regl) {
    super();
    this.planeGeometry = new PlaneGeometry();
    const plane = new Mesh(
      regl,
      this.planeGeometry,
      getShaderMaterial(YELLOW, 0.1),
    );
    plane.raycast = () => {};
    this.add(plane);
  }

  public update(width: number, height: number) {
    if (this.width === width && this.height === height) {
      return;
    }
    this.planeGeometry.update({ width, height });
    this.width = width;
    this.height = height;
  }
}
