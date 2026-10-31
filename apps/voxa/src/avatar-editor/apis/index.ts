import axios from 'axios';
import { clientConfig } from '../config';

const modelContent = axios.create({
  baseURL: clientConfig.modelCDNPath,
  withCredentials: false,
});

const avatarContent = axios.create({
  baseURL: clientConfig.avatarCDNPath,
  withCredentials: false,
});

export const apis = {
  modelContent: modelContent,
  avatarContent: avatarContent,
};
