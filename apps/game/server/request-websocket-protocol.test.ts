import { describe, test, expect } from '@jest/globals';
import { requestWebSocketProtocol } from './request-websocket-protocol';

describe('request WebSocket protocol', () => {
  test.each([
    [false, undefined, false, 'ws'],
    [true, undefined, false, 'wss'],
    [false, 'https', true, 'wss'],
    [false, 'https, http', true, 'wss'],
    [false, ['HTTPS', 'http'], true, 'wss'],
    [false, 'https', false, 'ws'],
    [false, 'http, https', true, 'ws'],
    [true, 'http', true, 'wss'],
  ])('TLS=%s header=%s trusted=%s uses %s', (encrypted, header, trust, expected) => {
    expect(requestWebSocketProtocol({ socket: { encrypted }, headers: { 'x-forwarded-proto': header } }, trust)).toBe(expected);
  });
});
