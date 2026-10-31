import {
    PLAYER_ADMIN_CAPABILITY_META,
    PLAYER_ADMIN_GRANTABLE_CAPABILITIES,
} from '@box/player-policy';
import { PLAYER_ADMIN_PERMISSION_MENU } from '@box/player-policy/permission-menu';

const isReadCapability = (capability:string) =>
    capability.endsWith('.view') || capability === 'players.export';

const requiredViewByEdit:Record<string, string> = {
    'players.manage': 'players.view',
    'players.create': 'players.view',
    'passwords.reset': 'players.view',
    'players.delete': 'players.view',
    'sessions.manage': 'sessions.view',
    'players.ban': 'account-bans.view',
    'identity-bans.manage': 'identity-bans.view',
    'creator-access.manage': 'creator-access.view',
    'creator-tokens.manage': 'creator-tokens.view',
    'play-maps.manage': 'play-maps.view',
    'containers.manage': 'containers.view',
};

/** Editing a feature always grants the matching view capability. */
export const expandPermissionSelection = (values:string[] = []) => {
    const selected = new Set(capabilityLeaves(values));
    for (const capability of selected) {
        const requiredView = requiredViewByEdit[capability];
        if (requiredView) {
            selected.add(requiredView);
        }
    }
    return [...selected];
};

export const isViewRequiredBySelection = (viewCapability:string, values:string[] = []) =>
    capabilityLeaves(values).some(
        (capability) => requiredViewByEdit[capability] === viewCapability,
    );

const capabilityNode = (capability:string) => ({
    value: capability,
    title: (
        <span className="player-admin-permission-option">
            <strong>
                {
                    PLAYER_ADMIN_CAPABILITY_META[
                        capability as keyof typeof PLAYER_ADMIN_CAPABILITY_META
                    ].label
                }
            </strong>
        </span>
    ),
});

/** UI-only category values make category-wide selection possible; callers must persist leaves only. */
export const permissionTree = PLAYER_ADMIN_PERMISSION_MENU.map((category) => ({
    key: `category:${category.key}`,
    value: `category:${category.key}`,
    title: category.title,
    selectable: false,
    children: category.sections.map((section) => ({
        key: `category:${category.key}:${section.key}`,
        value: `category:${category.key}:${section.key}`,
        title: section.title,
        selectable: false,
        children: (
            [
                ['read', '查看', section.capabilities.filter(isReadCapability)],
                [
                    'write',
                    '编辑',
                    section.capabilities.filter((capability) => !isReadCapability(capability)),
                ],
            ] as const
        )
            .filter(([, , capabilities]) => capabilities.length)
            .map(([mode, title, capabilities]) => ({
                key: `category:${category.key}:${section.key}:${mode}`,
                value: `category:${category.key}:${section.key}:${mode}`,
                title,
                selectable: false,
                children: capabilities
                    .filter((capability) =>
                        PLAYER_ADMIN_GRANTABLE_CAPABILITIES.includes(capability as never),
                    )
                    .map(capabilityNode),
            })),
    })),
}));

export const capabilityLeaves = (values:string[] = []) =>
    values.filter((value) => !value.startsWith('category:'));
