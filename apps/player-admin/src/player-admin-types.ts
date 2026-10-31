/** UI-only compositions for Player Admin. HTTP records come from @box/apis. */
import type {
    Activity,
    Actor,
    Admin,
    ContainerCatalog,
    ContainerMap,
    ContainerMapChoice,
    ContainerProfile,
    ContainerResourceGroup,
    Group,
    IdentityBan,
    PlayMap,
    PlayMapResourceStatus,
    Player,
    RuntimeStatus,
} from '@box/apis';
import type { PlayerAdminView } from '@box/player-policy/navigation';

export type {
    Activity,
    Actor,
    Admin,
    ContainerCatalog,
    ContainerMap,
    ContainerMapChoice,
    ContainerProfile,
    ContainerResourceGroup,
    Group,
    IdentityBan,
    PlayMap,
    PlayMapResourceStatus,
    Player,
    RuntimeStatus,
};

export type Detail = {
    player:Player;
    cliTokens:Array<{
        id:string;
        name:string;
        scopes:string[];
        createdAt:string;
        lastUsedAt?:string;
        lastUsedIp?:string;
        revokedAt?:string;
    }>;
    sessions:Array<{
        sessionId:string;
        createdAt:string;
        lastSeenAt:string;
        expiresAt?:string;
        createdIp?:string;
        lastSeenIp?:string;
        userAgent:string;
        deviceHash?:string;
        deviceId?:string;
    }>;
    loginHistory:Array<{
        createdAt:string;
        ip:string;
        userAgent:string;
        deviceHash?:string;
        deviceId?:string;
    }>;
    adminHistory:Array<{
        id:string;
        action:string;
        actor:string;
        actorDisplayName:string;
        createdAt:string;
    }>;
    relatedAccounts:Array<{
        subjectId:string;
        displayName:string;
        username:string;
        sharedIp:string;
        lastSeenAt:string;
    }>;
    identityBans:Array<{
        id:string;
        kind:'ip' | 'device';
        displayValue:string;
        reason:string;
        bannedAt:string;
        bannedUntil?:string;
    }>;
};

export type PlayMapTableRow = {
    key:string;
    kind:'group' | 'submap';
    map:PlayMap;
    mapCount?:number;
    resourceBytes?:number;
    children?:PlayMapTableRow[];
};

export type PlayBundleReview = {
    id:string;
    expiresAt:string;
    mapCount:number;
    totalBytes:number;
    blobCount:number;
    unindexedBlobCount:number;
    worlds:Array<{ id:string; name:string; mapRole:'main' | 'submap'; version:string }>;
    resources:Array<{
        id:string;
        worldId:string;
        name:string;
        kind:string;
        mimeType:string;
        bytes:number;
        previewable:boolean;
        scriptTarget?:string;
    }>;
    warnings:string[];
};

export type ContainerRuntimeRow = ContainerMap & { children?:ContainerRuntimeRow[] };

export type View = PlayerAdminView;
