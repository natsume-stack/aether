import React, {
  ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useDispatch } from 'react-redux';
import { useIntl } from 'react-intl';
import {
  Button,
  Input,
  AxisInputs,
  AxisButtons,
  Toast,
  Icon,
  AxisType,
  TooltipOptions,
  TooltipTrigger,
  TooltipTriggerOptions,
  TriggerOptions,
  useSharedTipsDelay,
  Tabs,
  TabPanel,
} from '@box/box-design';
import { IconAxisAnchor } from '@box/icons';
import { VoxelEditorContext } from '../../internals';
import { useAppSelector } from '../../redux/store';
import { AppMode, EditType, setProjectName } from '../../redux/app-slice';
import { setMirrorMode } from '../../redux/editing-slice';
import { FileMenu } from '../file-menu';
import { SaveButton } from './save-button';
import { useFocusTrap } from '../hooks';
import { SerializedVec3, voxelShapeToObjSize } from '../../utils/math';
import { isValidName, MAX_NAME_LENGTH, MAX_VOXEL_SIZE } from '../../defs';
import { AnimatorModeButtons } from './animator-mode-btns';
import { hasBoneWithoutSkin } from '../../models/animator-app/util';
import {
  AnimatorMode,
  HitBoxMode,
  PivotMode,
  ToolType,
} from '../../redux/animator-slice';
import { VoxelDimension } from '../../models/project/defs';
import styles from './style.module.scss';

type TopBarProps = {
  type: AppMode;
};

const AXIS_TO_INDEX = {
  X: 0,
  Y: 1,
  Z: 2,
};

/**
 * 编辑器的导航栏
 */
