import { mat4, vec3, quat } from 'gl-matrix';
import { nanoid } from 'nanoid';
import type { Regl } from '@box/regl';
import { TorusGeometry } from '../rendering/geometries/torus-geometry';
import { ShaderMaterial } from '../rendering/materials/shader';
import { basicFragmentShader, basicVertexShader } from '../rendering/shaders';
import { Bone } from '../rendering/objects/bone';
import { Mesh } from '../rendering/objects/mesh';
import type { Intersection, Raycaster } from '../rendering/raycast';
import { ModelUnitType, RenderOrder } from '../animator-app/util';
import { store } from '../../redux/store';
import { GetCamera } from '../editing/interfaces';
import { Sphere } from '../rendering/math/sphere';
import { Object3D } from '../rendering/objects/object3d';
import type { Camera } from '../rendering/camera/base';
import { AppMode } from '../../redux/app-slice';
import { AnimatorMode } from '../../redux/animator-slice';

const WORLD_POS = vec3.create();
const TEMP_Q = quat.create();

const RADIUS = 1.6;
const DEFAULT_COLOR = [0.6, 0.84, 0.53];
const HOVER_COLOR = [1, 1, 1];
const ACTIVE_COLOR = [0.98, 0.91, 0.26];
const RELATIVE_COLOR = [0.64, 0.52, 0.03];

export class BoneNode extends Bone {
  public readonly modelUnitType: ModelUnitType = ModelUnitType.bone;
  public interactive: Sphere;

  private ringObject: RingObject;

  // 虽然自身不渲染任何东西，但需要调用到draw方法更新children颜色
  protected frustumCulled = false;

  // 透明度不影响渲染，只影响绑定部件的透明度
  public alpha = 1;

  constructor(private regl: Regl, uuid: string, private getCamera: GetCamera) {
    super(uuid);
    this.ringObject = new RingObject(regl);
    this.add(this.ringObject);

    this.interactive = new Sphere();
  }

  private getColor() {
    const { activeIds, relativeIds, hoveredId } = store.getState().animator;
    if (activeIds.includes(this.uuid)) {
      return ACTIVE_COLOR;
    }
    if (hoveredId === this.uuid) {
      return HOVER_COLOR;
    }
    if (relativeIds.includes(this.uuid)) {
      return RELATIVE_COLOR;
    }
    return DEFAULT_COLOR;
  }

  public draw() {
    if (!this.ringObject.visible) {
      return;
    }
    this.ringObject.mesh.setColor(this.getColor());
  }

  public copy(source: BoneNode, recursive?: boolean) {
    const newBoneNode = super.copy(source, recursive);
    newBoneNode.alpha = source.alpha;
    return newBoneNode;
  }

  public clone(recursive = false): BoneNode {
    const newGroup = new BoneNode(this.regl, nanoid(), this.getCamera);
    newGroup.copy(this, recursive);
    return newGroup;
  }

  /**
   * 让旋转组件跟随摄像机旋转，并且不受骨骼节点缩放影响
   */
  public updateMatrixWorld(force = false): void {
    this.updateVisible();
    this.rotateWithCamera();
    this.fixRingSize();
    super.updateMatrixWorld(force);
  }

  private updateVisible() {
    const { app, animator } = store.getState();
    // 体素模式下/物理编辑模式下，骨骼不可见
    if (app.mode === AppMode.Voxel || animator.mode === AnimatorMode.HitBox) {
      this.ringObject.visible = false;
      return;
    }

    const { activeIds, skeletonVisible } = store.getState().animator;
    this.ringObject.visible = activeIds.includes(this.uuid) || skeletonVisible;
  }

  private rotateWithCamera(): void {
    this.ringObject.mesh.rotateWithCamera(this.getCamera());
  }

  private fixRingSize() {
    mat4.getScaling(WORLD_POS, this.matrixWorld);
    vec3.inverse(this.ringObject.scale, WORLD_POS);
  }

  public raycast(out: Intersection[], raycaster: Raycaster) {
    if (!this.ringObject.visible) {
      return;
    }
    mat4.getTranslation(WORLD_POS, this.matrixWorld);
    this.interactive.set(WORLD_POS, RADIUS);
    const { ray } = raycaster;
    if (ray.intersectsSphere(this.interactive)) {
      out.push({
        absPos: WORLD_POS,
        voxelPos: [0, 0, 0], // 这个数据用不上，随便写的
        normal: [0, 0, 0], // 这个数据用不上，随便写的
        distance: this.interactive.distanceToPoint(ray.origin),
        object: this,
      });
      return out;
    }
  }
}

class RingObject extends Object3D {
  public mesh: RingMesh;
  public raycast = () => {};

  constructor(regl: Regl) {
    super();

    this.mesh = new RingMesh(regl);
    this.add(this.mesh);
  }
}

class RingMesh extends Mesh {
  protected renderOrder = RenderOrder.bone;

  constructor(regl: Regl) {
    const shader = new ShaderMaterial({
      vertexShader: basicVertexShader,
      fragmentShader: basicFragmentShader,
      uniforms: {
        color: DEFAULT_COLOR,
        alpha: 1,
      },
      depth: {
        enable: false,
        mask: false,
      },
      cull: {
        enable: false,
      },
      transparent: true,
    });
    const ringGeometry = new TorusGeometry({
      radius: RADIUS,
      tube: 0.1,
      radialSegments: 3,
      tubularSegments: 25,
    });
    super(regl, ringGeometry, shader);
  }

  public setColor(color: number[]) {
    if (this.material && this.material.isShader() && this.material.uniforms) {
      this.material.uniforms['color'] = color;
    }
  }

  public rotateWithCamera(camera: Camera): void {
    if (!this.parent) {
      return;
    }
    quat.invert(TEMP_Q, this.parent.quaternionWorld);
    quat.mul(this.quaternion, TEMP_Q, camera.quaternion);
  }
}
