import { isPlayAdminEnabled } from './play-admin-security';

describe('play admin availability', () => {
  const originalEnvironment = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnvironment,
      BOX_DEPLOYMENT_MODE: 'play',
      BOX_PLAY_ADMIN_TOKEN: 'fixture-server-side-admin-key-for-security-tests',
      BOX_PLAY_LIBRARY_PATH: '/app/play-worlds',
    };
  });

  afterAll(() => {
    process.env = originalEnvironment;
  });

  test('keeps the internal map library API available when a token is configured', () => {
    expect(isPlayAdminEnabled()).toBe(true);
  });

  test('keeps the owner token available to Player Service administrators', () => {
    process.env.BOX_DEPLOYMENT_MODE = 'player-service';
    expect(isPlayAdminEnabled()).toBe(true);
  });
});
