import { createHash } from 'crypto';
import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';
import type { NextApiRequest, NextApiResponse } from 'next';
import { transferChallenge } from './player-login-transfer';

const mockQuery =
  jest.fn<(sql: string, values?: string[]) => Promise<{ rows: Array<Record<string, unknown>> }>>();
jest.mock('pg', () => ({
  Pool: jest.fn(() => ({
    query: (sql: string, values?: string[]) => mockQuery(sql, values),
    on: jest.fn(),
  })),
}));
const { issuePlayerLoginTransfer, redeemPlayerLoginTransfer, playerMapLibrary } =
  require('./local-player-identity') as typeof import('./local-player-identity');
const originalEnv = { ...process.env };
const session = 's'.repeat(43);
const device = 'd'.repeat(43);
const verifier = 'v'.repeat(43);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const response = { getHeader: () => undefined, setHeader: jest.fn() } as unknown as NextApiResponse;
const request = (body: object, cookies = true) =>
  ({
    body,
    headers: {
      authorization: 'Bearer fixture-secret',
      ...(cookies
        ? { cookie: `box_local_player_session=${session}; box_local_player_device=${device}` }
        : {}),
    },
    socket: { remoteAddress: '127.0.0.1' },
  }) as NextApiRequest;
let revoked: boolean;
let banned: boolean;
let expired: boolean;
let records: Map<string, { source: string; challenge: string; credentials: string }>;

beforeEach(() => {
  process.env.PERMISSION_TOKEN_SECRET = 'fixture-secret';
  process.env.BOX_DATABASE_URL = 'postgresql://fixture';
  process.env.BOX_PLAY_PUBLIC_URL = 'https://play.test/play';
  process.env.BOX_CREATOR_PUBLIC_URL = 'http://creator.test:3127';
  revoked = false;
  banned = false;
  expired = false;
  records = new Map();
  mockQuery.mockImplementation(async (sql: string, values: string[] = []) => {
    if (sql.includes('INSERT INTO "box_identity"."login_transfers"')) {
      records.set(values[0], { source: values[2], challenge: values[3], credentials: values[4] });
    }
    if (sql.includes('RETURNING credentials')) {
      const record = records.get(values[0]);
      if (!record || expired || record.source !== values[1] || record.challenge !== values[2])
        return { rows: [] };
      records.delete(values[0]);
      return { rows: [{ credentials: record.credentials }] };
    }
    if (
      sql.includes('FROM "box_identity"."sessions" s') &&
      values[0] === hash(session) &&
      !revoked
    ) {
      return {
        rows: [
          {
            subject_id: '0123456789abcdef0123456789abcdef',
            user_id: '42',
            username: 'tester',
            status: banned ? 'banned' : 'active',
            role: 'player',
            session_device_hash: hash(device),
          },
        ],
      };
    }
    return { rows: [] };
  });
});
afterEach(() => {
  process.env = { ...originalEnv };
});

async function issue(source = 'play') {
  return issuePlayerLoginTransfer(
    request({ source, challenge: transferChallenge(verifier) }),
    response,
  );
}

test.each(['play', 'creator'])(
  '%s can redeem once and then access the authenticated map library',
  async (source) => {
    const { code } = await issue(source);
    expect(records.get(hash(code))!.credentials).not.toContain(session);
    const credentials = await redeemPlayerLoginTransfer(
      request({ code, source, verifier }, false),
      response,
    );
    expect(credentials).toEqual({ session, device });
    const library = await playerMapLibrary(request({}), response);
    expect(library.player.userId).toBe('42');
    await expect(
      redeemPlayerLoginTransfer(request({ code, source, verifier }, false), response),
    ).rejects.toThrow('失效');
  },
);

test('wrong audience or verifier cannot consume a valid code', async () => {
  const { code } = await issue();
  await expect(
    redeemPlayerLoginTransfer(request({ code, source: 'creator', verifier }, false), response),
  ).rejects.toThrow();
  await expect(
    redeemPlayerLoginTransfer(
      request({ code, source: 'play', verifier: 'x'.repeat(43) }, false),
      response,
    ),
  ).rejects.toThrow();
  await expect(
    redeemPlayerLoginTransfer(request({ code, source: 'play', verifier }, false), response),
  ).resolves.toEqual({ session, device });
});

test.each(['expiry', 'revocation', 'ban'])(
  '%s prevents transferring an existing login',
  async (reason) => {
    const { code } = await issue();
    if (reason === 'expiry') expired = true;
    if (reason === 'revocation') revoked = true;
    if (reason === 'ban') banned = true;
    await expect(
      redeemPlayerLoginTransfer(request({ code, source: 'play', verifier }, false), response),
    ).rejects.toThrow();
  },
);

test('issuing a transfer without a valid portal session is rejected', async () => {
  await expect(
    issuePlayerLoginTransfer(
      request({ source: 'play', challenge: transferChallenge(verifier) }, false),
      response,
    ),
  ).rejects.toThrow('AUTH_REQUIRED');
});
