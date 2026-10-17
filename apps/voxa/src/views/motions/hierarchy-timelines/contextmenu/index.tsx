import { useCallback, useContext, useMemo } from 'react';
import { IntlShape, useIntl } from 'react-intl';
import { Button, SerializedVec2 } from '@box/box-design';
import {
  InterpolationType,
  MotionKeyframe,
  MotionNode,
  NodeKeyframeIds,
  ProjectInterpolationType,
  setKeyframesInterpolation,
} from '../../../../redux/animator-slice';
import { ContextMenu, ContextmenuData } from '../../../contextmenu';
import styles from './style.module.scss';
import { INTERPOLATION_TO_ICON } from '../../../const';
import { store, useAppSelector } from '../../../../redux/store';
import { VoxelEditorContext } from '../../../../internals';
import { parseNodeKeyframeTimes } from '../../../../models/animator-app/motion-manager/util';
import type { VoxelEditor } from 'apps/voxa/src/models/editor';
import { MotionsContext } from '../../context';
import { TimelineContext } from '../context';

export type ContextMenuProps = {
  position?: SerializedVec2;
  onBlur: () => void;
};

export function TimelineContextMenu(props: ContextMenuProps) {
  const { position, onBlur } = props;

  const { motionId, motion, selectedKeyframes, currentTime } = useAppSelector(
    ({ app, animator }) => {
      const { activeMotionId, motionData, activeKeyframes } = animator;

      return {
        motionId: activeMotionId,
        motion: motionData.motions[activeMotionId],
        selectedKeyframes: activeKeyframes,
        currentTime: app.motionPanel.currentTime,
      };
    },
  );

  const nodes = motion?.nodes;

  const editor = useContext(VoxelEditorContext);

  const intl = useIntl();

  const { boneIds } = useContext(MotionsContext);

  const { calculateFrameByClientX } = useContext(TimelineContext);

  const onSelectInterpolation = useCallback(
    (
      nodeKeyframeIds: NodeKeyframeIds,
      motionId: string,
      type: InterpolationType,
    ) => {
      if (!editor) {
        return;
      }

      editor.history.saveAction({
        action: setKeyframesInterpolation({
          nodeKeyframeIds,
          type,
          motionId,
        }),
      });

      editor.animatorApp.motionManager.poseAtTime(currentTime);
    },
    [editor, currentTime],
  );

  const onContextMenuSelect = useCallback(
    (id: string) => {
      if (!editor) {
        return;
      }

      switch (id) {
        case ContextMenuId.Copy:
          onCopyKeyframes(editor);
          break;
        case ContextMenuId.Paste:
          position &&
            onPasteKeyframes(
              editor,
              boneIds,
              calculateFrameByClientX(position[0]),
            );
          break;
        case ContextMenuId.Delete:
          onRemoveKeyframes(editor);
          break;
      }
    },
    [editor, boneIds, calculateFrameByClientX, position],
  );

  return useMemo(() => {
    if (!nodes || !position || !editor) {
      return null;
    }

    const data = getContextMenuData(intl, editor, selectedKeyframes);

    if (data.length === 0) {
      return null;
    }

    // 只要右键菜单有内容，中断播放
    editor?.motionPlayer.pause();

    const { isAllChannels, curInterpolation, ids } =
      getInterpolationSelectorParams(selectedKeyframes, nodes);

    const extra = isAllChannels ? (
      <InterpolationSelector
        selectedInterpolation={curInterpolation}
        onSelect={(type) => {
          onSelectInterpolation(ids, motionId, type);
          onBlur();
        }}
      />
    ) : undefined;

    return (
      <ContextMenu
        className={styles.contextMenu}
        position={position}
        data={data}
        onSelect={onContextMenuSelect}
        onBlur={onBlur}
        extra={extra}
      />
    );
  }, [
    selectedKeyframes,
    nodes,
    intl,
    onSelectInterpolation,
    motionId,
    position,
    onBlur,
    onContextMenuSelect,
    editor,
  ]);
}

enum ContextMenuId {
  Copy = 'copy',
  Paste = 'paste',
  Delete = 'delete',
}

export function getContextMenuData(
  intl: IntlShape,
  editor: VoxelEditor,
  nodeKeyframeTimes: NodeKeyframeIds,
) {
  const hasSelection = Object.values(nodeKeyframeTimes).some(
    (timeList) => timeList && timeList.length > 0,
  );

  // TODO 判断是否有复制粘贴
  const hasCopyData = !!editor.animatorApp.motionManager.getKeyframeClipboard();

  const list: (ContextmenuData | false)[] = [
    hasSelection && {
      id: ContextMenuId.Copy,
      text: intl.formatMessage({
        description: 'Timeline context menu copy',
        defaultMessage: 'Copy',
      }),
    },
    hasCopyData && {
      id: ContextMenuId.Paste,
      text: intl.formatMessage({
        description: 'Timeline context menu paste',
        defaultMessage: 'Paste',
      }),
    },
    hasSelection && {
      id: ContextMenuId.Delete,
      text: intl.formatMessage({
        description: 'Timeline context menu delete',
        defaultMessage: 'Delete',
      }),
    },
  ];

  return list.filter((item): item is ContextmenuData => !!item);
}

