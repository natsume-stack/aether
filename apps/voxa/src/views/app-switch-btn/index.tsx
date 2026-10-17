import { memo, useContext } from 'react';
import { useIntl } from 'react-intl';
import { IconArrowBack } from '@box/icons';
import { VoxelEditorContext } from '../../internals';
import { FloatBtn } from '../float-menu/float-btn';
import styles from './style.module.scss';

function AppSwitchBtnView() {
  const intl = useIntl();
  const editor = useContext(VoxelEditorContext);

  return (
    <FloatBtn
      className={styles.appSwitchBtn}
      icon={<IconArrowBack />}
      text={intl.formatMessage({
        description: 'Switch App Button',
        defaultMessage: 'Back to Object',
      })}
      onClick={() => {
        editor?.switchToAnimator();
      }}
    />
  );
}

export const AppSwitchBtn = memo(AppSwitchBtnView);
