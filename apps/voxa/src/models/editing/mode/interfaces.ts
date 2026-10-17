import type { vec3 } from 'gl-matrix';

export type Collection = vec3[];

export type EditModeParams = {
  collection: Collection;
  operation: Operation;
};

export type OperationParams = {
  pos: vec3;
};

export type Operation = (params: OperationParams) => void;
