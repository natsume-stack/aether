import {
  GetServerSideProps,
  InferGetServerSidePropsType,
} from 'next';
import dynamic from 'next/dynamic';
import Head from 'next/head';
import React, { useMemo, useState, useCallback } from 'react';
import { createIntl } from 'react-intl';
import type { ClientRuntimeConfig } from '../configs/runtime-client';
import type { UserInfo } from '../src/interface';
import { LangType, MessagesType } from '../src/utils/i18n';
import { setToken } from '../src/utils/token';
import { resolveVoxaModelManagement, type VoxaModelManagementAccess } from '../server/model-management-access';

function loadLocaleData(locale: LangType) {
  return import(`../lang/build/${locale}.json`);
}

const ContainerNoSSR = dynamic(() => import('../src'), { ssr: false });

export const getServerSideProps: GetServerSideProps<{
  locale: LangType;
  messages: MessagesType;
  clientEnv: ClientRuntimeConfig;
  userInfo: Required<UserInfo>;
  access: VoxaModelManagementAccess;
}> = async (context) => {
  const locale: LangType = context.req.headers['accept-language']
    ?.toLowerCase()
    .includes('zh')
    ? 'zh-Hans'
    : 'en';
  const messages = (await loadLocaleData(locale)).default;
  const clientUserInfo: UserInfo = {
    avatar: '',
    userId: 1,
    isAdmin: true,
  };
  const access = await resolveVoxaModelManagement(
    context.req as any,
    context.res as any,
  );
  if (access !== 'allowed') context.res.statusCode = access === 'unauthenticated' ? 401 : access === 'denied' ? 403 : 503;

  const clientEnv: ClientRuntimeConfig = {
    appEnv: 'development',
    appEdition: 'createra',
    appRegion: 'cn',
    cdnPath: '/api/local/blobs/',
    backendServerUrl: '/api/local',
    appTitle: 'VOXA Local',
    websiteUrl: '/',
    toCheckPermissions: false,
    featureFlags: [],
  };

  return {
    props: {
      locale,
      messages,
      clientEnv,
      userInfo: clientUserInfo,
      access,
    },
  };
};

export type IndexProp = InferGetServerSidePropsType<typeof getServerSideProps>;

function Index(props: IndexProp): JSX.Element {
  const { locale, messages, clientEnv, userInfo, access } = props;
  const [ssrLocale, setLocale] = useState<LangType>(locale);
  const [ssrMessages, setMessages] = useState<MessagesType>(messages);

  const loadMsgOnDemand = useCallback(async () => {
    setMessages((await loadLocaleData(ssrLocale)).default);
  }, [ssrLocale]);

  const intl = useMemo(() => {
    loadMsgOnDemand();
    return createIntl({ locale: ssrLocale, messages: ssrMessages });
  }, [ssrLocale, ssrMessages, loadMsgOnDemand]);

  useMemo(() => {
    // 设置url中的token
    setToken();
    injectClientConfig(clientEnv);
  }, [clientEnv]);

  if (access !== 'allowed') {
    const copy = access === 'unauthenticated'
      ? '请先登录创作者账号后再打开 VOXA。'
      : access === 'denied'
        ? '当前账号没有“管理模型”权限，不能进入 VOXA 编辑模型。'
        : '暂时无法验证模型管理权限，请确认玩家服务正在运行。';
    return <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24, background: '#17181c', color: '#fff', fontFamily: 'system-ui, sans-serif' }}>
      <section style={{ width: 'min(440px, 100%)', padding: 28, borderRadius: 12, background: '#26282e', boxShadow: '0 16px 48px rgba(0,0,0,.28)' }}>
        <h1 style={{ margin: '0 0 10px', fontSize: 20 }}>无法打开 VOXA</h1>
        <p style={{ margin: 0, color: '#b7bbc5', lineHeight: 1.6 }}>{copy}</p>
      </section>
    </main>;
  }

  return (
    <>
      <Head>
        <title>{props.clientEnv.appTitle}</title>
      </Head>
      <ContainerNoSSR intl={intl} userInfo={userInfo} setLocale={setLocale} />
    </>
  );
}

export default Index;

/**
 * 注入clientEnv。
 * config/client.ts中的getConfig会使用。
 */
function injectClientConfig(env: ClientRuntimeConfig) {
  if (typeof window !== 'undefined') {
    window['CLIENT_CONFIG'] = { ...env };
  }
}
