import type { components } from '@box/apis';
import type { createPlayerApi } from './api/player-api';
import type { ServerCacheUsage } from '../shared/cache-types';

export type LauncherPage = 'home' | 'servers' | 'add-server' | 'packages';

export interface PlayerServer {
    id:string;
    endpoint:string;
    name:string;
}

export type SigningKey = components['schemas']['PlayerLauncherSigningKey'];

export interface ServerBootstrap extends Partial<components['schemas']['PlayerLauncherBootstrap']> {
    supported?:boolean;
    loading?:boolean;
    error?:string;
}

export type PlayerAccount = Pick<components['schemas']['PlayerLauncherSessionPlayer'], 'username'> &
    Partial<components['schemas']['PlayerLauncherSessionPlayer']> &
    Record<string, unknown>;

export type PlayWorld = Pick<components['schemas']['PlayerLauncherWorld'], 'id' | 'name'> &
    Partial<components['schemas']['PlayerLauncherWorld']> &
    Record<string, unknown>;

export interface PlayerLauncherState {
    loginDraft?:{ serverId:string; username:string; password:string; passwordVisible:boolean };
    recentWorlds:PlayWorld[];
    favoriteMapIds:string[];
    mapFilter:'all' | 'recent' | 'favorites';
    libraryEnabled:boolean;
    libraryLoading:boolean;
    libraryError:string;
    pendingFavoriteMapIds:string[];
    mapSearch?:string;
    launchStage?:string;
    activeGame?:{ serverId:string; mapId:string } | null;
    storage?:{
        loading:boolean;
        error:string;
        rows:ServerCacheUsage[];
        confirmServerId:string;
        selectedServerId?:string;
        confirmMapId?:string;
        confirmBrowser?:boolean;
    };
    servers:PlayerServer[];
    selectedId:string;
    page:LauncherPage;
    busy:boolean;
    endpointInput:string;
    editingServerId:string;
    serverNameInput:string;
    serverBootstrap:ServerBootstrap | null;
    player:PlayerAccount | null;
    playerMenuOpen:boolean;
    playerSettingsOpen:boolean;
    playerProfileName:string;
    playerProfileSkinId:string;
    playerProfileError:string;
    worlds:PlayWorld[];
    preparingMapId:string;
    authError:string;
    mapsError:string;
    confirmRemoveServerId:string;
    pendingServerEndpoint:string;
    serverAddressNotice:{ title:string; message:string } | null;
    error:string;
    notice:string;
}

export type PlayerInvoke = (command:string, payload?:Record<string, any>) => Promise<any>;
export type RemoteApi = ReturnType<typeof createPlayerApi>;
