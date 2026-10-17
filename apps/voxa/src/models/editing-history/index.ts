import { nanoid } from 'nanoid';
import { setRedoEnabled, setUndoEnabled } from '../../redux/app-slice';
import { store } from '../../redux/store';
import { ActionSaveData, StateHistory } from './state-history';
import { VoxelHistory, VoxelSaveData } from './voxel-history';

type HistoryRecord = {
  type: 'voxel' | 'state';
  groupId?: string;
  apply: (isForward: boolean) => void;
};
export class EditingHistory {
  private redoStack: HistoryRecord[] = [];
  private undoStack: HistoryRecord[] = [];
  private lastGroupId?: string;
  private groupId?: string;
  private groupDepth: number = 0;

  private voxelHistory = new VoxelHistory();

  private stateHistory = new StateHistory();

  public registerActionCallback = this.stateHistory.registerActionCallback;

  public registerVoxelCallback = this.voxelHistory.registerVoxelCallback;

  private stateRecordingEnabledCount = 0;

  public setGroup(groupId?: string) {
    this.groupDepth++;
    if (this.groupId) {
      return;
    }
    this.groupId = groupId || nanoid();
  }

  public unsetGroup() {
    this.groupDepth--;
    if (this.groupDepth <= 0) {
      this.groupDepth = 0;
      this.lastGroupId = this.groupId;
      this.groupId = undefined;
    }
  }

  public getLastGroupId() {
    return this.lastGroupId;
  }

  /**
   * 存储体素视图的历史记录
   * @param data 体素数据
   */
  public saveVoxel(data: VoxelSaveData) {
    const changed = this.voxelHistory.saveHistory(data);

    if (!changed) {
      return;
    }

    this.addRecord({
      type: 'voxel',
      groupId: this.groupId,
      apply: (isForward) => {
        isForward ? this.voxelHistory.redo() : this.voxelHistory.undo();
      },
    });
  }

  /**
   * 存储发送action前后数据的变化
   * 并dispatch action
   * @param data action
   */
  public saveAction(data: ActionSaveData) {
    const { saveRecord: dataSaveRecord, ...remain } = data;

    const changed = this.stateHistory.saveHistory({
      ...remain,
      saveRecord: this.isStateRecordingEnabled() && dataSaveRecord,
    });

    if (!changed) {
      return;
    }

    this.addRecord({
      type: 'state',
      groupId: this.groupId,
      apply: (isForward) => {
        isForward ? this.stateHistory.redo() : this.stateHistory.undo();
      },
    });
  }

  private addRecord(record: HistoryRecord) {
    this.undoStack.push(record);
    this.redoStack = [];

    this.updateView();
  }

  public undo() {
    const record = this.undoStack.pop();
    if (!record) {
      return;
    }

    const records = this.searchGroupRecord(record, this.undoStack);

    records.forEach((r) => r.apply(false));
    this.redoStack.push(...records);

    this.updateView();
  }

  public redo() {
    const record = this.redoStack.pop();
    if (!record) {
      return;
    }

    const records = this.searchGroupRecord(record, this.redoStack);

    records.forEach((r) => r.apply(true));
    this.undoStack.push(...records);

    this.updateView();
  }

  private searchGroupRecord(record: HistoryRecord, stack: HistoryRecord[]) {
    const records = [record];

    const groupId = record.groupId;
    while (
      groupId &&
      stack.length &&
      stack[stack.length - 1].groupId === groupId
    ) {
      const groupRecord = stack.pop();
      groupRecord && records.push(groupRecord);
    }

    return records;
  }

  /**
   * 根据当前撤销重做栈的状态，更新store。
   */
  private updateView() {
    store.dispatch(setUndoEnabled(this.undoStack.length > 0));
    store.dispatch(setRedoEnabled(this.redoStack.length > 0));
  }

  public clear() {
    this.voxelHistory.emptyHistory();
    this.stateHistory.emptyHistory();

    this.redoStack.length = 0;
    this.undoStack.length = 0;

    this.updateView();
  }

  /**
   * 设置是否记录新的事件。
   */
  public setStateRecordingEnabled(enabled: boolean) {
    if (!enabled && !this.isStateRecordingEnabled()) {
      return;
    }

    this.stateRecordingEnabledCount += enabled ? 1 : -1;
  }

  /**
   * 判断当前是否记录新事件
   */
  private isStateRecordingEnabled() {
    return this.stateRecordingEnabledCount >= 0;
  }
}
