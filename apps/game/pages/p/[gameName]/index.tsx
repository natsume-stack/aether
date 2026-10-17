import { subscribeRealtime } from '@box/realtime-client';
import { GetServerSideProps } from 'next';
import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { apiClient } from 'src/apis/client';
import { IntlProvider } from 'react-intl';
import { LangType } from 'src/apis/createra';
import { LoadingStage } from 'src/defs/loading-stage';
import { EngineApp, EngineAppProps } from '../../../components/engine-app';
import { Error, ErrorProps } from '../../../components/error';
import { PlayLoading } from '../../../components/play-loading';
import { bootstrapPlayResourceCache, PlayResourceCacheBootstrap, shouldBootstrapPlayResourceCache } from '../../../components/play-resource-cache-bootstrap';
import { getArenaServerRenderProps } from '../../../server/server-render';
import { resolvePublicUrl } from 'src/utils/public-url';
import { hashToUrl } from '../../../server/utils/hash';
import { hasAuthenticatedPlayer, playerLoginURL, requestPlayerServiceIp } from '../../../server/player-service-client';
import { findPlayWorld } from '../../../server/play-worlds';
import { getLocalProjectManager } from '../../../server/local-project-manager';

// 浏览器执行的代码
const DynamicPlayUi = dynamic(() => import('../../../src/views/play'), {
  ssr: false,
});

export type SSRProps = SSRSuccessProps | SSRErrorProps | LoadingConfigProps;

type SSRSuccessProps = EngineAppProps & {
  error?: never;
  loadingConfig?: never;
};

interface SSRErrorProps {
  error: ErrorProps;
  locale: LangType;
  loadingConfig?: never;
  userInfo: undefined;
}

interface LoadingConfigProps {
  error?: never;
  loadingConfig: true;
  userInfo: undefined;
}

export const getServerSideProps: GetServerSideProps<SSRProps> = async (
  context,
) => {
  if (process.env.BOX_DEPLOYMENT_MODE === 'player-service') {
    return {
      redirect: { destination: '/', permanent: false },
    };
  }
  const gameName = String(context.params?.gameName || '');
  if (process.env.BOX_DEPLOYMENT_MODE === 'play') {
    const exists = process.env.BOX_PLAY_LIBRARY_PATH
      ? Boolean(findPlayWorld(gameName))
      : [process.env.BOX_WORLD_PUBLIC_ID, process.env.BOX_WORLD_ID]
          .filter(Boolean)
          .includes(gameName);
    if (!exists || findPlayWorld(gameName)?.playEnabled === false) return { notFound: true };
  } else {
    try {
      getLocalProjectManager().getProject(gameName);
    } catch {
      return { notFound: true };
    }
  }
  const from = process.env.BOX_DEPLOYMENT_MODE === 'creator' ? 'creator' : 'play';
  if (!await hasAuthenticatedPlayer(
    context.req.headers.cookie || '',
    requestPlayerServiceIp(context.req),
    String(context.req.headers['user-agent'] || ''),
  )) {
    return { redirect: { destination: playerLoginURL(from), permanent: false } };
  }
  const cookie = context.req.headers.cookie!;
  const { token } = context.query;
  const browserLanguage = context.req.headers['accept-language'];

  // 先获取用户信息
  const serverProps = await getArenaServerRenderProps({
    containerName: context.params!['gameName'] as string,
    mode: 'play',
    cookie,
    browserLanguage,
    token: token?.toString(),
  });

  // 如果 getArenaServerRenderProps 返回错误或加载配置，直接返回
  if ('error' in serverProps.props || 'loadingConfig' in serverProps.props) {
    return serverProps;
  }
  const successfulProps = serverProps.props as SSRSuccessProps;

  if (process.env.BOX_DEPLOYMENT_MODE === 'play' && context.query.box3ServiceWorkerCache === '1') {
    const permanentMapId = context.query.box3PermanentMapId;
    const releaseVersion = context.query.box3ReleaseVersion;
    const manifestDigest = context.query.box3ManifestDigest;
    if (
      typeof permanentMapId !== 'string' ||
      typeof releaseVersion !== 'string' ||
      typeof manifestDigest !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(manifestDigest)
    ) {
      return {
        props: {
          error: { code: 400, info: '启动器地图资源版本信息无效，请返回启动器重新启动。' },
          locale: successfulProps.locale,
          userInfo: undefined,
        },
      };
    }
    successfulProps.clientConfig = {
      ...successfulProps.clientConfig,
      launcherAvatarCdnURL: successfulProps.clientConfig.OSS_CDN_URL,
      CDN_PATH: '',
      OSS_CDN_URL: '',
      launcherServiceWorkerMode: true,
      launcherPackage: { permanentMapId, releaseVersion, manifestDigest },
    };
  }

  return { props: successfulProps };
};

