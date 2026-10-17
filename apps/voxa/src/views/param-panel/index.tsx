import { vec3 } from 'gl-matrix';
import {
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useIntl } from 'react-intl';
import {
  CollapsePanel,
  Input,
  Tabs,
  SharedTipsContext,
  AXIS,
  TabPanel,
  Button,
  TooltipTrigger,
} from '@box/box-design';
import { IconPosition, IconRotation, IconScale, IconOpacity } from '@box/icons';
import { VoxelEditorContext } from '../../internals';
import { AnimatorMode, HitBoxMode, ToolAxis } from '../../redux/animator-slice';
import { RootState, store, useAppSelector } from '../../redux/store';
import { SerializedVec3 } from '../../utils/math';
import { ProjectNodeType } from '../../redux/animator-slice';
import { onAppSliderAbort } from '../hooks';
import {
  getBoneIdBySkinId,
  getRootParentId,
} from '../../models/animator-app/util';
import { AppSlider, AppSliderOnMouseDown } from '../components/slider';
import styles from './style.module.scss';
import { MIN_SCALE } from '../../models/rendering/controls/transform/def';

const TEMP_VEC = vec3.create();

type Property =
  | 'rotation'
  | 'position'
  | 'scale'
  | 'hitBoxPosition'
  | 'hitBoxSize';

type VectorInputProps = {
  property: Property;
  value?: vec3;
  min: number;
  max: number;
  disabled: boolean;
  precision?: number;
  onBlur: (property: Property, axis: number, value: number) => void;
  onFocus: () => void;
  formatter?: (value: string) => string;
  icon?: ReactNode;
};

function VectorInput(props: VectorInputProps) {
  const {
    property,
    value,
    min,
    max,
    precision,
    disabled,
    onBlur,
    onFocus,
    formatter,
    icon,
  } = props;

  return (
    <div className={styles.inputLine}>
      {<div className={styles.paramIcon}>{icon}</div>}
      {AXIS.map((axis, i) => {
        return (
          <Input
            key={axis}
            type="primary"
            size="small"
            className={styles.input}
            suffix={<span>{axis}</span>}
            valueType="number"
            value={value === undefined ? value : value[i]}
            min={min}
            max={max}
            precision={precision}
            onBlurValidator={(value: string) => {
              if (!value) {
                return false;
              }

              const valueIsNaN = isNaN(Number(value));
              if (valueIsNaN) {
                console.warn(
                  `param value is expected to be a number, but got NaN: "${value}"`,
                );
              }
              return !valueIsNaN;
            }}
            onBlur={(value: string) => {
              onBlur(property, i, Number(value));
            }}
            onFocus={onFocus}
            disabled={disabled || !value}
            formatter={formatter}
          />
        );
      })}
    </div>
  );
}

type NumberInputProps = {
  value?: number;
  onFocus: () => void;
  onBlur: (alpha: number) => void;
  disabled: boolean;
};

/**
 * 转百分比
 */
const TO_PERCENTAGE = 1 / 100;

const MAX_VECTOR_INPUT = 99999.9;

