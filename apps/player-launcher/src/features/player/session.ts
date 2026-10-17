import type { PlayerLauncherState } from '../../types';

export const SESSION_EXPIRED_MESSAGE = '登录状态已过期，请重新登录。';

/** Switch only the current server to its login view and discard account-scoped data. */
export function expirePlayerSession(state:PlayerLauncherState, serverId:string):boolean {
    if (state.selectedId !== serverId) {
        return false;
    }
    const username =
        state.player?.username ||
        (state.loginDraft?.serverId === serverId ? state.loginDraft.username : '');
    state.player = null;
    state.loginDraft = { serverId, username, password: '', passwordVisible: false };
    state.page = 'servers';
    if (state.serverBootstrap) {
        state.serverBootstrap = { ...state.serverBootstrap, loginRequired: true };
    }
    state.authError = SESSION_EXPIRED_MESSAGE;
    state.error = '';
    state.notice = '';
    state.mapsError = '';
    state.worlds = [];
    state.recentWorlds = [];
    state.favoriteMapIds = [];
    state.mapSearch = '';
    state.mapFilter = 'all';
    state.libraryEnabled = false;
    state.libraryLoading = false;
    state.libraryError = '';
    state.pendingFavoriteMapIds = [];
    state.playerMenuOpen = false;
    state.playerSettingsOpen = false;
    state.playerProfileName = '';
    state.playerProfileError = '';
    state.busy = false;
    state.preparingMapId = '';
    state.launchStage = '';
    return true;
}

// A -> B -> A must also reject the first A request, not just compare server IDs.
const serverLoads = new WeakMap<object, number>();
export function beginServerLoad(state:PlayerLauncherState):() => boolean {
    serverLoads.set(state, (serverLoads.get(state) || 0) + 1);
    return currentServerLoad(state);
}
export function currentServerLoad(state:PlayerLauncherState):() => boolean {
    const version = serverLoads.get(state) || 0;
    const serverId = state.selectedId;
    return () => state.selectedId === serverId && (serverLoads.get(state) || 0) === version;
}
