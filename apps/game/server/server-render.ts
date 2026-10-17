import { extractServerConfigForClient } from 'configs/client';
import { getMapContentInfo } from './map-info';
import { getServerConfig } from '../configs/server';
import { getSharedLogger } from './logger';
import { LangType, VALID_LANGUAGE, DEFAULT_LANGUAGE } from 'src/apis/createra';
import { parseCookie } from './utils/cookie';

export type ArenaMode = 'play' | 'edit';

export async function getArenaServerRenderProps(spec: {
  containerName: string;
  cookie: string;
  mode: ArenaMode;
  browserLanguage?: string;
  token?: string;
}) {
  const { containerName, cookie, mode, browserLanguage, token } = spec;
  const sharedLogger = await getSharedLogger();
  try {
    const serverConfig = await getServerConfig();
    const extractedConfig = extractServerConfigForClient(
      serverConfig,
      mode,
      containerName,
    );

    const mapInfo = await getMapContentInfo(mode, containerName, cookie);
    // 优先级：用户语言 > 本地语言(cookie) > 浏览器语言 > 默认语言
    const browserLocale = getDescLocaleList(browserLanguage)[0]?.locale;
    const cookieLocale = parseCookie(cookie)['locale'];
    const userLocale = undefined;
    const validLocale = getValidLocale(
      userLocale || cookieLocale || browserLocale,
    );
    const message = (await import(`../i18n/${validLocale}.json`)).default;

    return {
      props: {
        locale: validLocale,
        message,
        clientConfig: {
          ...extractedConfig,
          mapInfo,
          mode,
          name: containerName,
          // Local deployments expose VOXA as its own product.  WEBSITE_URL is
          // intentionally empty in local mode, so `${WEBSITE_URL}/edit-model`
          // resolves to a dead relative route.  Use the configured public VOXA
          // origin locally while retaining the platform editor route in cloud.
          WEBSITE_VOXA_URL: serverConfig.isLocalGameServer
            ? extractedConfig.VOXA_URL
            : `${extractedConfig.WEBSITE_URL}/edit-model`,
        },
        userInfo: null,
      },
    };
  } catch (error) {
    // TODO: 错误码定义
    sharedLogger.error(`get map info error: ${error}`);
    return {
      props: {
        locale: DEFAULT_LANGUAGE,
        error: { code: 500, info: 'get map info error!' },
      },
    };
  }
}

export async function getWebsiteServerRenderProps() {
  const ServerConfig = await getServerConfig();
  if (ServerConfig.APP_EDITION === 'createra') {
    return {
      redirect: {
        destination: ServerConfig.WEBSITE_URL,
        permanent: false,
      },
    };
  }
  try {
    return {
      props: {
        clientConfig: {
          ...extractServerConfigForClient(ServerConfig),
        },
      },
    };
  } catch (error) {
    // TODO: 错误码定义
    return { props: { error: { code: 500, info: 'get config error!' } } };
  }
}

// 自定义类型守卫: 检验locale是否在我们提供的语言VALID_LANGUAGE范围内
const isLangType = (locale): locale is LangType => {
  return VALID_LANGUAGE.indexOf(locale) > -1;
};

// 如果locale合法，则直接返回; 否则返回'en'(默认locale)
const getValidLocale = (locale): LangType => {
  return isLangType(locale) ? locale : DEFAULT_LANGUAGE;
};

// 从accept-language解析出一个 按照权重降序的语言列表
const getDescLocaleList = (
  browserLocale?: string,
): { locale: string; weight?: number }[] => {
  if (!browserLocale) {
    return [];
  }
  const localeList = browserLocale
    .split(',')
    .map((lang) => {
      const [langType, langWeight] = lang.split(';');
      const locale = langType.split('-')[0];
      const weight = langWeight ? parseFloat(langWeight.split('=')[1]) : 1;
      return { locale, weight };
    })
    .sort((a, b) => b.weight - a.weight);
  return localeList;
};
