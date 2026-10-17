import { isIP } from 'net';
import type { NextApiRequest } from 'next';

function normalizeAddress(value: string) {
  const address = value.trim().replace(/^::ffff:/, '');
  return isIP(address) ? address : '';
}

function firstHeader(req: Pick<NextApiRequest, 'headers'>, name: string) {
  const raw = req.headers[name];
  return Array.isArray(raw) ? raw[0] : raw || '';
}

/**
 * Resolves one canonical client address. Forwarding headers are ignored unless
 * BOX_TRUST_PROXY=true, so clients cannot spoof their rate-limit identity when
 * the service is exposed directly.
 */
export function requestClientAddress(
  req: Pick<NextApiRequest, 'headers' | 'socket'>,
  trustedForwarding = false,
) {
  if (trustedForwarding || process.env.BOX_TRUST_PROXY === 'true') {
    const forwarded = firstHeader(req, 'x-forwarded-for')
      .split(',')
      .map(normalizeAddress)
      .find(Boolean);
    if (forwarded) return forwarded;
    const direct = normalizeAddress(firstHeader(req, 'x-real-ip'));
    if (direct) return direct;
  }
  return normalizeAddress(req.socket.remoteAddress || '') || 'unknown';
}
