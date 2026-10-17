export function isMobile(): boolean {
  if (typeof navigator === 'undefined') {
    return false;
  }
  return (
    navigator.userAgent.indexOf('Mobile') > -1 ||
    navigator.userAgent.indexOf('Android') > -1
  );
}

export function isMac() {
  let platform: string;

  platform = navigator.userAgentData
    ? navigator.userAgentData.platform
    : navigator.platform;

  return /(m|M)ac/.test(platform);
}
