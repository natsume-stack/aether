import { vec2 } from 'gl-matrix';
import type { SerializedVec2 } from '@box/box-design';
import type { AnimatorApp } from '../animator-app';
import { setCurrentTime, setPlaying } from '../../redux/app-slice';
import { store } from '../../redux/store';
import type { EditingHistory } from '../editing-history';
import {
  findLastKeyframeTime,
  findNextKeyframeTime,
  findPrevKeyframeTime,
} from '../animator-app/motion-manager/util';
import type { MotionNodes } from '../../redux/animator-slice';
import { LocateKeyframeType } from './const';
import {
  frameToTime,
  isControllerVisible,
  MAX_KEYFRAME_TIME,
  timeToFrame,
} from '../animator-app/util';
import type { IEvents } from '../events/interface';

type InitParams = {
  events: IEvents;
  history: EditingHistory;
  animatorApp: AnimatorApp;
};

export class MotionPlayer {
  private raf?: number;

  /**
   * 执行raf时的时间戳，用于计算delta
   */
  private prevTimestamp?: number;

  /**
   * 播放的起始时间和结束时间，单位是秒
   * - 以后做区间循环会允许修改起始数值
   */
  private loopSchedule: SerializedVec2 = [0, MAX_KEYFRAME_TIME];

  private events: IEvents;
  private history: EditingHistory;
  private animatorApp: AnimatorApp;

  constructor({ events, history, animatorApp }: InitParams) {
    this.events = events;
    this.history = history;
    this.animatorApp = animatorApp;
  }

  public play() {
    if (store.getState().app.motionPanel.playing) {
      return;
    }

    this.events.addListener('abort', this.pause);

    store.dispatch(setPlaying(true));

    this.animatorApp.nodeManager.transform.setTransformControlsVisible(false);

    this.raf = requestAnimationFrame(this.onFrame);
  }

  private onFrame = (timestamp: number) => {
    const { currentTime } = store.getState().app.motionPanel;

    let newCurrentTime: number;

    if (this.prevTimestamp === undefined) {
      this.prevTimestamp = timestamp;

      newCurrentTime = currentTime;
    } else {
      const delta = timestamp - this.prevTimestamp;

      this.prevTimestamp = timestamp;

      newCurrentTime = currentTime + millisecondToSecond(delta);
    }

    // 如果不在loopSchedule的范围内，重置回起点
    if (
      newCurrentTime > this.loopSchedule[1] ||
      newCurrentTime < this.loopSchedule[0]
    ) {
      newCurrentTime = this.loopSchedule[0];
    }

    this.update(newCurrentTime);

    this.raf = requestAnimationFrame(this.onFrame);
  };

  private update(time: number) {
    store.dispatch(setCurrentTime(time));

    this.animatorApp.motionManager.poseAtTime(time);
  }

  /**
   * 停止播放的raf，清理播放的缓存，重置state播放标记
   */
  private stopPlaying = () => {
    this.prevTimestamp = undefined;

    if (this.raf !== undefined) {
      cancelAnimationFrame(this.raf);

      this.raf = undefined;
    }

    store.dispatch(setPlaying(false));

    const { activeIds, mode } = store.getState().animator;
    const controllerVisible = isControllerVisible(mode, activeIds);
    this.animatorApp.nodeManager.transform.setTransformControlsVisible(
      controllerVisible,
    );

    this.events.removeListener('abort', this.pause);
  };

  /**
   * 暂停播放
   */
  public pause = () => {
    if (!store.getState().app.motionPanel.playing) {
      return;
    }

    this.stopPlaying();

    // 中断后，修正到帧的位置
    const { currentTime } = store.getState().app.motionPanel;

    const newFrame = timeToFrame(currentTime);
    const newCurrentTime = frameToTime(newFrame);

    this.update(newCurrentTime);
  };

  /**
   * 停止播放，并重置时间为0
   */
  public stop() {
    if (!store.getState().app.motionPanel.playing) {
      return;
    }

    this.stopPlaying();

    this.update(0);
  }

  /**
   * 根据指定的方法，移动游标
   */
  public locateKeyframe(nodeIds: string[], type: LocateKeyframeType) {
    const { app, animator } = store.getState();

    const { motionData, activeMotionId } = animator;

    const motion = motionData.motions[activeMotionId];

    if (!motion) {
      return;
    }

    const { currentTime } = app.motionPanel;

    let time: number;

    switch (type) {
      case LocateKeyframeType.Last:
        time = this.locateLastKeyframe(nodeIds, motion.nodes);
        break;
      case LocateKeyframeType.Prev:
        time = this.locatePrevKeyframe(currentTime, nodeIds, motion.nodes);
        break;
      case LocateKeyframeType.Next:
        time = this.locateNextKeyframe(currentTime, nodeIds, motion.nodes);
        break;
      default:
        time = 0;
        break;
    }

    if (!isFinite(time)) {
      return;
    }

    this.history.saveAction({ action: setCurrentTime(time) });

    this.animatorApp.motionManager.poseAtTime(time);
  }

  private locateLastKeyframe(nodeIds: string[], nodes: MotionNodes) {
    let time = -Infinity;

    nodeIds.forEach((nodeId) => {
      const motionNode = nodes[nodeId];

      if (!motionNode) {
        return;
      }

      const nodeTime = findLastKeyframeTime(motionNode.keyframes);

      if (nodeTime !== undefined) {
        time = Math.max(time, nodeTime);
      }
    });

    return time;
  }

  private locateNextKeyframe(
    currentTime: number,
    nodeIds: string[],
    nodes: MotionNodes,
  ) {
    let time = Infinity;

    nodeIds.forEach((nodeId) => {
      const motionNode = nodes[nodeId];

      if (!motionNode) {
        return;
      }

      const nodeTime = findNextKeyframeTime(currentTime, motionNode.keyframes);

      if (nodeTime !== undefined) {
        time = Math.min(time, nodeTime);
      }
    });

    return time;
  }

  private locatePrevKeyframe(
    currentTime: number,
    nodeIds: string[],
    nodes: MotionNodes,
  ) {
    let time = -Infinity;

    nodeIds.forEach((nodeId) => {
      const motionNode = nodes[nodeId];

      if (!motionNode) {
        return;
      }

      const nodeTime = findPrevKeyframeTime(currentTime, motionNode.keyframes);

      if (nodeTime !== undefined) {
        time = Math.max(time, nodeTime);
      }
    });

    return time;
  }

  /**
   * 获取一个动作的总时长。
   * @param motionId 动作id
   */
  public getMotionDuration(motionId: string) {
    const motion = store.getState().animator.motionData.motions[motionId];

    if (!motion) {
      return 0;
    }

    // 计算时长实际上是在所有节点中查找最后一个关键帧的时间
    const time = this.locateLastKeyframe(
      Object.keys(motion.nodes),
      motion.nodes,
    );

    return isFinite(time) ? time : 0;
  }

  /**
   * 设置循环的区间
   */
  public setLoopSchedule(schedule: SerializedVec2) {
    vec2.copy(this.loopSchedule, schedule);
  }
}

function millisecondToSecond(millisecond: number) {
  return millisecond / 1000;
}
