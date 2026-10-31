import React, {
  ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
} from 'react';
import { useIntl } from 'react-intl';
import { useDispatch } from 'react-redux';
import {
  Button,
  TooltipTrigger,
  Select,
  useSharedTipsDelay,
} from '@box/box-design';
import { IconAnalytics, IconBigbox } from '@box/icons';
import { useAppSelector } from '../../redux/store';
import { VoxelEditorContext } from '../../internals';
import { UndoRedoButtons } from './undo-redo';
import style from './style.module.scss';
import { AppMode } from '../../redux/app-slice';
import { setVoxelGridVisible } from '../../redux/editing-slice';
import { DIMENSION_CAMERA_DIR } from '../../utils/math';
import { AnimatorMode, setModelBoxVisible } from '../../redux/animator-slice';

type BottomBarProps = {
  type: AppMode;
};

enum CameraType {
  Perspective = 'perspective',
  Orthogonal = 'orthogonal',
}

enum VoxelEdge {
  Hide = 'hide',
  Show = 'show',
}

export const OFFSET_Y = -4;

/**
 * 编辑器的底部栏，体素编辑模式下，包括:
 * > left side
 *   > screenshot[暂时隐藏]
 *   > undo
 *   > redo
 * > right side
 *   > perspective selection
 *   > show/hide edges
 *   > toggle grid
 *   > reset camera
 */
