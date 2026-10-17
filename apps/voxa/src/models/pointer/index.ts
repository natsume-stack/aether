import { vec2, vec3 } from 'gl-matrix';
import { Geometry } from '../rendering/geometry';
import { ShaderMaterial } from '../rendering/materials/shader';
import type { Object3D } from '../rendering/objects/object3d';
import { LineLoop } from '../rendering/objects/line-loop';
import { Intersection, Raycaster } from '../rendering/raycast';
import { BufferAttribute } from '../rendering/geometries/buffer-attribute';
import fragmentShader from './frag.glsl';
import vertexShader from './vert.glsl';
import type { Stage } from '../stage';
import { screenPosToClipPos } from '../../utils/coordinate';

/**
 * 顶点各个面相对坐标
 */
const FACES = {
  '0,0,-1': [
    [0, 0, 0],
    [0, 1, 0],
    [1, 1, 0],
    [1, 0, 0],
  ],
  '0,0,1': [
    [1, 0, 1],
    [1, 1, 1],
    [0, 1, 1],
    [0, 0, 1],
  ],
  '0,1,0': [
    [0, 1, 0],
    [0, 1, 1],
    [1, 1, 1],
    [1, 1, 0],
  ],
  '0,-1,0': [
    [0, 0, 0],
    [1, 0, 0],
    [1, 0, 1],
    [0, 0, 1],
  ],
  '-1,0,0': [
    [0, 0, 0],
    [0, 0, 1],
    [0, 1, 1],
    [0, 1, 0],
  ],
  '1,0,0': [
    [1, 1, 1],
    [1, 0, 1],
    [1, 0, 0],
    [1, 1, 0],
  ],
};

const DEFAULT_POS: vec3 = [-1, -1, -1];

/**
 * Voxel光标
 */
export class Pointer extends LineLoop {
  private eventPosition = vec2.create();
  private readonly voxelPos = vec3.clone(DEFAULT_POS);
  private readonly normal = vec3.clone(DEFAULT_POS);

  private drawingEnabled = true;

  constructor(
    private stage: Stage,
    public raycaster: Raycaster,
    private intersectTargets: Object3D[] = [],
  ) {
    const geometry = new Geometry();
    geometry.setAttribute(
      'position',
      new BufferAttribute(new Float32Array(), 3),
    );
    const material = new ShaderMaterial({
      vertexShader,
      fragmentShader,
      depth: {
        enable: true,
        mask: true,
        func: '<=',
      },
    });

    super(stage.regl, geometry, material);

    window.addEventListener('pointermove', this.updatePointer);
    window.addEventListener('pointerdown', this.updatePointer);
  }

  public dispose() {}

  private updatePointer = (event: PointerEvent) => {
    screenPosToClipPos(
      this.eventPosition,
      [event.clientX, event.clientY],
      this.stage.getRendererDOMRect(),
    );

    this.update();
  };

  /**
   * 更新指针位置。
   * 当指向模型空间内时，更新有效的voxelPos和normal，否则重置回[-1, -1, -1]。
   */
  public update() {
    if (!this.updateGeometryPosition()) {
      this.resetVoxelPosAndNormal();
      this.visible = false;

      return;
    }

    this.visible = true;
  }

  /**
   * 设置指针是否绘制
   * @param enabled 是否启用指针绘制
   */
  public setDrawingEnabled(enabled: boolean) {
    this.drawingEnabled = enabled;
  }

  public draw(): void {
    if (!this.drawingEnabled) {
      return;
    }

    super.draw();
  }

  /**
   * 射线检测，并更新指针在模型空间内的位置。
   * @returns 指针是否在模型空间内
   */
  private updateGeometryPosition(): boolean {
    this.raycaster.setFromCamera(this.eventPosition, this.stage.getCamera());
    const intersects: Intersection[] = [];

    // only detect targets, like voxelModels and boundary
    this.intersectTargets.find((target) => {
      this.raycaster.intersectObject(intersects, target, true);
    });

    const intersect = intersects[0];

    if (!intersect) {
      return false;
    }

    const position = this.getCubeFace(
      intersect.voxelPos,
      intersect.normal,
      intersect.object.isVoxels(),
    );

    if (!position) {
      return false;
    }

    this.geometry.setAttribute(
      'position',
      new BufferAttribute(
        position ? new Float32Array(position) : new Float32Array(),
        3,
      ),
    );

    return true;
  }

  /**
   * 根据传入的坐标和方向向量，得到体素的平面顶点数据
   * @param absPos 精确坐标
   * @param voxelPos 体素坐标（由精确坐标向下取整得到）
   * @param normal 选中的方向向量
   * @param hitBoundary 是否触碰到边界
   * @returns 如果检测到有效的体素平面，返回平面的几何数据
   */
  private getCubeFace(voxelPos: vec3, normal: vec3, hitVoxels: boolean) {
    let vertices: number[];

    const index = hitVoxels
      ? `${normal[0]},${normal[1]},${normal[2]}`
      : [normal[0], normal[1], normal[2]]
          .map((v) => (v == 0 ? 0 : -1 * v))
          .join();
    const faceVertices = FACES[index];

    if (!faceVertices) {
      return;
    }
    vertices = Pointer.mapVertices(FACES[index], voxelPos, normal);

    vec3.copy(this.normal, normal);
    vec3.copy(this.voxelPos, voxelPos);
    return vertices;
  }

  private static mapVertices(
    faceVertices: number[][],
    voxelPos: vec3,
    normal: vec3,
  ) {
    return faceVertices
      .map((pos) => {
        return [
          pos[0] + voxelPos[0] + 0.005 * normal[0],
          pos[1] + voxelPos[1] + 0.005 * normal[1],
          pos[2] + voxelPos[2] + 0.005 * normal[2],
        ];
      })
      .flat();
  }

  /**
   * Get the pointed voxel position, if the pointer is not pointing to a voxel, return [-1, -1, -1]. Modify returned value would not affect Pointer.
   * @returns
   */
  public getVoxelPos() {
    return vec3.clone(this.voxelPos);
  }

  /**
   * Get the pointed face normal, if the pointer is not pointing to anything, return [-1, -1, -1]. Modify returned value would not affect Pointer.
   * @returns
   */
  public getNormal() {
    return vec3.clone(this.normal);
  }

  /**
   * Check if voxel pos is valid （not equal to [-1, -1, -1]）
   */
  public isVoxelPosValid(): boolean {
    return !vec3.exactEquals(this.voxelPos, [-1, -1, -1]);
  }

  public setIntersectTargets(targets: Object3D[]) {
    this.intersectTargets = targets.slice(0);
  }

  private resetVoxelPosAndNormal() {
    vec3.copy(this.voxelPos, DEFAULT_POS);
    vec3.copy(this.normal, DEFAULT_POS);
  }
}
