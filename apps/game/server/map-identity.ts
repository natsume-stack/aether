export const mapIdentityPattern = /^[0-9a-f]{20}$/;

export function normalizeMapIdentity(value: unknown) {
  const identity = String(value || '').trim().toLowerCase();
  return mapIdentityPattern.test(identity) ? identity : '';
}