export function BottomBar(props: BottomBarProps) {
  const editor = useContext(VoxelEditorContext);

  const [showModelBackground, setShowModelBackground] = useState(true);
  const [showVoxelGrid, setShowVoxelGrid] = useState(false);

  const {
    animatorGridVisible,
    boxesVisible,
    skeletonVisible,
    emissive,
    dimension,
    profilerEnabled,
    animatorMode,
    modelBoxVisible,
  } = useAppSelector((state) => {
    return {
      animatorGridVisible: state.animator.gridVisible,
      boxesVisible: state.animator.boxesVisible,
      skeletonVisible: state.animator.skeletonVisible,
      emissive: state.animator.emissive,
      dimension: state.editing.dimension,
      profilerEnabled: state.app.profilerEnabled,
      animatorMode: state.animator.mode,
      modelBoxVisible: state.animator.modelBoxVisible,
    };
  });

  const dispatch = useDispatch();

  const { delay, setDisplayed } = useSharedTipsDelay();

  const onPopupVisibleChange = useCallback(
    (visible: boolean) => {
      visible && setDisplayed(visible);
    },
    [setDisplayed],
  );

  const intl = useIntl();

  const toggleModelBackground = useMemo(() => {
    function onClick() {
      if (!editor) {
        return;
      }
      setShowModelBackground(!showModelBackground);
      editor.voxelApp.toggleModelBackground(!showModelBackground);
    }

    return (
      <TooltipTrigger
        className={style.tooltip}
        text={intl.formatMessage({
          description: 'Display Background Objects',
          defaultMessage: 'Display Background Objects',
        })}
        placement="top"
        align={{ offset: [0, OFFSET_Y] }}
        delay={delay}
        onPopupVisibleChange={onPopupVisibleChange}
      >
        <Button
          className={style.btn}
          size="small"
          type="icon"
          icon="#icon-background-model"
          activated={showModelBackground}
          onClick={onClick}
        />
      </TooltipTrigger>
    );
  }, [delay, editor, intl, onPopupVisibleChange, showModelBackground]);

  const toggleVoxelGridButton = useMemo(() => {
    function onClick() {
      if (!editor) {
        return;
      }
      setShowVoxelGrid((showVoxelGrid) => !showVoxelGrid);
      editor.voxelApp.boundary.toggleGrid(!showVoxelGrid);
    }

    return (
      <TooltipTrigger
        className={style.tooltip}
        text={intl.formatMessage({
          description: 'Grids',
          defaultMessage: 'Grids',
        })}
        placement="top"
        align={{ offset: [0, OFFSET_Y] }}
        delay={delay}
        onPopupVisibleChange={onPopupVisibleChange}
      >
        <Button
          className={style.btn}
          size="small"
          type="icon"
          icon="#icon-secondary-grid-voxal"
          activated={showVoxelGrid}
          onClick={onClick}
        />
      </TooltipTrigger>
    );
  }, [delay, editor, intl, onPopupVisibleChange, showVoxelGrid]);

  const resetCameraButton = useMemo(() => {
    function onclick() {
      if (!editor) {
        return;
      }

      if (props.type === AppMode.Animator) {
        editor.animatorApp.resetCamera();
        return;
      }

      editor.stage.resetCamera({
        cameraDir: DIMENSION_CAMERA_DIR[dimension],
      });
    }

    return (
      <TooltipTrigger
        className={style.tooltip}
        text={intl.formatMessage({
          description: 'RecenterCamera',
          defaultMessage: 'Recenter camera',
        })}
        placement="topRight"
        align={{ offset: [0, OFFSET_Y] }}
        delay={delay}
        onPopupVisibleChange={onPopupVisibleChange}
      >
        <Button
          className={style.btn}
          size="small"
          type="icon"
          icon="#icon-secondary-location"
          onClick={onclick}
        />
      </TooltipTrigger>
    );
  }, [delay, editor, intl, onPopupVisibleChange, props.type, dimension]);

  const [cameraType, setCameraType] = useState<string>(() => {
    if (!editor) {
      return CameraType.Perspective;
    }

    return editor.stage.getCamera() === editor.stage.perspectiveCamera
      ? CameraType.Perspective
      : CameraType.Orthogonal;
  });

  const cameraSelector = useMemo<ReactNode>(() => {
    const selections = [
      {
        id: CameraType.Perspective,
        text: intl.formatMessage({
          description: 'Perspective Camera',
          defaultMessage: 'Perspective',
        }),
      },
      {
        id: CameraType.Orthogonal,
        text: intl.formatMessage({
          description: 'Orthogonal Camera',
          defaultMessage: 'Orthogonal',
        }),
      },
    ];

    return (
      <Select
        className={style.dropDown}
        placement="top"
        align={{ offset: [0, 0] }}
        items={selections}
        selection={cameraType}
        onSelect={({ id }) => {
          if (typeof id !== 'string') {
            return;
          }

          editor?.stage.switchCameraMode(id === CameraType.Perspective);
          setCameraType(id);
        }}
      />
    );
  }, [editor, intl, cameraType]);

  const [voxelEdge, setVoxelEdge] = useState<string>(() => {
    if (!editor) {
      return VoxelEdge.Hide;
    }

    return editor.voxelApp.models.destination._renderGrid
      ? VoxelEdge.Show
      : VoxelEdge.Hide;
  });

  const voxelEdgeSelector = useMemo<ReactNode>(() => {
    const selections = [
      {
        id: VoxelEdge.Hide,
        text: intl.formatMessage({
          description: 'Hide Voxel Edges',
          defaultMessage: 'Hide Edges',
        }),
      },
      {
        id: VoxelEdge.Show,
        text: intl.formatMessage({
          description: 'Show Voxel Edges',
          defaultMessage: 'Show Edges',
        }),
      },
    ];

    return (
      <Select
        className={style.dropDown}
        placement="top"
        align={{ offset: [0, 0] }}
        items={selections}
        selection={voxelEdge}
        onSelect={({ id }) => {
          if (typeof id !== 'string') {
            return;
          }

          const voxelGridVisible = id === VoxelEdge.Show;

          editor?.voxelApp.models.toggleGrid(voxelGridVisible);

          dispatch(setVoxelGridVisible({ voxelGridVisible }));

          setVoxelEdge(id);
        }}
      />
    );
  }, [editor, intl, dispatch, voxelEdge]);

  const toggleEmissiveButton = useMemo<ReactNode>(() => {
    if (animatorMode === AnimatorMode.HitBox) {
      return;
    }
    function onClick() {
      if (!editor) {
        return;
      }
      editor.animatorApp.toggleEmissive(!emissive);
    }

    return (
      <TooltipTrigger
        className={style.tooltip}
        text={intl.formatMessage({
          description: 'Animator emissive button',
          defaultMessage: 'Emissive',
        })}
        placement="top"
        align={{ offset: [0, OFFSET_Y] }}
        delay={delay}
        onPopupVisibleChange={onPopupVisibleChange}
      >
        <Button
          className={style.btn}
          size="small"
          type="icon"
          icon="#icon-secondary-light"
          activated={emissive}
          onClick={onClick}
        />
      </TooltipTrigger>
    );
  }, [animatorMode, intl, delay, onPopupVisibleChange, emissive, editor]);

  const toggleSkeletonButton = useMemo<ReactNode>(() => {
    if (animatorMode === AnimatorMode.HitBox) {
      return;
    }
    function onClick() {
      if (!editor) {
        return;
      }
      editor.animatorApp.toggleSkeleton(!skeletonVisible);
    }
    return (
      <TooltipTrigger
        className={style.tooltip}
        text={intl.formatMessage({
          description: 'Animator skeleton button',
          defaultMessage: 'Skeleton',
        })}
        placement="top"
        align={{ offset: [0, OFFSET_Y] }}
        delay={delay}
        onPopupVisibleChange={onPopupVisibleChange}
      >
        <Button
          className={style.btn}
          size="small"
          type="icon"
          icon="#icon-secondary-no-joint"
          activated={skeletonVisible}
          onClick={onClick}
        />
      </TooltipTrigger>
    );
  }, [
    animatorMode,
    intl,
    delay,
    onPopupVisibleChange,
    skeletonVisible,
    editor,
  ]);

  const toggleSkinPartBoxButton = useMemo<ReactNode>(() => {
    if (animatorMode === AnimatorMode.HitBox) {
      return;
    }
    function onClick() {
      if (!editor) {
        return;
      }
      editor.animatorApp.toggleBoxes(!boxesVisible);
    }

    return (
      <TooltipTrigger
        className={style.tooltip}
        text={intl.formatMessage({
          description: 'Animator skin skinNodes box button',
          defaultMessage: 'Bounding box',
        })}
        placement="top"
        align={{ offset: [0, OFFSET_Y] }}
        delay={delay}
        onPopupVisibleChange={onPopupVisibleChange}
      >
        <Button
          className={style.btn}
          size="small"
          type="icon"
          icon="#icon-secondary-no-grid"
          activated={boxesVisible}
          onClick={onClick}
        />
      </TooltipTrigger>
    );
  }, [animatorMode, intl, delay, onPopupVisibleChange, boxesVisible, editor]);

  const toggleModelBoxButton = useMemo<ReactNode>(() => {
    if (animatorMode !== AnimatorMode.HitBox) {
      return;
    }
    function onClick() {
      dispatch(setModelBoxVisible(!modelBoxVisible));
    }

    return (
      <TooltipTrigger
        className={style.tooltip}
        text={intl.formatMessage({
          description: 'Animator Default hit box button',
          defaultMessage: 'Model box',
        })}
        placement="top"
        align={{ offset: [0, OFFSET_Y] }}
        delay={delay}
        onPopupVisibleChange={onPopupVisibleChange}
      >
        <Button
          className={style.btn}
          size="small"
          type="icon"
          icon={<IconBigbox />}
          activated={modelBoxVisible}
          onClick={onClick}
        />
      </TooltipTrigger>
    );
  }, [
    animatorMode,
    intl,
    delay,
    onPopupVisibleChange,
    modelBoxVisible,
    dispatch,
  ]);

  const toggleAnimatorGridButton = useMemo<ReactNode>(() => {
    function onClick() {
      if (!editor) {
        return;
      }
      editor.animatorApp.toggleGrid(!animatorGridVisible);
    }

    return (
      <TooltipTrigger
        className={style.tooltip}
        text={intl.formatMessage({
          description: 'Animator grid button',
          defaultMessage: 'Ground',
        })}
        placement="top"
        align={{ offset: [0, OFFSET_Y] }}
        delay={delay}
        onPopupVisibleChange={onPopupVisibleChange}
      >
        <Button
          className={style.btn}
          size="small"
          type="icon"
          icon="#icon-secondary-grid"
          activated={animatorGridVisible}
          onClick={onClick}
        />
      </TooltipTrigger>
    );
  }, [editor, animatorGridVisible, onPopupVisibleChange, intl, delay]);

  const toggleProfilerButton = useMemo(() => {
    return (
      <TooltipTrigger
        className={style.tooltip}
        text={intl.formatMessage({
          description: 'Animator profiler button',
          defaultMessage: 'Profiler',
        })}
        placement="top"
        align={{ offset: [0, OFFSET_Y] }}
        delay={delay}
      >
        <Button
          className={style.btn}
          size="small"
          type="icon"
          icon={<IconAnalytics />}
          activated={profilerEnabled}
          onClick={() => {
            editor?.toggleProfiler(!profilerEnabled);
          }}
        />
      </TooltipTrigger>
    );
  }, [editor, profilerEnabled, delay, intl]);

  const voxelBar = () => {
    return (
      <div className={style.rightSide}>
        {cameraSelector}
        {voxelEdgeSelector}
        {toggleModelBackground}
        {toggleVoxelGridButton}
        {resetCameraButton}
      </div>
    );
  };

  const animatorBar = () => {
    return (
      <div className={style.rightSide}>
        {cameraSelector}
        {toggleProfilerButton}
        {toggleEmissiveButton}
        {toggleSkeletonButton}
        {toggleSkinPartBoxButton}
        {toggleModelBoxButton}
        {toggleAnimatorGridButton}
        {resetCameraButton}
      </div>
    );
  };

  return (
    <div className={style.bottomBar} onMouseLeave={() => setDisplayed(false)}>
      <div className={style.leftSide}>
        <UndoRedoButtons triggerOptions={{ delay, onPopupVisibleChange }} />
      </div>
      <div className={style.scrollBar}>
        {props.type === AppMode.Voxel ? voxelBar() : animatorBar()}
      </div>
    </div>
  );
}
