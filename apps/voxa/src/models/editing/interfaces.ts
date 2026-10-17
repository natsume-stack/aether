import { vec3 } from 'gl-matrix';
import type { Camera } from '../rendering/camera/base';
import type { Model } from '../voxel-model/model';
import type { BoxBuilder } from './mode/box-builder';
import type { Face } from './mode/face';
import type { Line } from './mode/line';

export type ModelsDict = {
  selection: Model;
  destination: Model;
  editing: Model;
};

export type EditModes = {
  line: Line;
  face: Face;
  boxBuilder: BoxBuilder;
};

export type BoxBoundary = {
  start: vec3;
  end: vec3;
};

export type GetCamera = () => Camera;

export type PointerDownSnapshot = {
  voxelPos: vec3;
  hitNormal: vec3;
  destinationTextureId: number;
  selectionTextureId: number;
};
