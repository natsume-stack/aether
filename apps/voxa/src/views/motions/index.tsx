import React, { useCallback, useContext, useMemo } from 'react';
import { Button, useSharedTipsDelay, SharedTipsContext } from '@box/box-design';
import { MotionControls } from './controls';
import { MotionList } from './list';
import styles from './style.module.scss';
import { useIntl } from 'react-intl';
import { useAppSelector } from '../../redux/store';
import { VoxelEditorContext } from '../../internals';
import { MotionsContext, MotionsContextType } from './context';
import { getMotionBoneIds } from '../../models/animator-app/motion-manager/util';
import { HierarchyTimelines } from './hierarchy-timelines';

type MotionPanelProps = {
  height: number;
};

export function MotionPanel(props: MotionPanelProps) {
  const { height } = props;

  const {
    motionsLength,
    activeMotionId,
    activeIds,
    relativeIds,
    hierarchyData,
  } = useAppSelector(({ animator }) => {
    const {
      motionData,
      activeMotionId,
      activeIds,
      relativeIds,
      hierarchyData,
    } = animator;

    return {
      motionsLength: motionData.motionIds.length,
      activeMotionId,
      activeIds,
      relativeIds,
      hierarchyData,
    };
  });

  const { boneIds, activeBoneIds } = useMemo(() => {
    if (activeMotionId) {
      return getMotionBoneIds(activeIds, relativeIds, hierarchyData);
    }

    return {
      boneIds: [],
      activeBoneIds: [],
    };
  }, [activeIds, activeMotionId, relativeIds, hierarchyData]);

  const motionsContextValue: MotionsContextType = {
    boneIds,
    activeBoneIds,
    height,
  };

  const sharedTips = useSharedTipsDelay();

  return (
    <MotionsContext.Provider value={motionsContextValue}>
      <SharedTipsContext.Provider value={sharedTips}>
        <div
          className={styles.motionPanel}
          style={{ height: `${height}px` }}
          onMouseLeave={() => {
            sharedTips.setDisplayed(false);
          }}
        >
          <MotionControls />
          <MotionList />
          <HierarchyTimelines />
          {motionsLength === 0 && <CreateMotionCover />}
        </div>
      </SharedTipsContext.Provider>
    </MotionsContext.Provider>
  );
}

/**
 * 动作列表为空时，覆盖在面板上的创建动作遮罩
 */
function CreateMotionCover() {
  const intl = useIntl();

  const editor = useContext(VoxelEditorContext);

  const onClick = useCallback(() => {
    if (!editor) {
      return;
    }

    editor.animatorApp.motionManager.addMotion();
  }, [editor]);

  return (
    <div className={styles.cover}>
      <Button type="primary" icon="#icon-secondary-add" onClick={onClick}>
        {intl.formatMessage({
          description: 'Create motion when animation is empty',
          defaultMessage: 'Create motion',
        })}
      </Button>
    </div>
  );
}
