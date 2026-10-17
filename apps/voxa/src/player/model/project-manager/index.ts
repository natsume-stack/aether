import { getModelMetaData, migrateModel } from '@box/voxa-project';
import type { RequestParams } from '../request-params';
import type { Loader } from '../../../common/loader';
import type { Object3D } from '../../../models/rendering/objects/object3d';
import { apis } from '../apis';

type Params = {
  loader: Loader;
};

export type LoadOptions = {
  parent: Object3D;
  modelId?: number;
  modelFileHash?: string;
  params?: RequestParams;
};

export class ProjectManager {
  private loader: Loader;

  constructor(params: Params) {
    const { loader } = params;

    this.loader = loader;
  }

  public async load(options: LoadOptions) {
    const {
      modelId,
      modelFileHash: optionModelFileHash,
      params,
      parent,
    } = options;

    let modelFileHash: string | undefined;

    if (modelId) {
      const model = await apis.model.getModelDetailUsingGet(modelId, params);

      modelFileHash = model.modelFileHash;
    } else if (optionModelFileHash) {
      modelFileHash = optionModelFileHash;
    } else {
      return;
    }

    const result = await this.getModelFile(modelFileHash, options.params);

    if (!result) {
      return;
    }

    const { data: modelData, metaData } = result;

    // 如果没有任何Mesh，不需要加载
    if (!modelData || modelData.meshes.length === 0) {
      return;
    }

    const glTexture = this.loader.loadTexture(modelData?.texture);

    this.loader.loadNodes({
      nodes: modelData.nodes,
      meshes: modelData.meshes,
      glTexture,
      parent,
    });

    return { metaData };
  }

  private async getModelFile(modelFileHash: string, params?: RequestParams) {
    const modelFileArrayBuffer = (
      await apis.content.request<ArrayBuffer>({
        url: modelFileHash,
        responseType: 'arraybuffer',
        ...params,
      })
    ).data;

    const modelMetaData = await getModelMetaData(
      modelFileHash,
      new Uint8Array(modelFileArrayBuffer),
    );

    if (!modelMetaData) {
      return;
    }

    const modelDataBytes = (
      await apis.content.request<ArrayBuffer>({
        url: modelMetaData.dataHash,
        responseType: 'arraybuffer',
        ...params,
      })
    ).data;

    const modelData = await migrateModel(new Uint8Array(modelDataBytes));

    if (!modelData) {
      return;
    }

    return {
      data: modelData,
      metaData: modelMetaData,
    };
  }
}
