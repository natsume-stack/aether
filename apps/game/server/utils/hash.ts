export function hashToUrl(hash: string, cdn: string) {
  const value = hash.trim();
  if (!value) {
    return '';
  }

  // Local project covers are deliberately stored inline so they remain
  // available in offline Creator exports and Play packages. Do not treat a
  // validated image data URL as a content hash. Keep the allowlist narrow:
  // SVG and generic data URLs can carry active content.
  if (/^data:image\/(?:png|jpeg|webp);base64,/i.test(value)) {
    return value;
  }
  if (/^https?:\/\//i.test(value)) {
    return value;
  }
  if (value.startsWith('/') && !value.startsWith('//')) {
    return value;
  }

  return `${cdn.replace(/\/$/, '')}/block/${value}`;
}
