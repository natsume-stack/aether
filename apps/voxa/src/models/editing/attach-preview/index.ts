import { vec3 } from 'gl-matrix';
import type { Regl } from '@box/regl';
import { BoxGeometry } from '../../rendering/geometries/box-geometry';
import { ShaderMaterial } from '../../rendering/materials/shader';
import { Object3D } from '../../rendering/objects/object3d';
import vertexShader from './vert.glsl';
import fragmentShader from './frag.glsl';
import { Mesh } from '../../rendering/objects/mesh';
import { store } from '../../../redux/store';
import { isPaletteItemValid } from '../../palette/util';

const FACE_LIGHTNESS = [0.6, 0.7, 0.75, 1, 0.5, 0.4, 0.1];

const DEFAULT_RGB: vec3 = [1, 1, 1];

/**
 * 体建造（attachTool boxMode）时预览的立方体
 */
export class AttachPreview extends Object3D {
  constructor(private regl: Regl) {
    super();
  }
  private childrenMaterial?: ShaderMaterial;

  public children: Mesh[] = [];

  public update(boundaries: { start: vec3; end: vec3 }[]) {
    const material = this.getChildrenMaterial();

    const size = vec3.create();

    boundaries.forEach(({ start, end }, idx) => {
      vec3.sub(size, end, start);

      const geometry = new BoxGeometry({
        size,
        isVoxel: true,
        outerNormal: true,
      });

      let box = this.children[idx];

      if (!box) {
        box = new Mesh(this.regl, geometry, material);

        this.add(box);
      } else {
        const position = geometry.getAttribute('position');
        const normal = geometry.getAttribute('normal');

        if (position && normal) {
          box.geometry.setAttribute('position', position);
          box.geometry.setAttribute('normal', normal);
        }
      }

      vec3.copy(box.position, start);
    });
  }

  private getChildrenMaterial(): ShaderMaterial {
    const { items, selectedId } = store.getState().palette;

    const paletteItem = items[selectedId];

    const rgb = vec3.clone(DEFAULT_RGB);

    if (isPaletteItemValid(paletteItem)) {
      const [r, g, b] = paletteItem.rgb;

      vec3.scale(rgb, [r, g, b], 1 / 255);
    }

    if (!this.childrenMaterial) {
      this.childrenMaterial = new ShaderMaterial({
        uniforms: {
          'color': rgb,
          'alpha': 1,
          'Lightness[0]': FACE_LIGHTNESS[0],
          'Lightness[1]': FACE_LIGHTNESS[1],
          'Lightness[2]': FACE_LIGHTNESS[2],
          'Lightness[3]': FACE_LIGHTNESS[3],
          'Lightness[4]': FACE_LIGHTNESS[4],
          'Lightness[5]': FACE_LIGHTNESS[5],
          'Lightness[6]': FACE_LIGHTNESS[6],
        },
        vertexShader,
        fragmentShader,
      });
    } else if (this.childrenMaterial.uniforms) {
      this.childrenMaterial.uniforms['color'] = rgb;
    }

    return this.childrenMaterial;
  }
}
