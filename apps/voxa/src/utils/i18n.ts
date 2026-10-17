import { IntlConfig } from 'react-intl';
import { LocaleFullType } from '@box/apis';

export const enum LanguageTag {
  en = 'en',
  zh = 'zh-Hans',
  zhHans = 'zh-Hans',
}

/**
 * 'react-intl'中定义的 intl对象的 messages的类型
 **/
export type MessagesType = IntlConfig['messages'];

/**
 * 只读，定义了项目本身提供的、允许的语言。
 * 参考lang/src下的文件名
 **/
export const VALID_LANGUAGE = <const>['en', 'zh-Hans'];

/**
 * 前端国际化语言的类型
 **/
export type LangType = typeof VALID_LANGUAGE[number];

/**
 * 默认语言为英语
 **/
export const DEFAULT_LANGUAGE: LangType = VALID_LANGUAGE[0];

type LocaleMapType = { [key in LangType]: LocaleFullType } & {
  [key in LocaleFullType]: LangType;
};

/**
  映射关系: 前端语言取值 <--> 后端语言取值
  后端: 对语言的取值包含下划线和region,例如'en_US'|'zh_CN'
  前端: 参考lang/src下的文件名, 例如'en'|'zh-Hans'
**/
export const localeMap: LocaleMapType = {
  // 前端 -> 后端
  'en': 'en_US',
  'zh-Hans': 'zh_CN',
  // 后端 -> 前端
  'en_US': 'en',
  'zh_CN': 'zh-Hans',
};

/**
 * 自定义类型守卫: 检验locale是否在我们提供的语言VALID_LANGUAGE范围内
 */
export const isLangType = (locale): locale is LangType => {
  return VALID_LANGUAGE.indexOf(locale) > -1;
};

/**
 * 如果locale合法，则直接返回; 否则返回'en'(默认locale)
 */
export const getValidLocale = (locale): LangType => {
  return isLangType(locale) ? locale : DEFAULT_LANGUAGE;
};

/**
 * 从accept-language解析出一个 按照权重降序的语言列表
 */
export const getDescLocaleList = (
  browserLocale?: string,
): { locale: string; weight: number }[] => {
  if (!browserLocale) {
    return [];
  }
  return browserLocale
    .split(',')
    .map((lang) => {
      const [langType, langWeight] = lang.split(';');
      const locale = langType.split('-')[0];
      const weight = langWeight ? parseFloat(langWeight.split('=')[1]) : 1;
      return { locale, weight };
    })
    .sort((a, b) => b.weight - a.weight);
};
