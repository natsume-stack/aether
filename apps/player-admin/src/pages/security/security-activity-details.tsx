import { Collapse, Descriptions, Modal, Tag } from 'antd';
import { describePlayerAdminAuditAction } from '@box/player-policy';

import { dateTime } from '../../player-admin-format';
import { permissionOptions } from '../access/map-authorization-fields';

import type { Activity } from '../../player-admin-types';

export const activityActionName = (action:string) => describePlayerAdminAuditAction(action).label;
export const isScriptActivity = (row:Activity) =>
    row.details?.source === 'map-script' ||
    row.actor.startsWith('script-key:') ||
    /^script\.(banPlayer|banCurrentIP|banCurrentDevice|revokeBan|getPlayerStatus|listBans|getBan)$/.test(
        row.action,
    );
export function activityTarget(row:Activity) {
    const details = row.details || {};
    const authorization = /^script\.(key\.|binding\.|authorization\.)/.test(row.action);
    const fallback = row.displayName || row.username || '—';
    const id = String(
        details.targetId ||
            details.mapId ||
            row.subjectId ||
            (authorization ? row.username : '') ||
            '',
    );
    return {
        name: String(
            details.targetName ||
                (authorization ? details.mapName : '') ||
                (authorization && (fallback === id || /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(fallback))
                    ? '地图授权'
                    : fallback),
        ),
        id,
        kind:
            (
                {
                    'player': '玩家 ID',
                    'map': '地图 ID',
                    'map-group': '地图 ID',
                    'punishment': '处罚 ID',
                } as Record<string, string>
            )[String(details.targetType)] ||
            (authorization
                ? details.mapId
                    ? '地图 ID'
                    : '授权 ID'
                : row.subjectId
                  ? '玩家身份 ID'
                  : '对象 ID'),
    };
}
export function ActivityResult({ row }:{ row:Activity }) {
    const outcome = String(
        row.details?.outcome || (row.action.endsWith('.failed') ? 'failure' : 'success'),
    );
    return (
        <Tag color={outcome === 'success' ? 'green' : outcome === 'denied' ? 'orange' : 'red'}>
            {outcome === 'success' ? '成功' : outcome === 'denied' ? '已拒绝' : '失败'}
        </Tag>
    );
}

export function SecurityActivityDetails({
    event,
    onClose,
}:{
    event?:Activity;
    onClose:() => void;
}) {
    const details = event?.details || {};
    const target = event && activityTarget(event);
    const result =
        details.result && typeof details.result === 'object'
            ? (details.result as Record<string, unknown>)
            : {};
    const duration =
        details.durationSeconds === 0
            ? '永久'
            : details.durationSeconds !== undefined
              ? `${details.durationSeconds} 秒`
              : undefined;
    const rows:Array<[string, unknown]> = [
        ['操作', event && activityActionName(event.action)],
        ['时间', event && dateTime(event.createdAt)],
        ['操作人', event?.actorDisplayName || event?.actor],
        ['来源 IP', event?.ip || '—'],
        ['对象', target?.name],
        ['地图', details.mapName],
        ['调用 API', details.api],
        [
            '处罚范围',
            details.scope === 'server' ? '全服' : details.scope === 'map' ? '本图' : undefined,
        ],
        [
            '处罚类型',
            ({ account: '账号', ip: 'IP', device: '设备' } as Record<string, string>)[
                String(details.kind || result.kind)
            ],
        ],
        ['处罚时长', duration],
        ['原因', details.reason],
        ['错误', details.error],
        [
            '处罚到期',
            result.expiresAt === null
                ? '永久'
                : result.expiresAt
                  ? dateTime(String(result.expiresAt))
                  : undefined,
        ],
        ['授权到期', details.expiresAt ? dateTime(String(details.expiresAt)) : undefined],
        [
            '授权权限',
            Array.isArray(details.permissions)
                ? details.permissions
                      .map(
                          (p) => permissionOptions.find((option) => option.value === p)?.label || p,
                      )
                      .join('、')
                : undefined,
        ],
        [
            '单次封禁上限',
            details.maximumBanSeconds === 0
                ? '永久'
                : details.maximumBanSeconds
                  ? `${Number(details.maximumBanSeconds) / 60} 分钟`
                  : undefined,
        ],
        ['查询记录数', result.total],
        ['重复请求', result.replayed === true ? '复用原结果，未重复处罚' : undefined],
        [target?.kind || '对象 ID', target?.id],
        ['地图 ID', details.mapId],
        ['地图组 ID', details.groupId !== details.mapId ? details.groupId : undefined],
        ['运行实例', details.runtimeId],
        [
            '运行端',
            details.runtimeMode === 'edit'
                ? '创作端'
                : details.runtimeMode === 'play'
                  ? '游玩端'
                  : undefined,
        ],
        ['授权 ID', details.authorizationId || details.keyId],
        ['请求 ID', details.requestId],
        ['处罚 ID', details.banId || result.id],
        ['目标 IP', details.targetIp],
        ['操作标识', event?.action],
        ['响应状态', details.statusCode],
        ['客户端', event?.userAgent || details.actorUserAgent],
    ];
    const seen = new Set<string>();
    return (
        <Modal
            title="安全记录详情"
            open={Boolean(event)}
            onCancel={onClose}
            footer={null}
            width={760}
            bodyStyle={{ maxHeight: '70vh', overflowY: 'auto' }}
        >
            {event && (
                <>
                    <Descriptions bordered column={1} size="small">
                        <Descriptions.Item label="结果">
                            <ActivityResult row={event} />
                        </Descriptions.Item>
                        {rows
                            .filter(([label, value]) => {
                                if (
                                    value === undefined ||
                                    value === null ||
                                    value === '' ||
                                    seen.has(label)
                                ) {
                                    return false;
                                }
                                seen.add(label);
                                return true;
                            })
                            .map(([label, value]) => (
                                <Descriptions.Item key={label} label={label}>
                                    <span style={{ overflowWrap: 'anywhere' }}>
                                        {String(value)}
                                    </span>
                                </Descriptions.Item>
                            ))}
                    </Descriptions>
                    <Collapse ghost style={{ marginTop: 12 }}>
                        <Collapse.Panel header="原始记录" key="raw">
                            <pre className="player-admin-audit-details">
                                {JSON.stringify(details, null, 2)}
                            </pre>
                        </Collapse.Panel>
                    </Collapse>
                </>
            )}
        </Modal>
    );
}
