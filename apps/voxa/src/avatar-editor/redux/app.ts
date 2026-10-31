import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import { BodyPartName } from '../../avatar/models/defs';

export type NewMotion = {
  name: string;
  frameCount: number;
  frameOffset: number;
  playTime: number;
};

// state
export type appState = {
  selectedSkinId: string;
  newMotions: NewMotion[];
};

// action
export type SetSelectedSkinId = PayloadAction<string>;
export type SetMotionList = PayloadAction<NewMotion[]>;

const initialState: appState = {
  selectedSkinId: BodyPartName.hips,
  newMotions: [],
};

export const appSlice = createSlice({
  name: 'viewer',
  initialState,
  reducers: {
    setSelectedSkinId(state, action: SetSelectedSkinId) {
      state.selectedSkinId = action.payload;
    },
    setNewMotions(state, action: SetMotionList) {
      state.newMotions = action.payload;
    },
  },
});

export const { setSelectedSkinId, setNewMotions } = appSlice.actions;
