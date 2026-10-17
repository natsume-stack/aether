import App, { AppContext, AppInitialProps, AppProps } from 'next/app';
import React from 'react';

import {
  extractServerConfigForClient,
  ServerConfigForClient,
} from '../configs/client';
import '../src/polyfill';
import './common.css';
import { SiteContextProvider } from '/src/contexts/site-context';

/**
 * 这里是为了兼容过往client config 的同步写法
 * @returns
 */
const InjectConfig: React.FC<{ config: ServerConfigForClient }> = ({
  config,
}) => {
  return (
    <script
      dangerouslySetInnerHTML={{
        __html: `window.CLIENT_CONFIG = ${JSON.stringify(config)};`,
      }}
    />
  );
};

interface AppOwnProps {
  clientConfig: ServerConfigForClient;
}

export default function MyApp({
  Component,
  clientConfig,
  pageProps,
}: AppProps & AppOwnProps) {
  return (
    <>
      {clientConfig && <InjectConfig config={clientConfig} />}
      <SiteContextProvider clientConfig={clientConfig}>
        <Component {...pageProps} />
      </SiteContextProvider>
    </>
  );
}

MyApp.getInitialProps = async (
  appContext: AppContext,
): Promise<AppOwnProps & AppInitialProps> => {
  const appProps = await App.getInitialProps(appContext);
  if (typeof window !== 'undefined') {
    const pageClientConfig = (appProps.pageProps as { clientConfig?: ServerConfigForClient })?.clientConfig;
    const windowClientConfig = (window as Window & { CLIENT_CONFIG?: ServerConfigForClient }).CLIENT_CONFIG;
    return {
      ...appProps,
      clientConfig: pageClientConfig || windowClientConfig || ({} as ServerConfigForClient),
    };
  }
  // The independent player service owns only account and administration UI.
  // It must not initialize the arena/engine configuration stack or contact
  // Nacos just to render those local pages.
  if (process.env.BOX_DEPLOYMENT_MODE === 'player-service') {
    return {
      ...appProps,
      clientConfig: {
        APP_ENV: process.env.NEXT_PUBLIC_APP_ENV || 'development',
        APP_EDITION: process.env.NEXT_PUBLIC_APP_EDITION || 'createra',
        APP_REGION: process.env.NEXT_PUBLIC_APP_REGION || 'cn',
      } as ServerConfigForClient,
    };
  }
  const serverConfig = await import('../configs/server').then(
    ({ getServerConfig }) => getServerConfig(),
  );
  const clientConfig = extractServerConfigForClient(serverConfig);

  return {
    ...appProps,
    clientConfig,
  };
};