export function NavBar(props: TopBarProps) {
  const intl = useIntl();
  const editor = useContext(VoxelEditorContext);
  const { workspaceSize, dimension, mirrorMode, animationPermission, isAdmin } =
    useAppSelector(({ editing, permission, app }) => {
      const { workspaceSize, dimension, mirrorMode } = editing;

      return {
        workspaceSize,
        dimension,
        mirrorMode,
        animationPermission: permission.editAnimations,
        isAdmin: app.userInfo.isAdmin,
      };
    });
  const { parentType, projectName, editType } = useAppSelector(({ app }) => ({
    parentType: app.parentType,
    projectName: app.projectName,
    editType: app.editType,
  }));
  const dispatch = useDispatch();

  const [showFileMenu, setShowFileMenu] = useState(false);

  const { delay, setDisplayed } = useSharedTipsDelay();

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
      placement: 'bottomLeft',
      align: { offset: [0, 4] },
    };
  }, [delay, onPopupVisibleChange]);

  // 翻转按钮的tooltip，体素编辑和动画编辑的都一样。
  const flipButtonsTooltips: TooltipOptions[] = useMemo(
    () => [
      {
        title: intl.formatMessage({
          description: `Flip X Button Tooltip Title`,
          defaultMessage: `Flip X`,
        }),
        text: intl.formatMessage({
          description: `Flip X Button Tooltip Text`,
          defaultMessage: `Flip along the X-axis`,
        }),
        ...triggerOptions,
      },
      {
        title: intl.formatMessage({
          description: `Flip Y Button Tooltip Title`,
          defaultMessage: `Flip Y`,
        }),
        text: intl.formatMessage({
          description: `Flip Y Button Tooltip Text`,
          defaultMessage: `Flip along the Y-axis`,
        }),
        ...triggerOptions,
      },
      {
        title: intl.formatMessage({
          description: `Flip Z Button Tooltip Title`,
          defaultMessage: `Flip Z`,
        }),
        text: intl.formatMessage({
          description: `Flip Z Button Tooltip Text`,
          defaultMessage: `Flip along the Z-axis`,
        }),
        ...triggerOptions,
      },
    ],
    [intl, triggerOptions],
  );

  const homeButtons = useMemo(() => {
    if (!editor) {
      return;
    }

    const buttons: ReactNode[] = [];

    if (parentType === 'engine') {
      buttons.push(
        <Button
          key="close"
          className={styles.fileMenuBtn}
          type="icon"
          icon={'#icon-secondary-delete'}
          onClick={() => {
            editor.iframeTool.emitCloseEvent();
          }}
        />,
      );

      // 如果是嵌套在引擎中，又不是管理员，直接返回
      if (!isAdmin) {
        return buttons;
      }
    }

    const button = (
      <Button
        className={styles.fileMenuBtn}
        type="icon"
        icon={'#icon-secondary-general'}
        onClick={() => {
          setShowFileMenu(true);
        }}
      />
    );

    buttons.push(
      <TooltipTrigger
        key="fileMenu"
        className={styles.tooltip}
        text={intl.formatMessage({
          description: `Home Button Tooltip Text`,
          defaultMessage: `Home`,
        })}
        {...triggerOptions}
      >
        {button}
      </TooltipTrigger>,
    );

    return buttons;
  }, [editor, intl, triggerOptions, parentType, isAdmin]);

  const mirrorButtons = useMemo(() => {
    function mirrorHandler(axis: AxisType) {
      const show = !mirrorMode[axis];

      editor?.voxelApp.toggleMirrorPlane(axis, show);

      dispatch(
        setMirrorMode({
          mirrorMode: {
            ...mirrorMode,
            [axis]: show,
          },
        }),
      );
    }

    const tooltips: TooltipTriggerOptions[] = [
      {
        title: intl.formatMessage({
          description: `Mirror X Button Tooltip Title`,
          defaultMessage: `Mirror X`,
        }),
        text: intl.formatMessage({
          description: `Mirror X Button Tooltip Text`,
          defaultMessage: `Toggle mirror on X-axis`,
        }),
        ...triggerOptions,
      },
      {
        title: intl.formatMessage({
          description: `Mirror Y Button Tooltip Title`,
          defaultMessage: `Mirror Y`,
        }),
        text: intl.formatMessage({
          description: `Mirror Y Button Tooltip Text`,
          defaultMessage: `Toggle mirror on Y-axis`,
        }),
        ...triggerOptions,
      },
      {
        title: intl.formatMessage({
          description: `Mirror Z Button Tooltip Title`,
          defaultMessage: `Mirror Z`,
        }),
        text: intl.formatMessage({
          description: `Mirror Z Button Tooltip Text`,
          defaultMessage: `Toggle mirror on Z-axis`,
        }),
        ...triggerOptions,
      },
    ];

    return (
      <div className={styles.tool}>
        <div>
          {intl.formatMessage({
            description: 'Mirror Buttons',
            defaultMessage: 'Mirror',
          })}
        </div>
        <AxisButtons
          className={styles.axisButtons}
          background={true}
          activated={mirrorMode}
          handler={mirrorHandler}
          tooltips={tooltips}
        />
      </div>
    );
  }, [intl, mirrorMode, editor, dispatch, triggerOptions]);

  const rotateButtons = useMemo(() => {
    function rotateHandler(axis: AxisType) {
      editor && editor.voxelApp.veController.rotate(axis);
    }

    function axisDisabled(axis: number) {
      if (dimension === VoxelDimension.XYZ) {
        return false;
      }
      return axis !== dimension;
    }

    const tooltips: TooltipOptions[] = [
      {
        title: intl.formatMessage({
          description: `Rotate X Button Tooltip Title`,
          defaultMessage: `Rotate X`,
        }),
        text: intl.formatMessage({
          description: `Rotate X Button Tooltip Text`,
          defaultMessage: `Rotate 90° around X-axis`,
        }),
        ...triggerOptions,
      },
      {
        title: intl.formatMessage({
          description: `Rotate Y Button Tooltip Title`,
          defaultMessage: `Rotate Y`,
        }),
        text: intl.formatMessage({
          description: `Rotate Y Button Tooltip Text`,
          defaultMessage: `Rotate 90° around Y-axis`,
        }),
        ...triggerOptions,
      },
      {
        title: intl.formatMessage({
          description: `Rotate Z Button Tooltip Title`,
          defaultMessage: `Rotate Z`,
        }),
        text: intl.formatMessage({
          description: `Rotate Z Button Tooltip Text`,
          defaultMessage: `Rotate 90° around Z-axis`,
        }),
        ...triggerOptions,
      },
    ];

    return (
      <div className={styles.tool}>
        <div>
          {intl.formatMessage({
            description: 'Rotate Buttons',
            defaultMessage: 'Rotate',
          })}
        </div>
        <AxisButtons
          className={styles.axisButtons}
          disabled={[axisDisabled(0), axisDisabled(1), axisDisabled(2)]}
          handler={rotateHandler}
          tooltips={tooltips}
        />
      </div>
    );
  }, [editor, dimension, intl, triggerOptions]);

  const voxelFlipButtons = useMemo(() => {
    function flipHandler(axis: AxisType) {
      editor && editor.voxelApp.veController.flip(axis);
    }

    return (
      <div className={styles.tool}>
        <div>
          {intl.formatMessage({
            description: 'Flip Buttons',
            defaultMessage: 'Flip',
          })}
        </div>
        <AxisButtons
          className={styles.axisButtons}
          handler={flipHandler}
          tooltips={flipButtonsTooltips}
        />
      </div>
    );
  }, [editor, intl, flipButtonsTooltips]);

  const sizeInput = useMemo(() => {
    function onSizeChange(newSize: SerializedVec3) {
      if (!editor) {
        return;
      }

      editor.voxelApp.updateSpaceSize([newSize[0], newSize[1], newSize[2]]);
    }

    function onTrim() {
      if (!editor) {
        return;
      }

      editor.voxelApp.veController.deSelect();

      if (editor.voxelApp.models.destination.isEmpty()) {
        Toast.info({
          content: intl.formatMessage({
            description: 'Trim Without Model Toast',
            defaultMessage: 'Cannot trim bounding area without model',
          }),
        });
        return;
      }

      editor.voxelApp.trimSpace();
    }

    const trimButton = (
      <TooltipTrigger
        className={styles.tooltip}
        title={intl.formatMessage({
          description: 'Trim Button Tooltip Title',
          defaultMessage: 'Trim',
        })}
        text={intl.formatMessage({
          description: 'Trim Button Tooltip Text',
          defaultMessage: 'Shrink bounding box to fit voxels',
        })}
        {...triggerOptions}
        align={{ offset: [0, 5] }}
      >
        <Button
          className={styles.btn}
          type="icon"
          icon="#icon-general-cut"
          background={true}
          onClick={onTrim}
        />
      </TooltipTrigger>
    );

    return (
      <div className={styles.size}>
        <div>
          {intl.formatMessage({
            description: 'Workspace Size Inputs',
            defaultMessage: 'Size',
          })}
        </div>
        <AxisInputs
          className={styles.axisInputs}
          vec3Value={voxelShapeToObjSize(workspaceSize, dimension)}
          min={0}
          max={MAX_VOXEL_SIZE}
          onConfirm={onSizeChange}
        />
        {trimButton}
      </div>
    );
  }, [dimension, editor, intl, triggerOptions, workspaceSize]);

  const skinTitle = useMemo(() => {
    return (
      <>
        <Icon symbolId="#icon-skin" />
        <div className={styles.skinTitle}>
          {intl.formatMessage({
            description: 'Skin mode title',
            defaultMessage: 'Avatar',
          })}
        </div>
      </>
    );
  }, [intl]);

  const { pivotMode, toolAxis, activeIds, mode, toolType, hitBoxMode } =
    useAppSelector((state) => state.animator);

  const isPivotMode = pivotMode !== PivotMode.None;

  const animatorFlipButtons = useMemo(() => {
    function flipHandler(axis: AxisType) {
      editor?.animatorApp.nodeManager.flipSkinParts(AXIS_TO_INDEX[axis]);
    }

    return (
      <div className={styles.tool}>
        <div>
          {intl.formatMessage({
            description: 'Flip Buttons',
            defaultMessage: 'Flip',
          })}
        </div>
        <AxisButtons
          className={styles.axisButtons}
          handler={flipHandler}
          disabled={isPivotMode || hasBoneWithoutSkin(activeIds)}
          tooltips={flipButtonsTooltips}
        />
      </div>
    );
  }, [editor, intl, isPivotMode, activeIds, flipButtonsTooltips]);

  /**
   * 多部件 - Setup - 中心点模式按钮
   */
  const pivotAxis = useMemo(() => {
    {
      if (mode !== AnimatorMode.Setup) {
        return;
      }

      const skinNodePivotDisabled =
        pivotMode === PivotMode.Model ||
        activeIds.length > 1 ||
        (!!activeIds.length && hasBoneWithoutSkin([activeIds[0]]));

      let modelPivot: ReactNode;

      if (editType === EditType.Normal) {
        modelPivot = (
          <>
            <TooltipTrigger
              className={styles.tooltip}
              title={intl.formatMessage({
                description: 'Animator model pivot mode button title',
                defaultMessage: 'Model Pivot Tool',
              })}
              text={intl.formatMessage({
                description: 'Animator model pivot mode button description',
                defaultMessage: 'Set origin of the model',
              })}
              {...triggerOptions}
            >
              <Button
                className={styles.btn}
                type="icon"
                icon={<IconAxisAnchor />}
                activated={pivotMode === PivotMode.Model}
                disabled={pivotMode === PivotMode.SkinNode}
                background={true}
                onClick={() => {
                  const mode =
                    pivotMode === PivotMode.Model
                      ? PivotMode.None
                      : PivotMode.Model;

                  editor?.animatorApp.setPivotMode(mode);
                }}
              />
            </TooltipTrigger>
            {gap(4)}
          </>
        );
      }

      return (
        <>
          {gap(20)}
          {modelPivot}
          <TooltipTrigger
            className={styles.tooltip}
            title={intl.formatMessage({
              description: 'Animator pivot mode button title',
              defaultMessage: 'Pivot Tool',
            })}
            text={intl.formatMessage({
              description: 'Animator pivot mode button description',
              defaultMessage: 'Set origin of the object/group',
            })}
            {...triggerOptions}
          >
            <Button
              className={styles.btn}
              type="icon"
              icon="#icon-tool-axis"
              activated={pivotMode === PivotMode.SkinNode}
              disabled={skinNodePivotDisabled}
              background={true}
              onClick={() => {
                const mode =
                  pivotMode === PivotMode.SkinNode
                    ? PivotMode.None
                    : PivotMode.SkinNode;

                editor?.animatorApp.setPivotMode(mode);
              }}
            />
          </TooltipTrigger>
        </>
      );
    }
  }, [activeIds, editor, editType, intl, mode, pivotMode, triggerOptions]);

  const axisTool = useMemo(() => {
    return (
      <div className={styles.axis}>
        <TooltipTrigger
          className={styles.tooltip}
          title={intl.formatMessage({
            description: 'Animator local axis mode button title',
            defaultMessage: 'Local Mode',
          })}
          text={intl.formatMessage({
            description: 'Animator local axis mode button description',
            defaultMessage: 'Adjust coordinate in local mode',
          })}
          {...triggerOptions}
        >
          <Button
            className={styles.btn}
            type="icon"
            icon="#icon-tool-object-axis"
            activated={toolAxis === 'local'}
            disabled={isPivotMode}
            background={true}
            onClick={() =>
              editor?.animatorApp.nodeManager.transform.setToolAxis('local')
            }
          />
        </TooltipTrigger>
        {gap(4)}
        <TooltipTrigger
          className={styles.tooltip}
          title={intl.formatMessage({
            description: 'Animator global axis mode button title',
            defaultMessage: 'Global Mode',
          })}
          text={intl.formatMessage({
            description: 'Animator global axis mode button description',
            defaultMessage: 'Adjust coordinate in global mode',
          })}
          {...triggerOptions}
        >
          <Button
            className={styles.btn}
            type="icon"
            icon="#icon-tool-world-axis"
            activated={toolAxis === 'world'}
            disabled={isPivotMode || toolType === ToolType.Scale}
            background={true}
            onClick={() =>
              editor?.animatorApp.nodeManager.transform.setToolAxis('world')
            }
          />
        </TooltipTrigger>
        {pivotAxis}
      </div>
    );
  }, [
    editor,
    toolAxis,
    toolType,
    intl,
    triggerOptions,
    isPivotMode,
    pivotAxis,
  ]);

  const hitBoxModeBtns = useMemo(() => {
    return (
      <div className={styles.hitBoxMode}>
        <div>
          {intl.formatMessage({
            description: 'HitBox Mode Buttons',
            defaultMessage: 'Mode',
          })}
        </div>
        <Tabs
          className={styles.hitBoxModeTabs}
          defaultActiveId={hitBoxMode}
          activeId={hitBoxMode}
          onTabClick={(id) => {
            if (typeof id === 'number') {
              editor?.animatorApp.hitBoxManager.setHitBoxMode(id);
            }
          }}
        >
          <TabPanel
            className={styles.hitBoxModeTab}
            id={HitBoxMode.Default}
            type={'icon'}
            tab={intl.formatMessage({
              description: 'HitBox Mode Button Default',
              defaultMessage: 'Default',
            })}
          />
          <TabPanel
            className={styles.hitBoxModeTab}
            id={HitBoxMode.Custom}
            type={'icon'}
            tab={intl.formatMessage({
              description: 'HitBox Mode Button Custom',
              defaultMessage: 'Custom',
            })}
          />
        </Tabs>
      </div>
    );
  }, [editor, hitBoxMode, intl]);

  const voxelBar = useMemo(() => {
    return (
      <div className={styles.tools}>
        {mirrorButtons}
        {gap(24)}
        {rotateButtons}
        {gap(24)}
        {voxelFlipButtons}
        {gap(24)}
        <div className={styles.divider} />
        {gap(24)}
        {sizeInput}
      </div>
    );
  }, [mirrorButtons, rotateButtons, sizeInput, voxelFlipButtons]);

  const animatorBar = useMemo(() => {
    return (
      <div className={styles.tools}>
        {animationPermission && editType === EditType.Normal && (
          <>
            <AnimatorModeButtons />
            {gap(24)}
            <div className={styles.divider} />
            {gap(24)}
          </>
        )}
        {editType === EditType.Skin && (
          <>
            {skinTitle}
            {gap(24)}
            <div className={styles.divider} />
            {gap(24)}
          </>
        )}
        {mode === AnimatorMode.Setup && (
          <>
            {animatorFlipButtons}
            {gap(20)}
          </>
        )}
        {(mode === AnimatorMode.Setup || mode === AnimatorMode.Motion) &&
          axisTool}
        {mode === AnimatorMode.HitBox && hitBoxModeBtns}
      </div>
    );
  }, [
    animationPermission,
    editType,
    skinTitle,
    mode,
    animatorFlipButtons,
    axisTool,
    hitBoxModeBtns,
  ]);

  const toolBarRef = useRef<HTMLDivElement | null>(null);
  const { onTabDown: onToolBarTabDown } = useFocusTrap(toolBarRef);

  const toolBar = useMemo(() => {
    return (
      <div
        className={styles.toolBar}
        ref={toolBarRef}
        onKeyDown={onToolBarTabDown}
      >
        {homeButtons}
        <div className={styles.divider} />
        {showFileMenu && <FileMenu onClose={() => setShowFileMenu(false)} />}
        <div className={styles.scrollBar}>
          {props.type === AppMode.Voxel ? voxelBar : animatorBar}
        </div>
      </div>
    );
  }, [
    onToolBarTabDown,
    homeButtons,
    showFileMenu,
    props.type,
    voxelBar,
    animatorBar,
  ]);

  const projectInfoRef = useRef<HTMLDivElement | null>(null);
  const { onTabDown: onProjectInfoTabDown } = useFocusTrap(projectInfoRef);

  const projectInfo = useMemo(() => {
    return (
      <div
        className={styles.project}
        ref={projectInfoRef}
        onKeyDown={onProjectInfoTabDown}
      >
        <Input
          className={styles.input}
          type="primary"
          size="middle"
          valueType="string"
          value={projectName}
          maxLength={MAX_NAME_LENGTH}
          validator={isValidName}
          onBlur={(value: string) => {
            // 输入过程中允许输入单个空格，需要去除首尾空格
            const newValue = value.trim();
            newValue !== projectName && dispatch(setProjectName(newValue));
          }}
        />
        <SaveButton />
      </div>
    );
  }, [dispatch, onProjectInfoTabDown, projectName]);

  return (
    <div className={styles.navBar} onMouseLeave={() => setDisplayed(false)}>
      {toolBar}
      {projectInfo}
    </div>
  );
}

function gap(length: number) {
  return <span style={{ width: length }} />;
}
