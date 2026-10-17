import { mergeDeepWith } from 'ramda';
import {
  AnimatorSlice,
  AnimatorActions,
  ANIMATOR_SLICE_NAME,
  setAnimatorState,
} from '../../redux/animator-slice';
import {
  AppActions,
  AppSlice,
  APP_SLICE_NAME,
  setAppState,
} from '../../redux/app-slice';
import {
  EditingActions,
  EditingSlice,
  EDITING_SLICE_NAME,
  setEditingState,
} from '../../redux/editing-slice';
import {
  PaletteActions,
  PaletteSlice,
  PALETTE_SLICE_NAME,
  setPaletteState,
} from '../../redux/palette-slice';
import { RootState, store } from '../../redux/store';
import { CommonHistory } from './interface';

type ActionPayload<
  T extends {
    payload: any;
  },
> = Pick<T, 'payload'>['payload'];

export interface ActionSaveData {
  action: Actions;
  /**
   * 指定数据对比节点
   * 不传则默认对比发送action之前的数据节点
   */
  oldState?: RootState;
  /**
   * 是否记录到撤销重做栈
   * 不传则默认记录，传入false时仅转发action
   */
  saveRecord?: boolean;
}

export interface StateHistoryAction {
  diff: Object;
  sliceName: string;
  actionName: string;
  payload: ActionPayload<Actions>;
}

export interface ActionSlice
  extends AnimatorSlice,
    AppSlice,
    EditingSlice,
    PaletteSlice {}

export type Actions =
  | AnimatorActions
  | AppActions
  | EditingActions
  | PaletteActions;

type ActionCallback<Payload> = (payload: Payload, isForward: boolean) => void;

const isObject = (o: any) => typeof o === 'object';

const isEmptyObject = (o: any) => isObject(o) && Object.keys(o).length === 0;

export class StateHistory implements CommonHistory<ActionSaveData> {
  private stackPrev: StateHistoryAction[] = [];
  private stackNext: StateHistoryAction[] = [];

  private actionCallback = new Map<
    string,
    ActionCallback<ActionPayload<Actions>>
  >();

  public registerActionCallback = <K extends keyof ActionSlice>(
    actionName: K,
    cb: ActionCallback<ActionPayload<ReturnType<ActionSlice[K]>>>,
  ) => {
    this.actionCallback.set(actionName, cb);
  };

  private getDiff = (leftObj: Object, rightObj: Object) => {
    if (leftObj === rightObj) {
      return {};
    }

    if (!isObject(leftObj) || !isObject(rightObj)) {
      return rightObj;
    }

    // 以左侧数据为准，遍历右侧已删除的数据
    // 删除标记undefined
    const deletedObj = Object.keys(leftObj).reduce((acc, key) => {
      if (!rightObj.hasOwnProperty(key)) {
        acc[key] = undefined;
      }
      return acc;
    }, {});

    return Object.keys(rightObj).reduce((acc, key) => {
      // 右侧有左侧没有视为数据增加
      if (!leftObj.hasOwnProperty(key)) {
        acc[key] = rightObj[key];
        return acc;
      }

      const difference = this.getDiff(leftObj[key], rightObj[key]);

      if (
        isEmptyObject(difference) &&
        (isEmptyObject(leftObj[key]) || !isEmptyObject(rightObj[key]))
      ) {
        return acc;
      }

      // 左侧右侧都有，右侧不一样，视为更改
      acc[key] = difference;
      return acc;
    }, deletedObj);
  };

  public saveHistory(data: ActionSaveData) {
    const { action, oldState, saveRecord = true } = data;

    const diffState = oldState || store.getState();

    if (!saveRecord) {
      store.dispatch(action);
      return false;
    }

    store.dispatch(action);

    const diff = this.getDiff(store.getState(), diffState);

    if (isEmptyObject(diff)) {
      return false;
    }

    const name = action.type.split('/');
    this.stackPrev.push({
      diff,
      sliceName: name[0],
      actionName: name[1],
      payload: action.payload,
    });

    if (this.stackNext.length) {
      this.stackNext = [];
    }
    return true;
  }

  private merge(left: Object, right: Object) {
    return mergeDeepWith(
      (left, right) => {
        // 左侧非数组 或者 右侧非obj的时候
        // 正常mer，以右侧数据为准
        if (!Array.isArray(left) || !isObject(right)) {
          return right;
        }

        // 数组的话将左侧数据替换为右侧数据
        const cloneLeft = Array.from(left);
        Object.keys(right).forEach((key) => {
          // 数组元素不为obj直接替换
          if (!isObject(cloneLeft[key]) || !isObject(right[key])) {
            cloneLeft[key] = right[key];
            return;
          }

          // 数组元素为obj则继续mer
          cloneLeft[key] = this.merge(cloneLeft[key], right[key]);
        });
        // 过滤undefined的数据
        // diff中的undefined代表删除
        return cloneLeft.filter((i) => i !== undefined);
      },
      left,
      right,
    );
  }

  private mergeDiff(diff: Object): RootState {
    return this.merge(store.getState(), diff);
  }

  public undo() {
    const action = this.stackPrev.pop();
    if (!action) {
      return;
    }
    const undoState = this.mergeDiff(action.diff);

    const newDiff = this.getDiff(undoState, store.getState());
    action.diff = newDiff;

    this.stackNext.push(action);
    this.updateState(action.sliceName, undoState);

    const cb = this.actionCallback.get(action.actionName);
    if (cb) {
      cb(action.payload, false);
    }
  }

  public redo() {
    const action = this.stackNext.pop();
    if (!action) {
      return;
    }
    const redoState = this.mergeDiff(action.diff);

    const newDiff = this.getDiff(redoState, store.getState());
    action.diff = newDiff;

    this.stackPrev.push(action);
    this.updateState(action.sliceName, redoState);

    const cb = this.actionCallback.get(action.actionName);
    if (cb) {
      cb(action.payload, true);
    }
  }

  public emptyHistory() {
    this.stackPrev = [];
    this.stackNext = [];
  }

  private updateState(sliceName: string, newState: RootState) {
    switch (sliceName) {
      case ANIMATOR_SLICE_NAME:
        store.dispatch(setAnimatorState(newState.animator));
        break;
      case APP_SLICE_NAME:
        store.dispatch(setAppState(newState.app));
        break;
      case EDITING_SLICE_NAME:
        store.dispatch(setEditingState(newState.editing));
        break;
      case PALETTE_SLICE_NAME:
        store.dispatch(setPaletteState(newState.palette));
        break;
    }
  }
}
