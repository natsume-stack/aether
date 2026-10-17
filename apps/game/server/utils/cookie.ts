import Cookie from 'cookie';

export function parseCookie(cookie: string): {
  [key: string]: string | undefined;
} {
  try {
    return Cookie.parse(cookie);
  } catch (error) {
    return {};
  }
}
