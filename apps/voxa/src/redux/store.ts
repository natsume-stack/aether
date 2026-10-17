import { configureStore } from '@reduxjs/toolkit';
import { TypedUseSelectorHook, useSelector } from 'react-redux';
import { animatorSlice } from './animator-slice';
import { appSlice } from './app-slice';
import { editingSlice } from './editing-slice';
import { paletteSlice } from './palette-slice';
import { permissionSlice } from './permission-slice';

export const store = configureStore({
  reducer: {
    app: appSlice.reducer,
    animator: animatorSlice.reducer,
    editing: editingSlice.reducer,
    palette: paletteSlice.reducer,
    permission: permissionSlice.reducer,
  },
  devTools: process.env.NODE_ENV === 'development',
});

// Infer the `RootState` and `AppDispatch` types from the store itself
export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
export const useAppSelector: TypedUseSelectorHook<RootState> = useSelector;