function Home(props: SSRProps) {
  const router = useRouter();
  const [loadingStage, setLoadingStage] = useState(LoadingStage.file);
  const [locale, setLocale] = useState<LangType>(() =>
    props.loadingConfig ? 'en' : props.locale,
  );
  const launcherServiceWorkerMode =
    'clientConfig' in props && props.clientConfig.launcherServiceWorkerMode === true;
  const world = typeof router.query.gameName === 'string' ? router.query.gameName : '';
  const [launcherLaunchTicket, setLauncherLaunchTicket] = useState<string | null>(null);
  const [launcherAssetBootstrapResolved, setLauncherAssetBootstrapResolved] = useState(false);
  const [launcherAssetBootstrapError, setLauncherAssetBootstrapError] = useState('');
  const [launcherAssetProgress, setLauncherAssetProgress] = useState(0);

  useEffect(() => {
    if (!launcherServiceWorkerMode) {
      setLauncherAssetBootstrapResolved(true);
      return;
    }
    if (!world) return;
    setLauncherAssetBootstrapResolved(false);
    setLauncherAssetBootstrapError('');
    setLauncherAssetProgress(0);
    const address = new URL(window.location.href);
    const fragment = new URLSearchParams(address.hash.slice(1));
    const launchTicket = fragment.get('box3LaunchTicket');
    if (
      !launchTicket ||
      launchTicket.length > 2048 ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(launchTicket)
    ) {
      setLauncherAssetBootstrapError('服务器启动授权无效，请返回启动器重新启动地图。');
      setLauncherAssetBootstrapResolved(true);
      address.hash = '';
      window.history.replaceState(null, '', `${address.pathname}${address.search}`);
      return;
    }
    address.hash = '';
    address.searchParams.delete('box3ServiceWorkerCache');
    window.history.replaceState(null, '', `${address.pathname}${address.search}`);
    setLauncherLaunchTicket(launchTicket);
    let cancelled = false;
    void bootstrapPlayResourceCache({
      world,
      launcherServiceWorkerMode: true,
      serviceWorkerContainer: 'serviceWorker' in navigator ? navigator.serviceWorker : undefined,
      cacheStorage: 'caches' in window ? window.caches : undefined,
      isCancelled: () => cancelled,
      waitForCompletion: true,
      onProgress: setLauncherAssetProgress,
    }).then(() => {
      if (!cancelled) {
        setLauncherAssetProgress(100);
        setLauncherAssetBootstrapResolved(true);
      }
    }).catch((error) => {
      if (!cancelled) {
        setLauncherAssetBootstrapError(error instanceof globalThis.Error ? error.message : '无法准备本地地图资源缓存');
        setLauncherAssetBootstrapResolved(true);
      }
    });
    return () => { cancelled = true };
  }, [launcherServiceWorkerMode, world]);

  useEffect(() => {
    if (loadingStage === LoadingStage.done) {
      setTimeout(() => {
        setLoadingStage(LoadingStage.close);
      }, 300);
    }
  }, [loadingStage]);

  useEffect(() => {
    const mapId = typeof router.query.gameName === 'string' ? router.query.gameName : '';
    if (!mapId || process.env.NEXT_PUBLIC_DEPLOYMENT_MODE === 'creator') return;
    return subscribeRealtime('player-presence:' + mapId, { body: { kind: 'player-presence', mapId } }, () => {});
  }, [router.query.gameName]);

  // 如果有异常，去异常页面
  if (props.error) {
    return <Error code={props.error.code} info={props.error.info} />;
  }

  if (launcherServiceWorkerMode && launcherAssetBootstrapResolved && launcherAssetBootstrapError) {
    return <Error code={400} info={launcherAssetBootstrapError} />;
  }

  const launcherAssetBase = launcherServiceWorkerMode && typeof window !== 'undefined' && world
    ? `${window.location.origin}${resolvePublicUrl(`/runtime/play/${encodeURIComponent(world)}`)}`
    : '';
  const activeClientConfig = !props.loadingConfig && launcherServiceWorkerMode
    ? {
        ...props.clientConfig,
        CDN_PATH: launcherAssetBase,
        OSS_CDN_URL: launcherAssetBase,
        launcherAvatarCdnURL: props.clientConfig.launcherAvatarCdnURL,
        launcherServiceWorkerMode: true,
        launcherPackage: props.clientConfig.launcherPackage && launcherLaunchTicket
          ? { ...props.clientConfig.launcherPackage, launchTicket: launcherLaunchTicket }
          : undefined,
      }
    : !props.loadingConfig
      ? props.clientConfig
      : undefined;

  const isCreatera =
    !props.loadingConfig && props.clientConfig.APP_EDITION === 'createra';
  const shouldBootstrapResourceCache = !props.loadingConfig && shouldBootstrapPlayResourceCache({
    deploymentMode: props.clientConfig.localRuntimeInfo?.deploymentMode,
    launcherServiceWorkerMode,
    disableResourceCache: router.query.box3DisableResourceCache === '1',
  });

  return (
    <div id="__next__root">
      {shouldBootstrapResourceCache && <PlayResourceCacheBootstrap world={world} launcherServiceWorkerMode={launcherServiceWorkerMode} />}
      {(props.loadingConfig ||
        (isCreatera && loadingStage !== LoadingStage.close) ||
        (launcherServiceWorkerMode && !launcherAssetBootstrapResolved)) && (
        <IntlProvider
          messages={props.loadingConfig ? {} : props.message}
          locale={locale}
        >
          <PlayLoading
            loadingConfig={!!props.loadingConfig}
            stage={loadingStage}
            gameCover={
              props.loadingConfig || (launcherServiceWorkerMode && (!launcherLaunchTicket || !launcherAssetBootstrapResolved))
              ? undefined
                : hashToUrl(
                    props.clientConfig.mapInfo.backgroundImage,
                    activeClientConfig?.CDN_PATH || props.clientConfig.CDN_PATH,
                  )
            }
            progress={launcherServiceWorkerMode && !launcherAssetBootstrapResolved ? launcherAssetProgress : undefined}
            message={launcherServiceWorkerMode && !launcherAssetBootstrapResolved ? '正在下载并校验地图资源，完成后将从本机缓存读取…' : undefined}
          />
        </IntlProvider>
      )}
      {!props.loadingConfig && (
        <EngineApp {...props} clientConfig={activeClientConfig!} locale={locale} message={props.message}>
          <div className="play-react">
            {launcherAssetBootstrapResolved && (!launcherServiceWorkerMode || launcherLaunchTicket) && <DynamicPlayUi
              userInfo={props.userInfo}
              setLoadingStage={setLoadingStage}
              setLocale={setLocale}
            />}
          </div>
        </EngineApp>
      )}
    </div>
  );
}

export default Home;
