import type { NextApiRequest, NextApiResponse } from 'next';

const localOriginPattern =
  /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i;

function isPrivateOrLoopbackHost(host: string) {
  const normalized = host.toLowerCase();
  if (normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1') {
    return true;
  }
  const parts = normalized.split('.');
  if (parts.length === 4 && parts.every((part) => /^\d+$/.test(part))) {
    const octets = parts.map(Number);
    if (octets.some((octet) => octet > 255)) return false;
    return (
      octets[0] === 10 ||
      octets[0] === 127 ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 168) ||
      (octets[0] === 169 && octets[1] === 254)
    );
  }
  return (
    normalized === '::1' ||
    /^f[cd][0-9a-f:]*$/i.test(normalized) ||
    /^fe[89ab][0-9a-f:]*$/i.test(normalized)
  );
}

function isPrivateOrigin(value: string) {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && isPrivateOrLoopbackHost(url.hostname);
  } catch {
    return false;
  }
}

function configuredOrigins() {
  return [process.env.BOX_VOXA_PUBLIC_URL, process.env.BOX_VOXA_ALLOWED_ORIGINS]
    .flatMap((value) => String(value || '').split(','))
    .map((value) => value.trim())
    .filter(Boolean)
    .flatMap((value) => {
      try {
        const origin = new URL(value).origin;
        // An origin here is an explicit host-owner allow-list entry.  Local
        // deployments normally contain loopback/LAN addresses, while a
        // public deployment must be able to use its configured HTTPS/domain
        // address for the editor's same-origin write APIs.
        return origin.startsWith('http:') || origin.startsWith('https:') ? [origin] : [];
      } catch {
        return [];
      }
    });
}

function isAllowedOrigin(origin: string) {
  if (localOriginPattern.test(origin)) return true;
  return configuredOrigins().includes(origin);
}

function originForRequestHost(req: NextApiRequest) {
  const host = req.headers.host;
  if (!host || Array.isArray(host)) return undefined;

  // VOXA is often opened directly through a LAN address or a reverse proxy.
  // In those cases the browser origin and the incoming Host are the same,
  // but the host is intentionally not known when the container is built.
  const forwardedProto = req.headers['x-forwarded-proto'];
  const protocol = Array.isArray(forwardedProto)
    ? forwardedProto[0]
    : forwardedProto?.split(',')[0]?.trim();
  const scheme = protocol === 'https' ? 'https' : 'http';

  try {
    return new URL(`${scheme}://${host}`).origin;
  } catch {
    return undefined;
  }
}

export function setLocalCors(req: NextApiRequest, res: NextApiResponse) {
  const origin = req.headers.origin;
  res.setHeader('Vary', 'Origin');
  if (!origin) return true;
  if (Array.isArray(origin)) return false;
  // Directly opening a public IP must not implicitly allow cross-origin API
  // writes.  Public origins must be declared through BOX_VOXA_PUBLIC_URL or
  // BOX_VOXA_ALLOWED_ORIGINS; private/LAN direct access remains ergonomic.
  const sameVoxaHost = origin === originForRequestHost(req) && isPrivateOrigin(origin);
  if (!sameVoxaHost && !isAllowedOrigin(origin)) return false;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  return true;
}
