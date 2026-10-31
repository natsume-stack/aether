import type {ModelResp} from '@box/apis';
export function decodeLocalModel(value:unknown):ModelResp {
  if(!value || typeof value!=='object') throw new Error('本地模型响应无效');
  const row=value as Record<string,unknown>;
  if(!Number.isSafeInteger(row.modelId) || typeof row.modelName!=='string' || typeof row.modelFileHash!=='string' || ![0,1,2,3].includes(Number(row.modelType))) throw new Error('本地模型响应缺少必要字段');
  return row as unknown as ModelResp;
}

type ImportedModel=Pick<ModelResp,'modelId'|'modelName'|'modelFileHash'|'modelPreviewHash'|'modelPreviewUrl'|'animated'>;
export function decodeImportedModel(value:unknown):ImportedModel {
  if(!value || typeof value!=='object') throw new Error('模型导入响应无效');
  const row=value as Record<string,unknown>;
  if(!Number.isSafeInteger(row.modelId) || ['modelName','modelFileHash','modelPreviewHash','modelPreviewUrl'].some(key=>typeof row[key]!=='string') || typeof row.animated!=='boolean') throw new Error('模型导入响应缺少必要字段');
  return row as unknown as ImportedModel;
}
