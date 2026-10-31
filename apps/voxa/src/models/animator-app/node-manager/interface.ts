import type { vec3 } from 'gl-matrix';

import type {
  RemoveHierarchyNode,
  UpdateNodeData,
} from '../../../redux/animator-slice';
import type { SkinPart } from '../../skin-part';
import type { Group } from '../../rendering/objects/group';
import type {
  TransformEvent,
  TransformDragEndEvent,
} from '../../rendering/controls/transform';

export type SkinNode = SkinPart | Group;

export interface UpdateData extends UpdateNodeData {
  size: vec3;
}

interface NodeEvent {
  ids: string[];
  saveRecord?: boolean;
}

type RemoveNodesEvent = {
  nodes: RemoveHierarchyNode[];
  saveRecord?: boolean;
};

export interface EventMap {
  select: NodeEvent;
  remove: RemoveNodesEvent;
  dragStart: TransformEvent;
  dragEnd: TransformDragEndEvent;
  dbClick: string;
}
