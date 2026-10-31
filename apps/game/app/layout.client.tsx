'use client';

import React, { FC, ReactNode } from 'react';
import { ServerConfigForClient } from '../configs/client';
import '../src/polyfill';
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
  children?: ReactNode;
}

export const App: FC<AppOwnProps> = ({ children, clientConfig }) => {
  return (
    <>
      {clientConfig && <InjectConfig config={clientConfig} />}
      <SiteContextProvider clientConfig={clientConfig}>
        {children}
      </SiteContextProvider>
    </>
  );
};
