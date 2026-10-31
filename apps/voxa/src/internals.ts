import React from 'react';
import type { VoxelEditor } from './models/editor';

export const VoxelEditorContext = React.createContext<VoxelEditor | undefined>(
  undefined,
);
