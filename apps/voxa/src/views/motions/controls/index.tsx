import { useCallback, useContext, useMemo } from 'react';
import { useIntl } from 'react-intl';
import {
  Button,
  TooltipTrigger,
  SharedTipsContext,
  TriggerOptions,
} from '@box/box-design';
import { VoxelEditorContext } from '../../../internals';
import { LocateKeyframeType } from '../../../models/motion-player/const';
import { useAppSelector } from '../../../redux/store';
import { MotionsContext } from '../context';
import { timeToFrame } from '../../../models/animator-app/util';
import styles from './style.module.scss';

export function MotionControls() {
  const { currentTime, playing, activeMotionId } = useAppSelector(
    ({ app, animator }) => {
      const { currentTime, playing } = app.motionPanel;

      return {
        currentTime,
        playing,
        activeMotionId: animator.activeMotionId,
      };
    },
  );

  const { boneIds } = useContext(MotionsContext);

  const editor = useContext(VoxelEditorContext);

  const displayTime = useMemo(() => {
    const sec = Math.trunc(currentTime);

    const frame = timeToFrame(currentTime - sec);

    return `${formatNumber(sec)}:${formatNumber(frame)}`;
  }, [currentTime]);

  /**
   * 为当前所有节点增加关键帧
   */
  const addKeyframes = useCallback(() => {
    editor?.animatorApp.motionManager.addKeyframe(boneIds);
  }, [editor, boneIds]);

  /**
   * 暂停播放并定位关键帧
   */
  const locateKeyframeTime = useCallback(
    (type: LocateKeyframeType) => {
      if (!editor) {
        return;
      }

      editor.motionPlayer.pause();
      editor.motionPlayer.locateKeyframe(boneIds, type);
    },
    [editor, boneIds],
  );

  const toNextKeyframe = useCallback(() => {
    locateKeyframeTime(LocateKeyframeType.Next);
  }, [locateKeyframeTime]);

  const toPrevKeyframe = useCallback(() => {
    locateKeyframeTime(LocateKeyframeType.Prev);
  }, [locateKeyframeTime]);

  const toLastKeyframe = useCallback(() => {
    locateKeyframeTime(LocateKeyframeType.Last);
  }, [locateKeyframeTime]);

  const toFirstKeyframe = useCallback(() => {
    locateKeyframeTime(LocateKeyframeType.First);
  }, [locateKeyframeTime]);

  const intl = useIntl();

  const { delay, setDisplayed } = useContext(SharedTipsContext);

  const onPopupVisibleChange = useCallback(
    (visible: boolean) => {
      visible && setDisplayed(visible);
    },
    [setDisplayed],
  );

  const triggerOptions = useMemo<TriggerOptions>(() => {
    return {
      onPopupVisibleChange,
      delay,
      placement: 'top',
    };
  }, [delay, onPopupVisibleChange]);

  const playButton = useMemo(() => {
    if (playing) {
      return;
    }

    return (
      <TooltipTrigger
        {...triggerOptions}
        text={intl.formatMessage({
          defaultMessage: 'Play',
          description: 'Motion button play',
        })}
      >
        <Button
          type="icon"
          size="custom"
          icon={'#icon-animations-play'}
          onClick={() => {
            if (!editor) {
              return;
            }
            const duration =
              editor.motionPlayer.getMotionDuration(activeMotionId);

            editor.motionPlayer.setLoopSchedule([0, duration]);

            editor.motionPlayer.play();
          }}
        />
      </TooltipTrigger>
    );
  }, [editor, activeMotionId, intl, playing, triggerOptions]);

  const pauseButton = useMemo(() => {
    if (!playing) {
      return;
    }

    return (
      <TooltipTrigger
        {...triggerOptions}
        text={intl.formatMessage({
          defaultMessage: 'Pause',
          description: 'Motion button pause',
        })}
      >
        <Button
          type="icon"
          size="custom"
          icon={'#icon-animations-stop'}
          onClick={() => {
            editor?.motionPlayer.pause();
          }}
        />
      </TooltipTrigger>
    );
  }, [editor, intl, playing, triggerOptions]);

  return (
    <div className={styles.controls}>
      <TooltipTrigger
        {...triggerOptions}
        text={intl.formatMessage({
          description: 'Motion button first keyframe',
          defaultMessage: 'First keyframe',
        })}
      >
        <Button
          type="icon"
          size="custom"
          icon="#icon-animations-first"
          onClick={toFirstKeyframe}
        />
      </TooltipTrigger>
      <TooltipTrigger
        {...triggerOptions}
        text={intl.formatMessage({
          description: 'Motion button prev keyframe',
          defaultMessage: 'Previous keyframe',
        })}
      >
        <Button
          type="icon"
          size="custom"
          icon="#icon-animations-before"
          onClick={toPrevKeyframe}
        />
      </TooltipTrigger>
      {playButton}
      {pauseButton}
      <TooltipTrigger
        {...triggerOptions}
        text={intl.formatMessage({
          description: 'Motion button next keyframe',
          defaultMessage: 'Next keyframe',
        })}
      >
        <Button
          type="icon"
          size="custom"
          icon="#icon-animations-next"
          onClick={toNextKeyframe}
        />
      </TooltipTrigger>
      <TooltipTrigger
        {...triggerOptions}
        text={intl.formatMessage({
          description: 'Motion button last keyframe',
          defaultMessage: 'Last keyframe',
        })}
      >
        <Button
          type="icon"
          size="custom"
          icon="#icon-animations-last"
          onClick={toLastKeyframe}
        />
      </TooltipTrigger>
      <Divider />
      <TooltipTrigger
        {...triggerOptions}
        text={intl.formatMessage({
          description: 'Motion button create keyframe',
          defaultMessage: 'Create keyframe',
        })}
      >
        <Button
          type="icon"
          size="custom"
          icon="#icon-animations-add-frame"
          onClick={addKeyframes}
          disabled={playing}
        />
      </TooltipTrigger>
      <Divider />
      {/* TODO 循环区间的功能暂未实现，先隐藏了 */}
      {/* <Button type="icon" size="custom" icon="#icon-loop" disabled />
      <Divider /> */}
      <div className={styles.time}>{displayTime}</div>
    </div>
  );
}

function Divider() {
  return <div className={styles.divider} />;
}

function formatNumber(num: number) {
  return num < 10 ? `0${num}` : `${num}`;
}