function Opacity(props: NumberInputProps) {
  const { value, onFocus, onBlur, disabled } = props;
  const editor = useContext(VoxelEditorContext);
  const animatorMode = useAppSelector(({ animator }) => animator.mode);

  const onAfterChange = useCallback(
    (value: number, oldState?: RootState) => {
      if (!editor) {
        return;
      }

      // 在静态模式下，拖拽结束时，情况部件透明度缓存
      animatorMode !== AnimatorMode.Motion &&
        editor.profiler.clearSkinAlphaCache();

      editor.history.setGroup();

      const { boneIds, ids } = getOpacityActiveIds();

      editor.animatorApp.nodeManager.transform.updateNodesAlpha(
        value * TO_PERCENTAGE,
        ids,
        true,
        oldState,
      );

      editor.animatorApp.motionManager.addKeyframe(boneIds);

      editor.history.unsetGroup();
    },
    [editor, animatorMode],
  );

  const onAbort = useCallback<onAppSliderAbort>(
    (oldState) => {
      if (!editor || !oldState) {
        return;
      }

      const { hierarchyData } = oldState.animator;

      const alphas: number[] = [];
      const { ids } = getOpacityActiveIds();

      ids.forEach((id) => {
        const hierarchy = hierarchyData[id];

        if (
          !hierarchy ||
          (hierarchy.type !== ProjectNodeType.SkinPart &&
            hierarchy.type !== ProjectNodeType.Bone)
        ) {
          return;
        }

        alphas.push(hierarchy.alpha);
      }, []);

      editor.animatorApp.nodeManager.transform.updateNodesAlpha(
        alphas,
        ids,
        false,
      );

      // 在静态模式下，拖拽中断时，情况部件透明度缓存
      animatorMode !== AnimatorMode.Motion &&
        editor.profiler.clearSkinAlphaCache();
    },
    [editor, animatorMode],
  );

  const onChange = useCallback(
    (value: number) => {
      if (!editor) {
        return;
      }

      editor.animatorApp.nodeManager.transform.updateNodesAlpha(
        value * TO_PERCENTAGE,
        getOpacityActiveIds().ids,
        false,
      );
    },
    [editor],
  );

  const onMouseDown = useCallback<AppSliderOnMouseDown>(
    (oldState) => {
      if (!oldState || !editor || animatorMode === AnimatorMode.Motion) {
        return;
      }

      editor.profiler.updateSkinAlphaCache(
        getOpacityActiveIds().ids,
        oldState.animator.hierarchyData,
      );
    },
    [editor, animatorMode],
  );

  const opacity = useMemo(() => {
    return value === undefined ? undefined : value / TO_PERCENTAGE;
  }, [value]);

  const noSelection = useAppSelector(
    (state) => state.animator.activeIds.length === 0,
  );

  const mixed = useMemo(() => {
    // 存在选中部件且opacity为undefined
    return !noSelection && value === undefined;
  }, [noSelection, value]);

  const input = useMemo(() => {
    return (
      <Input
        type="primary"
        size="small"
        className={styles.input}
        valueType="number"
        value={opacity}
        min={0}
        max={100}
        precision={0}
        suffix={<span>%</span>}
        validator={(value) => /^\d{0,3}$/.test(value)}
        onBlur={(value: string) => {
          onBlur(Number(value));
        }}
        disabled={noSelection || disabled}
        mixed={mixed}
        onFocus={onFocus}
      />
    );
  }, [opacity, noSelection, disabled, mixed, onFocus, onBlur]);

  return (
    <div className={styles.opacity}>
      <div className={styles.paramIcon}>
        <IconOpacity />
      </div>
      <AppSlider
        type="normal"
        value={opacity}
        min={0}
        max={100}
        step={1}
        className={styles.sliderWrapper}
        sliderClassName={styles.slider}
        onMouseDown={onMouseDown}
        onChange={onChange}
        onAfterChange={onAfterChange}
        onAbort={onAbort}
        input={input}
        disabled={noSelection || disabled}
      />
    </div>
  );
}

const SCALE_INPUT_MAX_WIDTH = 39;
let MEASURE_CONTEXT: CanvasRenderingContext2D | null | undefined;
function measureText(text: string): number | undefined {
  if (MEASURE_CONTEXT === undefined) {
    const canvas = document.createElement('canvas');

    MEASURE_CONTEXT = canvas.getContext('2d');

    if (MEASURE_CONTEXT) {
      MEASURE_CONTEXT.font = 'normal 12px Rubik';
      MEASURE_CONTEXT.textAlign = 'left';
      MEASURE_CONTEXT.textBaseline = 'middle';
    }
  }

  if (!MEASURE_CONTEXT) {
    return;
  }

  return MEASURE_CONTEXT.measureText(text).width;
}

type ParamPanelProps = {
  panelId: number;
};

