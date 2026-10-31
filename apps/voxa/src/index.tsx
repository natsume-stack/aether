import React, { useEffect, useMemo, useState } from 'react';
import { IntlShape, RawIntlProvider } from 'react-intl';
import { Provider, useDispatch } from 'react-redux';
import { store, useAppSelector } from './redux/store';
import { LaunchState, setLaunchState, setUserInfo } from './redux/app-slice';
import { OnRetry, Launcher } from './views/launcher';
import { RootContext } from './root-context';
import { VoxaAiPanel } from './views/ai-panel';
import type { UserInfo } from './interface';
import { LangType } from './utils/i18n';

interface Props {
  intl: IntlShape;
  userInfo: UserInfo;
  setLocale: (locale: LangType) => void;
}


class AppErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error?: Error }
> {
  state: { error?: Error } = { error: undefined };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[voxa] UI render error', error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24, background: '#17181c', color: '#fff', fontFamily: 'system-ui, sans-serif' }}>
          <section style={{ width: 'min(480px, 100%)', padding: 28, borderRadius: 12, background: '#26282e', boxShadow: '0 16px 48px rgba(0,0,0,.28)' }}>
            <h1 style={{ margin: '0 0 10px', fontSize: 20 }}>编辑器遇到错误</h1>
            <p style={{ margin: '0 0 16px', color: '#b7bbc5', lineHeight: 1.6, overflowWrap: 'anywhere' }}>{this.state.error.message}</p>
            <button style={{ padding: '8px 14px', border: 0, borderRadius: 8, background: '#9afc17', color: '#0d2000', fontWeight: 600, cursor: 'pointer' }} onClick={() => window.location.reload()}>
              重新加载编辑器
            </button>
          </section>
        </main>
      );
    }
    return this.props.children;
  }
}

export default function VoxelBuilder(props: Props) {
  const { intl, userInfo, setLocale } = props;

  useMemo(() => {
    store.dispatch(setUserInfo(userInfo));

  }, [userInfo]);

  return (
    <RawIntlProvider value={intl}>
      <Provider store={store}>
        <AppErrorBoundary>
          <Root setLocale={setLocale} />
        </AppErrorBoundary>
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

  const [container, setContainer] = useState<import('react').JSX.Element>();
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
      <VoxaAiPanel />
    </RootContext.Provider>
  );
}
