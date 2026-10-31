import { exportToGLTF, GLTFNode } from '@box/mesher/gltf';
import { store } from '../../redux/store';
import type { ProjectManager } from '../project';
import type { IResult } from '../result/interfaces';

type InitParams = {
  project: ProjectManager;
};

export class GLTFTool {
  private project: ProjectManager;

  constructor(params: InitParams) {
    const { project } = params;

    this.project = project;
  }

  public async generateGLTF(): Promise<IResult<Blob, { msg: string }>> {
    const { mesher, nodes, hierarchies, paletteList, emissiveList } =
      await this.project.getBasicModelData();

    const { projectName } = store.getState().app;

    let res: string | undefined;

    const gltfNodes: GLTFNode[] = nodes.map(
      ({ alpha, mesh, rotation, translation, scale, children }, idx) => {
        if (idx === 0) {
        }

        /**
         * voxa的alpha值为[0, 1]
         * mesher的alpha值为[0, 255]
         */
        const gltfAlpha = alpha * 255;

        const name = hierarchies[idx] ? hierarchies[idx].name : undefined;

        return {
          name,
          rotation: [...rotation],
          translation: [...translation],
          scale: [...scale],
          mesh,
          alpha: gltfAlpha,
          children,
        };
      },
    );

    let errorMsg: string = '';

    try {
      res = await exportToGLTF(
        projectName,
        mesher,
        paletteList,
        emissiveList,
        gltfNodes,
      );

      if (res) {
        return {
          isSuccess: true,
          body: new Blob([res], { type: 'model/gltf-json' }),
        };
      }
    } catch (err) {
      console.error('Failed to export GLTF', err);
      errorMsg = err.message;
    }

    return {
      isSuccess: false,
      body: {
        msg: errorMsg,
      },
    };
  }
}
