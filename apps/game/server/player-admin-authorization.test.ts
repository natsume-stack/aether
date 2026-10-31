import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from '@jest/globals';

import {
  actorHasPlayerAdminPermission,
  roleHasPlayerAdminPermission,
} from './player-admin-authorization';
import { parsePlayerItemOperation, playerItemRequirement } from './player-admin-validation';

describe('player administration role policy', () => {
  test('player identity resolution is absent from the authorization seam', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, 'player-admin-authorization.ts'),
      'utf8',
    );
    expect(source).toContain('resolvePlayerAdminSession');
    expect(source).not.toContain('resolvePlayerIdentity');
    expect(source).not.toContain('getAssignedPlayerAdminCapabilities');
  });

  test('administrators only receive the capabilities assigned by an owner', () => {
    expect(roleHasPlayerAdminPermission('moderator', 'players.view')).toBe(false);
    expect(roleHasPlayerAdminPermission('moderator', 'players.view', ['players.view'])).toBe(true);
    expect(roleHasPlayerAdminPermission('moderator', 'players.ban')).toBe(false);
    expect(roleHasPlayerAdminPermission('moderator', 'players.ban', ['players.ban'])).toBe(true);
    expect(roleHasPlayerAdminPermission('moderator', 'sessions.manage', ['players.ban'])).toBe(false);
    expect(roleHasPlayerAdminPermission('moderator', 'play-maps.view', ['play-maps.manage'])).toBe(true);
    expect(roleHasPlayerAdminPermission('moderator', 'play-maps.manage', ['play-maps.view'])).toBe(false);
    expect(roleHasPlayerAdminPermission('moderator', 'containers.view', ['containers.manage'])).toBe(true);
    expect(roleHasPlayerAdminPermission('moderator', 'containers.manage', ['containers.view'])).toBe(false);
    expect(roleHasPlayerAdminPermission('moderator', 'owner')).toBe(false);
  });

  test('advanced administrators keep player-management capabilities but not owner operations', () => {
    expect(roleHasPlayerAdminPermission('admin', 'players.view')).toBe(true);
    expect(roleHasPlayerAdminPermission('admin', 'identity-bans.manage')).toBe(true);
    expect(roleHasPlayerAdminPermission('admin', 'owner')).toBe(false);
    expect(roleHasPlayerAdminPermission('owner', 'owner')).toBe(false);
    expect(actorHasPlayerAdminPermission({
      actorRole: 'owner',
      actorPermissions: [],
      credential: 'owner-session',
    }, 'owner')).toBe(true);
    expect(actorHasPlayerAdminPermission({
      actorRole: 'owner',
      actorPermissions: [],
      credential: 'account',
    }, 'owner')).toBe(false);
  });

  test('unknown stored permission values never become effective permissions', () => {
    expect(roleHasPlayerAdminPermission('moderator', 'players.ban', ['owner', 'players.delete'])).toBe(false);
  });

  test('CLI Token creation, editing, and revocation all require the matching management permission', () => {
    for (const action of ['create-cli-token', 'update-cli-token', 'revoke-cli-token']) {
      expect(playerItemRequirement('POST', { action })).toBe('creator-tokens.manage');
    }
  });

  test('admin sessions use dedicated cookies instead of player cookies', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, 'player-admin-identity.ts'),
      'utf8',
    );
    expect(source).toContain("'box_local_admin_session'");
    expect(source).toContain("'box_local_admin_csrf'");
    expect(source).not.toContain('box_local_player_session');
    expect(source).toContain("sameSite: 'strict'");
    expect(source).toContain('LOGIN_IP_LIMIT');
    expect(source).toContain('LOGIN_ACCOUNT_LIMIT');
    expect(source).toContain("role: 'moderator' as const");
    expect(source).toContain("CHECK (role IN ('admin', 'moderator'))");
    expect(source).toContain("WHERE role = 'owner'");
    expect(source).toContain('admin_sessions_identity_check');
    expect(source).toContain('function requireOwnerIdentity');
    expect(source).toContain("actor.credential !== 'owner-session'");
    expect(source).toContain("playerAdminSessionError('ADMIN_AUTH_REQUIRED')");
    expect(source).toContain("playerAdminSessionError('ADMIN_SESSION_MISMATCH')");
    expect(source).toContain("playerAdminSessionError('ADMIN_CSRF_INVALID')");
    expect(source).not.toContain("throw new Error('ADMIN_");
  });

  test('mutations require both same-origin validation and a CSRF token', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, 'player-admin-authorization.ts'),
      'utf8',
    );
    expect(source).toContain("fetchSite === 'cross-site'");
    expect(source).toContain('requestOrigins(req).has(supplied)');
    expect(source).toContain("requireCsrf: !SAFE_METHODS.has(req.method || 'GET')");
  });

  test('permission groups are owner-managed and resolved on every admin session request', () => {
    const identitySource = fs.readFileSync(
      path.resolve(__dirname, 'player-admin-identity.ts'),
      'utf8',
    );
    const collectionRoute = fs.readFileSync(
      path.resolve(__dirname, '../pages/api/play-admin/permission-groups/index.ts'),
      'utf8',
    );
    const itemRoute = fs.readFileSync(
      path.resolve(__dirname, '../pages/api/play-admin/permission-groups/[id].ts'),
      'utf8',
    );
    expect(collectionRoute).toContain("requirement: 'owner'");
    expect(itemRoute).toContain("requirement: 'owner'");
    expect(identitySource).toContain(
      "LEFT JOIN ${table('admin_permission_groups')} g ON g.id = a.permission_group_id",
    );
    expect(identitySource).toContain('row.permission_group_permissions || []');
  });

  test('every owner-only API passes through the credential-aware authorization seam', () => {
    for (const route of [
      '../pages/api/play-admin/admins/index.ts',
      '../pages/api/play-admin/admins/[id].ts',
      '../pages/api/play-admin/permission-groups/index.ts',
      '../pages/api/play-admin/permission-groups/[id].ts',
      '../pages/api/play-admin/maintenance.ts',
    ]) {
      const source = fs.readFileSync(path.resolve(__dirname, route), 'utf8');
      expect(source).toContain('playerAdminRoute({');
      expect(source).toContain("requirement: 'owner'");
    }
  });

  test('player item routes authenticate before validating user-controlled identities and fields', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../pages/api/play-admin/players/[subjectId].ts'),
      'utf8',
    );
    const authorization = source.indexOf('await authorizePlayerAdmin(req, res, requirement)');
    const inputValidation = source.indexOf('parsePlayerItemOperation(');

    expect(authorization).toBeGreaterThan(-1);
    expect(authorization).toBeLessThan(inputValidation);
    expect(source).toContain('playerItemRequirement(req.method, req.body)');
    expect(() => parsePlayerItemOperation('PATCH', 'invalid', { displayName: '玩家' }))
      .toThrow('玩家身份无效');
    expect(() => parsePlayerItemOperation('PATCH', '0'.repeat(32), { role: 'admin' }))
      .toThrow('玩家账号不能授予后台权限');
    expect(() => parsePlayerItemOperation('PATCH', '0'.repeat(32), { avatar: 'removed' }))
      .toThrow('玩家头像上传功能已停用');
  });
});