function onCopyKeyframes(editor: VoxelEditor) {
  const { activeMotionId, activeKeyframes } = store.getState().animator;

  editor.animatorApp.motionManager.updateKeyframeClipboard(
    activeMotionId,
    activeKeyframes,
  );
}

function onPasteKeyframes(
  editor: VoxelEditor,
  boneIds: string[],
  frame: number,
) {
  const { app, animator } = store.getState();
  const { activeMotionId } = animator;

  editor.animatorApp.motionManager.pasteKeyframes(
    activeMotionId,
    boneIds,
    frame,
  );
}

function onRemoveKeyframes(editor: VoxelEditor) {
  editor.animatorApp.motionManager.removeActiveKeyframes();
}

const INTERPOLATIONS = [
  ProjectInterpolationType.Linear,
  ProjectInterpolationType.Step,
  ProjectInterpolationType.EaseInSine,
  ProjectInterpolationType.EaseOutSine,
  ProjectInterpolationType.EaseInOutSine,
];

export function InterpolationSelector(props: {
  /**
   * 高亮当前选中的补帧方式，如果是undefined全部不高亮
   * 用于处理右键菜单的场景：
   * 如果全都一样，则是选中的一样的那个
   * 如果有不一样，则不显示选中
   */
  selectedInterpolation?: InterpolationType;
  onSelect: (type: InterpolationType) => void;
}) {
  const { selectedInterpolation, onSelect } = props;

  const intl = useIntl();

  const types = INTERPOLATIONS.map((type) => {
    const className =
      type === selectedInterpolation ? styles.selected : undefined;

    return (
      <Button
        key={type}
        className={className}
        type="icon"
        icon={INTERPOLATION_TO_ICON[type]}
        onMouseDown={(evt) => {
          // 防止按钮focus触发contextMenu的blur
          evt.preventDefault();
        }}
        onClick={() => {
          onSelect(type);
        }}
      />
    );
  });

  return (
    <div
      className={styles.interpolationSelector}
      onClick={(evt) => evt.stopPropagation()}
    >
      <div className={styles.title}>
        {intl.formatMessage({
          description: 'Title of animation interpolation selector',
          defaultMessage: 'Animation',
        })}
      </div>
      <div className={styles.types}>{types}</div>
    </div>
  );
}

function getInterpolationSelectorParams(
  selectedKeyframes: NodeKeyframeIds,
  nodes: Record<string, MotionNode>,
) {
  // 用来判断传给右键菜单的“当前选中的补帧方式”
  let tempInterpolation: InterpolationType | undefined | 'mixed';

  const ids: NodeKeyframeIds = {};

  // 判断选中内容全部都是帧段
  let isAllChannels = Object.keys(selectedKeyframes).every((nodeId) => {
    const idList = selectedKeyframes[nodeId];

    if (!idList || !nodes[nodeId]) {
      return true;
    }

    const { keyframes } = nodes[nodeId];

    const nodeKeyframes = parseNodeKeyframeTimes(nodes, { [nodeId]: idList });

    const keyframeList = nodeKeyframes[nodeId];

    if (!keyframeList) {
      return true;
    }

    ids[nodeId] = [];

    return keyframeList.every(({ time }) => {
      const keyframe = keyframes[time];

      if (!keyframe) {
        return false;
      }

      // 检查该关键帧的下一个关键帧是否也被选中
      if (!includesTime(keyframe.nextTime, keyframeList)) {
        // 如果没选中，判断上一个关键帧是否选中，如果选中则不需要结束every
        return includesTime(keyframe.prevTime, keyframeList);
      }

      ids[nodeId].push(keyframe.id);

      tempInterpolation = getInterpolation(
        tempInterpolation,
        keyframe.interpolation,
      );

      return true;
    });
  });

  // 如果没有任何有效的选中数据，firstInterpolation会是undefined
  isAllChannels = isAllChannels && tempInterpolation !== undefined;

  const curInterpolation =
    tempInterpolation !== 'mixed' ? tempInterpolation : undefined;

  return { isAllChannels, curInterpolation, ids };
}

function includesTime(time: number | undefined, list?: MotionKeyframe[]) {
  return (
    time !== undefined &&
    list?.find(({ time: keyframeTime }) => keyframeTime === time)
  );
}

function getInterpolation(
  a: InterpolationType | 'mixed' | undefined,
  b: InterpolationType,
) {
  if (a === undefined) {
    return b;
  } else if (a !== b) {
    return 'mixed';
  } else {
    return a;
  }
}
