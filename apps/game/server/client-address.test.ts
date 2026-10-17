import type { NextApiRequest } from 'next';
import { afterEach, describe, expect, test } from '@jest/globals';

import { requestClientAddress } from './client-address';

function request(remoteAddress: string, headers: Record<string, string> = {}) {
  return {
    headers,
    socket: { remoteAddress },
  } as unknown as NextApiRequest;
}

afterEach(() => {
  delete process.env.BOX_TRUST_PROXY;
});

describe('request client address', () => {
  test('ignores forwarding headers unless the proxy is explicitly trusted', () => {
    expect(requestClientAddress(request('::ffff:10.0.0.8', {
      'x-forwarded-for': '203.0.113.8',
    }))).toBe('10.0.0.8');
  });

  test('uses the first valid forwarded address from a trusted proxy', () => {
    process.env.BOX_TRUST_PROXY = 'true';
    expect(requestClientAddress(request('10.0.0.8', {
      'x-forwarded-for': 'invalid, 203.0.113.9, 10.0.0.8',
    }))).toBe('203.0.113.9');
  });

  test('allows a server-authenticated proxy to opt into its forwarded address', () => {
    expect(requestClientAddress(request('172.18.0.4', {
      'x-forwarded-for': '203.0.113.88, 172.18.0.1',
    }), true)).toBe('203.0.113.88');
  });

  test('falls back to x-real-ip and normalizes mapped IPv4', () => {
    process.env.BOX_TRUST_PROXY = 'true';
    expect(requestClientAddress(request('10.0.0.8', {
      'x-real-ip': '::ffff:203.0.113.10',
    }))).toBe('203.0.113.10');
  });
});
