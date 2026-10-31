import { createHash } from 'node:crypto';

import { sessionDeviceBindingMatches } from './local-player-identity';

describe('player session device binding', () => {
  test('rejects a bound session when the device cookie is missing', () => {
    const deviceToken = 'a'.repeat(43);
    const storedHash = createHash('sha256').update(deviceToken).digest('hex');

    expect(sessionDeviceBindingMatches(storedHash, '')).toBe(false);
    expect(sessionDeviceBindingMatches(storedHash, 'b'.repeat(43))).toBe(false);
    expect(sessionDeviceBindingMatches(storedHash, deviceToken)).toBe(true);
  });

  test('allows legacy unbound sessions to bind on their next request', () => {
    expect(sessionDeviceBindingMatches('', '')).toBe(true);
    expect(sessionDeviceBindingMatches('', 'a'.repeat(43))).toBe(true);
  });
});
