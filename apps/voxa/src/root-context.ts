import { createContext } from 'react';
import { OnRetry } from './views/launcher';
import { LangType } from './utils/i18n';

export const RootContext = createContext<{
  retry: OnRetry;
  setRetry: (fn: OnRetry) => void;
  setLocale: (locale: LangType) => void;
}>({
  retry: () => undefined,
  setRetry: (fn) => undefined,
  setLocale: (locale: LangType) => undefined,
});
