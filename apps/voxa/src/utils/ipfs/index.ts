import axios from 'axios';

export async function retrieveFile(hash: string) {
  return axios.get(`${process.env.NEXT_PUBLIC_CDN_PATH}/block/${hash}`);
}
