import { memo, useContext, useMemo } from 'react';
import { useIntl } from 'react-intl';
import { IconRetry } from '@box/icons';
import { FloatBtn } from './float-btn';
import styles from './style.module.scss';
import { VoxelEditorContext } from '../../internals';
import { useAppSelector } from '../../redux/store';
import {
  AnimatorMode,
  HitBoxMode,
  PivotMode,
} from '../../redux/animator-slice';
import { AppMode } from '../../redux/app-slice';

export type FloatMenuType = 'resetPivot' | 'resetHitBox';

type FloatMenuProps = {
  type: FloatMenuType;
};

/**
 * 悬浮于画布区域，上方位置的按钮
 * 目前使用场景
 * - 多部件 - Setup模式 - 部件/模型中心点（锚点） - 重置锚点按钮
 * - 物理编辑 - 自定义模式 - 重置碰撞框
 */
function FloatMenuView(props: FloatMenuProps) {
  const editor = useContext(VoxelEditorContext);
  const intl = useIntl();
  const pivotMode = useAppSelector(({ animator }) => animator.pivotMode);

  const resetHitBox = useMemo(() => {
    if (props.type !== 'resetHitBox') {
      return;
    }

    return (
      <FloatBtn
        icon={<IconRetry />}
        text={intl.formatMessage({
          description: 'Reset Hit box',
          defaultMessage: 'Reset the hitbox',
        })}
        onClick={() => {
          editor?.animatorApp.hitBoxManager.setCustomBoxFromDefaultBox();
        }}
      />
    );
  }, [props.type, editor, intl]);

  const resetPivot = useMemo(() => {
    if (props.type !== 'resetPivot') {
      return;
    }

    return (
      <FloatBtn
        icon={<IconRetry />}
        text={intl.formatMessage({
          description: 'Float button for reset pivot',
          defaultMessage: 'Reset the pivot',
        })}
        onClick={() => {
          if (!editor || pivotMode === PivotMode.None) {
            return;
          }

          if (pivotMode === PivotMode.SkinNode) {
            editor.animatorApp.nodeManager.resetSkinNodePivot();

            return;
          }

          editor.animatorApp.modelPivotManager.reset();
        }}
      />
    );
  }, [props.type, editor, intl, pivotMode]);

  return (
    <div className={styles.floatMenu}>
      {resetHitBox}
      {resetPivot}
    </div>
  );
}

const FloatMenu = memo(FloatMenuView);

/**
 * 悬浮于画布区域，上方位置的按钮
 * 目前使用场景
 * - 多部件 - Setup模式 - 部件/模型中心点（锚点） - 重置锚点按钮
 * - 物理编辑 - 自定义模式 - 重置碰撞框
 */
export function useFloatMenu() {
  const { pivotMode, singleActive, appMode, animatorMode, hitBoxMode } =
    useAppSelector(({ app, animator }) => ({
      appMode: app.mode,
      animatorMode: animator.mode,
      hitBoxMode: animator.hitBoxMode,
      pivotMode: animator.pivotMode,
      singleActive: animator.activeIds.length === 1,
    }));

  return useMemo(() => {
    let type: FloatMenuType | undefined = undefined;

    if (
      appMode === AppMode.Animator &&
      animatorMode === AnimatorMode.HitBox &&
      hitBoxMode === HitBoxMode.Custom
    ) {
      type = 'resetHitBox';
    }

    if (
      pivotMode === PivotMode.Model ||
      (pivotMode === PivotMode.SkinNode && singleActive)
    ) {
      type = 'resetPivot';
    }

    if (!type) {
      return;
    }

    return <FloatMenu type={type} />;
  }, [animatorMode, appMode, hitBoxMode, pivotMode, singleActive]);
}
