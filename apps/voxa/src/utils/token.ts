import { URL } from '@box/schema/api/js/url';

export function getToken() {
  if (typeof window === 'undefined') {
    return '';
  }
  return localStorage.getItem('Authorization');
}
export function setToken() {
  if (typeof window === 'undefined') {
    return;
  }
  const url = new URL(window.location.href);
  const token = url.searchParams.get('token') || '';
  if (token) {
    localStorage.setItem('Authorization', token);
    // token存储在localstroage后从url中去掉
    removeURLToken();
  }
}
export function removeURLToken() {
  if (typeof window === 'undefined') {
    return;
  }
  const url = new URL(window.location.href);
  const searchParams = url.searchParams;
  searchParams.delete('token');
  const newSearch = searchParams.toString();
  url.search = newSearch;
  window.history.replaceState(null, '', url.toString());
}
