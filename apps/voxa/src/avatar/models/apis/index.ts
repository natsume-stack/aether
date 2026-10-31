import axios from 'axios';
import { clientConfig } from '../../config';

export const cancelSource = axios.CancelToken.source();

/**
 * init axios instance
 */
const axiosInstance = axios.create({
  baseURL: clientConfig.backendServerUrl,
  withCredentials: true,
  headers: {},
});

/**
 * inject Authorization into header
 */
axiosInstance.interceptors.request.use(({ cancelToken, ...config }) => {
  return {
    // 自带 cancelToken 的就不覆盖
    cancelToken: cancelToken ?? cancelSource.token,
    ...config,
  };
});

const contentAxios = axios.create({
  baseURL: clientConfig.cdnPath,
  withCredentials: false,
});

export const apis = {
  content: contentAxios,
};

export function getAxiosInstance() {
  return axiosInstance;
}
