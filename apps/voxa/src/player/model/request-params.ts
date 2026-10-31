import type { AxiosRequestConfig } from 'axios';

/** Transport options accepted by the local VOXA model loader. */
export type RequestParams = Omit<
  AxiosRequestConfig,
  'data' | 'params' | 'url' | 'responseType'
>;
