import { message } from 'antd';
import { useCallback, useState } from 'react';

import { useAdminRequest } from '../../hooks/use-admin-request';
import { reportAdminError } from '../../player-admin-errors';
import { playerAdminApi as api } from '../../player-admin-api';

import type { Activity, IdentityBan } from '../../player-admin-types';

/** Owns paged audit records and active IP/device bans. */
export function useSecurityManagement() {
    const [activity, setActivity] = useState<Activity[]>([]);
    const [activityTotal, setActivityTotal] = useState(0);
    const { loading: activityLoading, run: requestActivity } = useAdminRequest();
    const [activityPage, setActivityPage] = useState(1);
    const [activityPageSize, setActivityPageSize] = useState(30);
    const [activityKind, setActivityKind] = useState('all');
    const [activitySearch, setActivitySearch] = useState('');
    const [identityBans, setIdentityBans] = useState<IdentityBan[]>([]);
    const [identityBanTotal, setIdentityBanTotal] = useState(0);
    const { loading: identityBanLoading, run: requestIdentityBans } = useAdminRequest();
    const [identityBanSearch, setIdentityBanSearch] = useState('');
    const [identityBanKind, setIdentityBanKind] = useState<'all' | 'ip' | 'device'>('all');
    const [identityBanPage, setIdentityBanPage] = useState(1);
    const [identityBanPageSize, setIdentityBanPageSize] = useState(30);

    const loadActivity = useCallback(
        () =>
            requestActivity(async () => {
                const result = await api.getApiPlayAdminActivity({
                    params: {
                        query: {
                            page: String(activityPage),
                            pageSize: String(activityPageSize),
                            kind: activityKind,
                            search: activitySearch,
                        },
                    },
                });
                setActivity(result.events || []);
                setActivityTotal(result.total || 0);
            }),
        [requestActivity, activityKind, activityPage, activityPageSize, activitySearch],
    );

    const loadIdentityBans = useCallback(
        () =>
            requestIdentityBans(async () => {
                const result = await api.getApiPlayAdminIdentityBans({
                    params: {
                        query: {
                            search: identityBanSearch,
                            kind: identityBanKind,
                            page: String(identityBanPage),
                            pageSize: String(identityBanPageSize),
                        },
                    },
                });
                setIdentityBans(result.bans || []);
                setIdentityBanTotal(result.total || 0);
            }),
        [
            requestIdentityBans,
            identityBanKind,
            identityBanPage,
            identityBanPageSize,
            identityBanSearch,
        ],
    );

    const revokeIdentityBan = async (ban:IdentityBan) => {
        try {
            await api.postApiPlayAdminIdentityBans({ body: { banId: ban.id } });
            message.success(`${ban.kind === 'ip' ? 'IP' : '设备'}封禁已解除`);
            await loadIdentityBans();
        } catch (error) {
            reportAdminError(error);
        }
    };

    return {
        activity: {
            events: activity,
            total: activityTotal,
            loading: activityLoading,
            page: activityPage,
            pageSize: activityPageSize,
            kind: activityKind,
            search: activitySearch,
            load: loadActivity,
            setPage: setActivityPage,
            setPageSize: setActivityPageSize,
            setKind: setActivityKind,
            setSearch: setActivitySearch,
        },
        identityBans: {
            bans: identityBans,
            total: identityBanTotal,
            loading: identityBanLoading,
            page: identityBanPage,
            pageSize: identityBanPageSize,
            kind: identityBanKind,
            search: identityBanSearch,
            load: loadIdentityBans,
            revoke: revokeIdentityBan,
            setPage: setIdentityBanPage,
            setPageSize: setIdentityBanPageSize,
            setKind: setIdentityBanKind,
            setSearch: setIdentityBanSearch,
        },
    };
}
