import React, { useEffect, useMemo, useState } from 'react';
import { IntlShape, RawIntlProvider } from 'react-intl';
import { Provider, useDispatch } from 'react-redux';
import { store, useAppSelector } from './redux/store';
import { LaunchState, setLaunchState, setUserInfo } from './redux/app-slice';
import { OnRetry, Launcher } from './views/launcher';
import { RootContext } from './root-context';
import { AgentActivePanel } from './views/agent-active';
import { VoxaAiPanel } from './views/ai-panel';
import type { UserInfo } from './interface';
import { LangType } from './utils/i18n';

interface Props {
  intl: IntlShape;
  userInfo: UserInfo;
  setLocale: (locale: LangType) => void;
}

export default function VoxelBuilder(props: Props) {
  const { intl, userInfo, setLocale } = props;

  useMemo(() => {
    store.dispatch(setUserInfo(userInfo));

  }, [userInfo]);

  return (
    <RawIntlProvider value={intl}>
      <Provider store={store}>
        <Root setLocale={setLocale} />
      </Provider>
    </RawIntlProvider>
  );
}

function Root(props: { setLocale: (locale: LangType) => void }) {
  const { setLocale } = props;
  const { launchState } = useAppSelector(({ app }) => ({
    launchState: app.launchState,
  }));

  const dispatch = useDispatch();

  const [retry, setRetry] = useState<OnRetry>(() => undefined);

  const launcher = useMemo(() => {
    if (launchState === LaunchState.Success) {
      return;
    }

    return <Launcher />;
  }, [launchState]);

  const [container, setContainer] = useState<JSX.Element>();
  /**
   * 当动态加载container失败时，把“重试”改为重试动态加载。
   */
  useEffect(() => {
    const loadContainer = () => {
      dispatch(setLaunchState(LaunchState.Launching));

      import('./container')
        .then(({ IntlVoxelBuilderContainer }) => {
          setContainer(<IntlVoxelBuilderContainer />);
          dispatch(setLaunchState(LaunchState.Success));
        })
        .catch((err) => {
          console.error('Failed to load container', err);
          dispatch(setLaunchState(LaunchState.Fail));
        });
    };

    loadContainer();

    setRetry(() => loadContainer);
  }, [setRetry, dispatch]);

  return (
    <RootContext.Provider value={{ retry, setRetry, setLocale }}>
      {launcher}
      {container}
      <AgentActivePanel />
      <VoxaAiPanel />
    </RootContext.Provider>
  );
}
