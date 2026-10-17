export function getB64Type(b64: string) {
  return b64.substring(b64.indexOf('/') + 1, b64.indexOf(';base64'));
}
