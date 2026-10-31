import React, { useContext } from 'react';
import { useIntl } from 'react-intl';
import { Button } from '@box/box-design';
import { IconHitbox } from '@box/icons';
import { VoxelEditorContext } from '../../../internals';
import { AnimatorMode } from '../../../redux/animator-slice';
import { useAppSelector } from '../../../redux/store';
import styles from './style.module.scss';

/**
 * 动画编辑模式的切换组件。
 * 切换编辑原始模型还是动画。
 */
export function AnimatorModeButtons() {
  const intl = useIntl();
  const animatorMode = useAppSelector(({ animator }) => animator.mode);
  const editor = useContext(VoxelEditorContext);

  return (
    <div className={styles.animatorSwitch}>
      <Button
        key="setup"
        type="icon"
        icon="#icon-setup"
        size="custom"
        background
        activated={animatorMode === AnimatorMode.Setup}
        onClick={() => {
          if (!editor) {
            return;
          }

          editor.motionPlayer.pause();
          editor.animatorApp.setMode(AnimatorMode.Setup);
        }}
      >
        {intl.formatMessage({
          description: 'Animator mode button for setup',
          defaultMessage: 'Setup',
        })}
      </Button>
      <Button
        key="motion"
        type="icon"
        icon="#icon-animation"
        size="custom"
        background
        activated={animatorMode === AnimatorMode.Motion}
        onClick={() => {
          editor?.animatorApp.setMode(AnimatorMode.Motion);
        }}
      >
        {intl.formatMessage({
          description: 'Animator mode button for motion',
          defaultMessage: 'Motion',
        })}
      </Button>
      <Button
        key="hitBox"
        type="icon"
        icon={<IconHitbox />}
        size="custom"
        background
        activated={animatorMode === AnimatorMode.HitBox}
        onClick={() => {
          if (!editor) {
            return;
          }

          editor.motionPlayer.pause();
          editor.animatorApp.setMode(AnimatorMode.HitBox);
        }}
      >
        {intl.formatMessage({
          description: 'Animator mode button for hitBox',
          defaultMessage: 'Hitbox',
        })}
      </Button>
    </div>
  );
}
