import type { Regl } from '@box/regl';
import { vec3 } from 'gl-matrix';
import { LineBox } from '../line-box';
import { Object3D } from '../rendering/objects/object3d';
import { store } from '../../redux/store';
import { BoxGeometry } from '../rendering/geometries/box-geometry';
import { ShaderMaterial } from '../rendering/materials/shader';
import { basicFragmentShader, basicVertexShader } from '../rendering/shaders';
import { Mesh } from '../rendering/objects/mesh';
import { HitBoxMode } from '../../redux/animator-slice';

const DEFAULT_COLOR = [1, 1, 1];
const ACTIVE_COLOR = [0.98, 0.91, 0.26];

export class HitBox extends Object3D {
  public modelBox: LineBox;
  public box: Box;

  constructor(private regl: Regl) {
    super();
    this.modelBox = new LineBox(this.regl, [0, 0, 0]);
    this.modelBox.alpha = 0.3;

    this.box = new Box(this.regl);

    this.add(this.modelBox, this.box);
  }

  public updateMatrixWorld(force?: boolean): void {
    const { modelBoxVisible, hitBoxMode } = store.getState().animator;

    this.modelBox.visible = modelBoxVisible;
    this.box.color =
      hitBoxMode === HitBoxMode.Custom ? ACTIVE_COLOR : DEFAULT_COLOR;

    super.updateMatrixWorld(force);
  }
}

class Box extends Object3D {
  public box: Mesh<BoxGeometry, ShaderMaterial>;
  public lineBox: LineBox;

  public color = DEFAULT_COLOR;

  private size = vec3.create();

  // 虽然CustomBox自身不渲染任何东西，但需要调用到draw方法更新children的状态
  protected frustumCulled = false;

  constructor(regl: Regl) {
    super();

    const geometry = new BoxGeometry({ size: this.size });

    const material = new ShaderMaterial({
      vertexShader: basicVertexShader,
      fragmentShader: basicFragmentShader,
      uniforms: {
        color: DEFAULT_COLOR,
        alpha: 0.1,
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
    });

    this.box = new Mesh(regl, geometry, material);
    this.lineBox = new LineBox(regl, this.size);

    this.add(this.lineBox, this.box);
  }

  public draw(): void {
    this.lineBox.color = this.color;

    if (this.box.material.uniforms) {
      this.box.material.uniforms['color'] = this.color;
    }

    super.draw();
  }

  public update(size: vec3) {
    vec3.copy(this.size, size);
    this.box.geometry.update({ size });
    this.lineBox.update(size);
  }

  public getSize(out: vec3) {
    return vec3.copy(out, this.size);
  }
}
