import fs from 'node:fs';
import path from 'node:path';

import { describePlayerAdminAuditAction } from '@box/player-policy';

const playerIdentitySource = fs.readFileSync(
  path.resolve(__dirname, 'local-player-identity.ts'),
  'utf8',
);
const adminIdentitySource = fs.readFileSync(
  path.resolve(__dirname, 'player-admin-identity.ts'),
  'utf8',
);

function functionSource(source: string, name: string, nextName?: string) {
  const start = source.indexOf(`export async function ${name}`);
  const nextStart = nextName
    ? source.indexOf(`export async function ${nextName}`, start + 1)
    : -1;
  const end = nextStart === -1 ? source.length : nextStart;
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('player administration audit integrity', () => {
  test('records player deletion only after a row was actually deleted', () => {
    const source = functionSource(playerIdentitySource, 'deleteManagedPlayer');
    expect(source).toContain('DELETE FROM ${table(\'principals\')} WHERE id = $1 RETURNING id');
    expect(source.indexOf("await audit(client, 'player.delete'")).toBeGreaterThan(
      source.indexOf('if (!result.rowCount)'),
    );
  });

  test('records administrator and permission-group deletion only after affected-row checks', () => {
    const accountDelete = functionSource(
      adminIdentitySource,
      'deletePlayerAdminAccount',
      'listPlayerAdminPermissionGroups',
    );
    const groupDelete = functionSource(adminIdentitySource, 'deletePlayerAdminPermissionGroup');
    for (const source of [accountDelete, groupDelete]) {
      expect(source).toContain('RETURNING id');
      expect(source.indexOf('await auditAdminAction(')).toBeGreaterThan(
        source.indexOf('if (!deleted.rowCount)'),
      );
    }
  });

  test('refuses to delete a permission group while an administrator still uses it', () => {
    const groupDelete = functionSource(adminIdentitySource, 'deletePlayerAdminPermissionGroup');
    expect(groupDelete).toContain("WHERE permission_group_id = $1");
    expect(groupDelete).toContain('if (adminCount > 0)');
    expect(groupDelete).toContain('仍有 ${adminCount} 个管理账号使用，无法删除');
    expect(groupDelete.indexOf('if (adminCount > 0)')).toBeLessThan(
      groupDelete.indexOf('const deleted = await client.query'),
    );
  });

  test('includes administrator account, permission-group and administrator login events', () => {
    expect(playerIdentitySource).toContain("FROM ${table('admin_audit_events')} aa");
    expect(playerIdentitySource).toContain("FROM ${table('admin_login_events')} al");
    expect(describePlayerAdminAuditAction('admin.account.delete')).toEqual({
      label: '删除管理账号',
      category: 'administrator',
      severity: 'destructive',
    });
    expect(describePlayerAdminAuditAction('admin.permission-group.update').label).toBe(
      '修改权限组',
    );
    expect(describePlayerAdminAuditAction('admin.login.failed').label).toBe(
      '管理账号登录失败',
    );
    expect(describePlayerAdminAuditAction('future.action')).toEqual({
      label: 'future.action',
      category: 'unknown',
      severity: 'info',
    });
    expect(describePlayerAdminAuditAction('__proto__')).toEqual({
      label: '__proto__',
      category: 'unknown',
      severity: 'info',
    });
  });

  test('skips audit writes for unchanged edits and empty maintenance', () => {
    const updateSource = functionSource(
      playerIdentitySource,
      'updateManagedPlayer',
      'revokeManagedPlayerSession',
    );
    expect(updateSource).toContain('if (changed) {');
    expect(updateSource).not.toMatch(
      /if \(!changed\)[\s\S]*getManagedPlayerDetails\(subjectId\)/,
    );
    expect(updateSource.indexOf('client.release();')).toBeLessThan(
      updateSource.lastIndexOf('getManagedPlayerDetails(subjectId)'),
    );
    expect(playerIdentitySource).toContain('if (result.rowCount) {');
    expect(adminIdentitySource.match(/if \(unchanged\) \{/g)).toHaveLength(2);
  });
});
