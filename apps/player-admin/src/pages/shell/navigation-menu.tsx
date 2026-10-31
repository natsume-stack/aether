import { Menu as AntMenu } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import {
    canOpenPlayerAdminView,
    type PlayerAdminNavigationActor,
    type PlayerAdminView,
} from '@box/player-policy/navigation';

import type { ComponentProps } from 'react';

type MenuGroup =
    | 'player-center'
    | 'security-center'
    | 'creator-center'
    | 'play-center'
    | 'container-center'
    | 'owner-center';

const groups:Record<MenuGroup, readonly PlayerAdminView[]> = {
    'player-center': ['players', 'online-sessions'],
    'security-center': ['account-bans', 'identity-bans', 'security'],
    'creator-center': ['creator-access', 'creator-tokens'],
    'play-center': ['play-maps'],
    'container-center': [
        'container-play',
        'container-creator',
        'container-profiles',
        'container-resource-groups',
    ],
    'owner-center': ['admins', 'permission-groups', 'script-moderation', 'ai-providers'],
};

const labels:Record<PlayerAdminView, string> = {
    'overview': '管理概览',
    'players': '玩家账号',
    'online-sessions': '在线会话',
    'account-bans': '账号封禁',
    'identity-bans': 'IP / 设备封禁',
    'security': '安全记录',
    'admins': '管理账号',
    'permission-groups': '权限组',
    'script-moderation': '地图授权',
    'ai-providers': 'AI 渠道',
    'play-maps': '游玩地图',
    'container-play': '游玩端',
    'container-creator': '创作端',
    'container-profiles': '容器配置',
    'container-resource-groups': '资源组',
    'creator-access': '创作权限',
    'creator-tokens': 'CLI 令牌',
};

const groupLabels:Record<MenuGroup, string> = {
    'player-center': '玩家管理',
    'security-center': '安全管理',
    'creator-center': '创作管理',
    'play-center': '游玩管理',
    'container-center': '容器管理',
    'owner-center': '服主管理',
};

export function buildPlayerAdminMenuItems(actor:PlayerAdminNavigationActor) {
    return (Object.entries(groups) as Array<[MenuGroup, readonly PlayerAdminView[]]>)
        .map(([key, views]) => ({
            key,
            label: groupLabels[key],
            children: views
                .filter((view) => view !== 'overview' && canOpenPlayerAdminView(actor, view))
                .map((view) => ({ key: view, label: labels[view] })),
        }))
        .filter((group) => group.children.length);
}

/**
 * Keeps expanded sections independent. Selecting a page opens its section,
 * while manually opened sections remain open until the operator closes them.
 */
function groupForView(view:string):MenuGroup | undefined {
    return (Object.entries(groups) as Array<[MenuGroup, readonly PlayerAdminView[]]>).find(
        ([, views]) => views.includes(view as PlayerAdminView),
    )?.[0];
}

export function PlayerAdminNavigationMenu(props:ComponentProps<typeof AntMenu>) {
    const selectedView = String(props.selectedKeys?.[0] || '');
    const activeGroup = useMemo(() => groupForView(selectedView), [selectedView]);
    const [openKeys, setOpenKeys] = useState<string[]>(() => (activeGroup ? [activeGroup] : []));

    useEffect(() => {
        if (!activeGroup) {
            return;
        }
        setOpenKeys((current) =>
            current.includes(activeGroup) ? current : [...current, activeGroup],
        );
    }, [activeGroup]);

    return (
        <AntMenu
            {...props}
            openKeys={openKeys}
            onOpenChange={(keys) => setOpenKeys(keys as string[])}
        />
    );
}
