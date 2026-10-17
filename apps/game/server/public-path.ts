/**
 * Prefix a same-origin public path with this deployment's runtime base path.
 * Navigation preserves its trailing root slash and tolerates legacy peer config;
 * resource rewriting is maintained by @box/deployment-routing.
 */
export function publicPath(value: string): string {
  const base = process.env.BOX_APP_BASE_PATH || '';
  if (!base || typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) {
    return value;
  }
  let peers: string[] = [];
  try {
    const parsed = JSON.parse(process.env.BOX_PUBLIC_SERVICE_PREFIXES || '[]');
    if (Array.isArray(parsed)) {
      peers = parsed.filter((item): item is string => typeof item === 'string');
    }
  } catch {
    peers = [];
  }
  const target = value.split(/[?#]/)[0];
  if (
    [base, ...peers].some(
      (prefix) => prefix && (target === prefix || target.startsWith(`${prefix}/`)),
    )
  ) {
    return value;
  }
  return `${base}${value}`;
}
