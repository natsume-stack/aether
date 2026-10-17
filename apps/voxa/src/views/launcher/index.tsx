import { useContext } from 'react';
import { useIntl } from 'react-intl';
import { Button } from '@box/box-design';
import { LaunchState } from '../../redux/app-slice';
import { useAppSelector } from '../../redux/store';
import { RootContext } from '../../root-context';
import styles from './style.module.scss';
import Logo from './svg-voxa.svg';

export type OnRetry = () => void;

/**
 * editor初始化加载时、加载初始作品失败展示的组件。带重试按钮。
 */
export function Launcher() {
  const launchState = useAppSelector(({ app }) => app.launchState);

  const body =
    launchState === LaunchState.Fail ? <RetryView /> : <LoadingView />;

  return <div className={styles.launcher}>{body}</div>;
}

function LoadingView() {
  const intl = useIntl();

  return (
    <>
      <div className={styles.logo}>
        <Logo className={styles.identity} />
        <Logo className={styles.shadow} />
      </div>
      <div className={styles.bottom}>
        <p>
          {intl.formatMessage({
            description: 'Launching',
            defaultMessage: 'Launching...',
          })}
        </p>
      </div>
    </>
  );
}

function RetryView() {
  const intl = useIntl();

  const { retry } = useContext(RootContext);

  return (
    <>
      <div className={styles.logo}>
        <Logo className={styles.identity} />
      </div>
      <div className={styles.bottom}>
        <Button type="primary" size="large" onClick={retry}>
          {intl.formatMessage({
            description: 'Retry launching',
            defaultMessage: 'Retry',
          })}
        </Button>
      </div>
    </>
  );
}