export function ParamPanel(props: ParamPanelProps) {
  const editor = useContext(VoxelEditorContext);
  const animatorApp = editor?.animatorApp;

  const {
    paramPanelData,
    toolAxis,
    animatorMode,
    multiActiveIds,
    emptyActiveId,
    hitBoxMode,
    hitBoxParamPanelData,
  } = useAppSelector(({ animator }) => ({
    paramPanelData: animator.paramPanelData,
    toolAxis: animator.toolAxis,
    animatorMode: animator.mode,
    multiActiveIds: animator.activeIds.length > 1,
    emptyActiveId: !animator.activeIds.length,
    hitBoxMode: animator.hitBoxMode,
    hitBoxParamPanelData: animator.hitBoxParamPanelData,
  }));

  const [tab, setTab] = useState<ToolAxis>(toolAxis);

  const onTabChange = useCallback((id: string | number) => {
    id === 'local' ? setTab('local') : setTab('world');
  }, []);

  useEffect(() => {
    setTab(toolAxis);
  }, [toolAxis]);

  /**
   * - 动画模式时统一禁用“重置缩放”按钮
   * - 动画模式时，如果是“多选”，禁止修改缩放数值，也不会展示数值
   */
  const { disableResetScale, disableScale } = useMemo(() => {
    let disableResetScale = false;
    let disableScale = tab === 'world';

    if (animatorMode === AnimatorMode.Motion) {
      disableResetScale = true;

      disableScale = disableScale || multiActiveIds;
    }

    return {
      disableResetScale,
      disableScale,
    };
  }, [tab, animatorMode, multiActiveIds]);

  const { disableOpacity, disableVecInput } = useAppSelector((state) => {
    // 正在播放动画，不允许修改参数
    if (state.app.motionPanel.playing) {
      return {
        disableOpacity: true,
        disableVecInput: true,
      };
    }

    const { hierarchyData, activeIds } = state.animator;

    for (const id of activeIds) {
      const node = hierarchyData[id];
      if (
        node.type === ProjectNodeType.Bone ||
        node.type === ProjectNodeType.Root
      ) {
        continue;
      }

      // 骨骼直接绑定的部件/部件组，允许修改参数
      if (node.boneId) {
        return {
          disableOpacity: false,
          disableVecInput: false,
        };
      }

      // 骨骼绑定部件组，组内的部件，不允许修改透明度
      const parentId = getRootParentId(id);
      if (parentId) {
        const parentNode = hierarchyData[parentId];
        if (parentNode.type === ProjectNodeType.Group && parentNode.boneId) {
          return {
            disableOpacity: true,
            disableVecInput: false,
          };
        }
      }
    }

    return {
      disableOpacity: false,
      disableVecInput: false,
    };
  });

  const position = useMemo(() => {
    if (emptyActiveId) {
      return;
    }
    return tab === 'local'
      ? paramPanelData.position
      : paramPanelData.worldPosition;
  }, [
    emptyActiveId,
    tab,
    paramPanelData.position,
    paramPanelData.worldPosition,
  ]);

  const rotation = useMemo(() => {
    if (emptyActiveId) {
      return;
    }
    return tab === 'local'
      ? paramPanelData.rotation
      : paramPanelData.worldRotation;
  }, [
    emptyActiveId,
    tab,
    paramPanelData.rotation,
    paramPanelData.worldRotation,
  ]);

  /**
   * 如果是通过disableScale禁用，会禁止数值展示
   * 如果是通过disableVectorInput禁用输入，允许数值展示
   */
  const scale = useMemo<SerializedVec3 | undefined>(() => {
    if (disableScale || emptyActiveId) {
      return;
    }

    return [
      paramPanelData.scale[0] / TO_PERCENTAGE,
      paramPanelData.scale[1] / TO_PERCENTAGE,
      paramPanelData.scale[2] / TO_PERCENTAGE,
    ];
  }, [emptyActiveId, disableScale, paramPanelData.scale]);

  const opacity = useMemo(() => {
    if (emptyActiveId) {
      return;
    }
    return paramPanelData.opacity;
  }, [emptyActiveId, paramPanelData.opacity]);

  const editingIds = useRef<string[]>([]);
  const editingSkinPartIds = useRef<string[]>([]);
  const editingPosition = useRef<SerializedVec3 | undefined>(undefined);
  const editingRotation = useRef<SerializedVec3 | undefined>(undefined);
  const editingScale = useRef<SerializedVec3 | undefined>(undefined);
  const editingHitBoxPosition = useRef<SerializedVec3 | undefined>(undefined);
  const editingHitBoxSize = useRef<SerializedVec3 | undefined>(undefined);

  /**
   * 记录开始编辑时选中的部件信息
   */
  const onInputFocus = useCallback(() => {
    editingIds.current = store.getState().animator.activeIds;
    editingSkinPartIds.current = store.getState().animator.activeSkinPartIds;

    const { paramPanelData, hitBoxParamPanelData } = store.getState().animator;
    editingPosition.current =
      tab === 'local' ? paramPanelData.position : paramPanelData.worldPosition;
    editingRotation.current =
      tab === 'local' ? paramPanelData.rotation : paramPanelData.worldRotation;
    editingScale.current = paramPanelData.scale;
    editingHitBoxPosition.current = hitBoxParamPanelData?.position;
    editingHitBoxSize.current = hitBoxParamPanelData?.size;
  }, [tab]);

  const onVectorChanged = useCallback(
    (property: Property, axis: number, v: number) => {
      let editingValue: SerializedVec3 | undefined;

      let value = v;

      switch (property) {
        case 'rotation':
          editingValue = editingRotation.current;
          break;
        case 'position':
          editingValue = editingPosition.current;
          break;
        case 'scale':
          editingValue = editingScale.current;
          value *= TO_PERCENTAGE;
          break;
        case 'hitBoxPosition':
          editingValue = editingHitBoxPosition.current;
          break;
        case 'hitBoxSize':
          editingValue = editingHitBoxSize.current;
          break;
      }

      if (!animatorApp || !editingValue || editingValue[axis] === value) {
        return;
      }

      vec3.set(TEMP_VEC, editingValue[0], editingValue[1], editingValue[2]);

      switch (property) {
        case 'hitBoxPosition':
          TEMP_VEC[axis] = value;
          animatorApp.hitBoxManager.updatePosition(TEMP_VEC);
          return;
        case 'hitBoxSize':
          TEMP_VEC[axis] = value;
          animatorApp.hitBoxManager.updateSize(TEMP_VEC);
          return;
      }

      const activeIds = store.getState().animator.activeIds;
      let activeIdsChanged = activeIds !== editingIds.current;
      if (activeIdsChanged) {
        // 使用上一个已关闭的事件组id，此次编辑与选中部件的改变一起撤销
        const lastGroupId = editor.history.getLastGroupId();
        editor.history.setGroup(lastGroupId);
        animatorApp.nodeManager.setActiveIds(
          editingIds.current,
          true,
          activeIds,
        );
      } else {
        editor.history.setGroup();
      }

      switch (property) {
        case 'rotation':
          // 角度范围(-180, 180]
          value === -180 && (value = 180);
          TEMP_VEC[axis] = value;
          animatorApp.nodeManager.transform.updateSkinPartsRotation(
            tab,
            TEMP_VEC,
          );
          break;
        case 'position':
          TEMP_VEC[axis] = value;
          animatorApp.nodeManager.transform.updateSkinPartsPosition(
            tab,
            TEMP_VEC,
          );
          break;
        case 'scale':
          TEMP_VEC[axis] = value;
          animatorApp.nodeManager.transform.updateNodesScale(TEMP_VEC);
          break;
      }

      if (activeIdsChanged) {
        animatorApp.nodeManager.setActiveIds(
          activeIds,
          true,
          editingIds.current,
        );
      }

      animatorApp.motionManager.addKeyframe(activeIds);

      editor.history.unsetGroup();
    },
    [animatorApp, editor, tab],
  );

  const onAlphaChangeByInput = useCallback(
    (value: number) => {
      if (!animatorApp) {
        return;
      }
      const activeIds = store.getState().animator.activeIds;
      let activeIdsChanged = activeIds !== editingIds.current;
      if (activeIdsChanged) {
        const lastGroupId = editor.history.getLastGroupId();
        editor.history.setGroup(lastGroupId);
        animatorApp.nodeManager.setActiveIds(
          editingIds.current,
          true,
          activeIds,
        );
      } else {
        editor.history.setGroup();
      }

      animatorApp.nodeManager.transform.updateNodesAlpha(
        value * TO_PERCENTAGE,
        getOpacityActiveIds().ids,
      );

      if (activeIdsChanged) {
        animatorApp.nodeManager.setActiveIds(
          activeIds,
          true,
          editingIds.current,
        );
      }

      animatorApp.motionManager.addKeyframe(activeIds);

      editor.history.unsetGroup();
    },
    [animatorApp, editor],
  );

  const scaleFormatter = useCallback((v: string): string => {
    let value = v;
    let sliceEnd = 1;

    while (true) {
      if (sliceEnd >= v.length) {
        break;
      }
      const width = measureText(`${value}%`);

      if (width === undefined || width <= SCALE_INPUT_MAX_WIDTH) {
        break;
      }

      value = `${v.slice(0, v.length - sliceEnd)}...`;

      sliceEnd++;
    }

    return `${value}%`;
  }, []);

  const intl = useIntl();
  const { delay, setDisplayed } = useContext(SharedTipsContext);
  const onPopupVisibleChange = useCallback(
    (visible: boolean) => {
      visible && setDisplayed(visible);
    },
    [setDisplayed],
  );

  const extra = useMemo(() => {
    return (
      <div className={styles.extra}>
        <Tabs
          className={styles.tabs}
          defaultActiveId={tab}
          activeId={tab}
          onChange={onTabChange}
        >
          <TabPanel
            id="local"
            type="icon"
            icon="#icon-secondary-object"
            tooltipTrigger={{
              text: intl.formatMessage({
                description: 'Param panel tab local mode',
                defaultMessage: 'Local Mode',
              }),
              delay,
              placement: 'bottom',
              align: { offset: [0, 4] },
              onPopupVisibleChange,
            }}
          />
          <TabPanel
            id="world"
            type="icon"
            icon="#icon-secondary-world"
            tooltipTrigger={{
              text: intl.formatMessage({
                description: 'Param panel tab global mode',
                defaultMessage: 'Global Mode',
              }),
              delay,
              placement: 'bottom',
              align: { offset: [0, 4] },
              onPopupVisibleChange,
            }}
          />
        </Tabs>
      </div>
    );
  }, [tab, onTabChange, intl, delay, onPopupVisibleChange]);

  const onResetScale = useCallback(() => {
    if (!editor || disableResetScale) {
      return;
    }

    const { animatorApp } = editor;

    animatorApp.nodeManager.transform.resetScale();
  }, [editor, disableResetScale]);

  const nodeParamPanel = useMemo(() => {
    return (
      <CollapsePanel
        header={intl.formatMessage({
          description: 'Parameter Collapse Panel',
          defaultMessage: 'Parameter',
        })}
        id={props.panelId}
        extra={extra}
      >
        <div className={styles.paramPanel}>
          <VectorInput
            property="position"
            icon={<IconPosition />}
            value={position}
            min={-MAX_VECTOR_INPUT}
            max={MAX_VECTOR_INPUT}
            onFocus={onInputFocus}
            onBlur={onVectorChanged}
            precision={1}
            disabled={disableVecInput}
          />
          <VectorInput
            property="rotation"
            icon={<IconRotation />}
            value={rotation}
            min={-180}
            max={180}
            onFocus={onInputFocus}
            onBlur={onVectorChanged}
            precision={1}
            disabled={disableVecInput}
            formatter={(value) => {
              return `${value}°`;
            }}
          />
          <VectorInput
            property="scale"
            icon={
              <TooltipTrigger
                text={intl.formatMessage({
                  description: 'Reset Scale',
                  defaultMessage: 'Designed by JohnEast',
                })}
                placement={'topLeft'}
                delay={delay}
                onPopupVisibleChange={onPopupVisibleChange}
              >
                <Button
                  className={styles.resetScale}
                  type={'icon'}
                  background={true}
                  size={'small'}
                  icon={<IconScale />}
                  onClick={onResetScale}
                />
              </TooltipTrigger>
            }
            value={scale}
            min={MIN_SCALE * TO_PERCENTAGE}
            max={MAX_VECTOR_INPUT}
            onFocus={onInputFocus}
            onBlur={onVectorChanged}
            precision={1}
            disabled={disableScale || disableVecInput}
            formatter={scaleFormatter}
          />
          <Opacity
            value={opacity}
            onFocus={onInputFocus}
            onBlur={onAlphaChangeByInput}
            disabled={disableOpacity}
          />
        </div>
      </CollapsePanel>
    );
  }, [
    delay,
    disableOpacity,
    disableScale,
    disableVecInput,
    extra,
    intl,
    onAlphaChangeByInput,
    onInputFocus,
    onPopupVisibleChange,
    onResetScale,
    onVectorChanged,
    opacity,
    position,
    props.panelId,
    rotation,
    scale,
    scaleFormatter,
  ]);

  const hitBoxParamPanel = useMemo(() => {
    return (
      <CollapsePanel
        header={intl.formatMessage({
          description: 'Parameter Collapse Panel',
          defaultMessage: 'Parameter',
        })}
        showArrow={false}
        id={props.panelId}
      >
        <div className={`${styles.paramPanel} ${styles.hitBox}`}>
          <VectorInput
            property="hitBoxPosition"
            icon={<IconPosition />}
            value={hitBoxParamPanelData?.position}
            min={-MAX_VECTOR_INPUT}
            max={MAX_VECTOR_INPUT}
            onFocus={onInputFocus}
            onBlur={onVectorChanged}
            precision={1}
            disabled={hitBoxMode === HitBoxMode.Default}
          />
          <VectorInput
            property="hitBoxSize"
            icon={<IconScale />}
            value={hitBoxParamPanelData?.size}
            min={-MAX_VECTOR_INPUT}
            max={MAX_VECTOR_INPUT}
            onFocus={onInputFocus}
            onBlur={onVectorChanged}
            precision={1}
            disabled={hitBoxMode === HitBoxMode.Default}
          />
        </div>
      </CollapsePanel>
    );
  }, [
    hitBoxMode,
    hitBoxParamPanelData?.position,
    hitBoxParamPanelData?.size,
    intl,
    onInputFocus,
    onVectorChanged,
    props.panelId,
  ]);

  return animatorMode === AnimatorMode.HitBox
    ? hitBoxParamPanel
    : nodeParamPanel;
}

/**
 * 根据当前activeIds和activeSkinPartIds，获取所有要修改透明度的节点id
 * 绑定了骨骼的部件被选中时，修改该部件的透明度相当于修改骨骼节点的透明度
 */
function getOpacityActiveIds() {
  const { activeIds, activeSkinPartIds, hierarchyData } =
    store.getState().animator;

  /**
   * 除了选中的骨骼要修改透明度，还有选中的部件绑定的骨骼（如果有）也要修改透明度
   */
  const activeBoneSet = new Set<string>();

  activeIds.forEach((id) => {
    switch (hierarchyData[id].type) {
      case ProjectNodeType.Bone:
        activeBoneSet.add(id);
        break;
      case ProjectNodeType.SkinPart:
      case ProjectNodeType.Group:
        {
          const boneId = getBoneIdBySkinId(id);

          boneId && activeBoneSet.add(boneId);
        }
        break;
    }
  });

  const activeBoneIds = Array.from(activeBoneSet);

  return {
    boneIds: activeBoneIds,
    ids: activeBoneIds.concat(activeSkinPartIds),
  };
}
