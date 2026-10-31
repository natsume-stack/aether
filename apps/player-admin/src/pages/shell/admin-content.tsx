import { canOpenPlayerAdminView } from '@box/player-policy/navigation';

import { CreatorManagementPage, type CreatorPageController } from '../creator/creator-management';
import { ContainerResourceGroupsPage } from '../containers/container-resource-groups-page';
import { ContainerManagementPage } from '../containers/container-management-page';
import { ContainerProfilesPage } from '../containers/container-profiles-page';
import { OverviewPage } from '../dashboard/overview-page';
import { PlayMapsPage } from '../maps/play-maps-page';
import { SecurityActivityPage } from '../security/security-activity-page';
import { IdentityBansPage } from '../security/identity-bans-page';
import { AdminAccountsPage } from '../access/admin-accounts-page';
import { ScriptModerationPage } from '../access/script-moderation-page';
import { PermissionGroupsPage } from '../access/permission-groups-page';
import { PlayerDirectoryPage } from '../players/player-directory-page';

import type { ReactElement } from 'react';
import type { PlayerAdminRequirement } from '@box/player-policy';
import type { Actor, View } from '../../player-admin-types';
import type { useOwnerManagement } from '../access/use-owner-management';
import type { useSecurityManagement } from '../security/use-security-management';
import type { usePlayerDirectory } from '../players/use-player-directory';
import type { playerDirectoryColumns } from '../players/player-directory-columns';

export interface AdminContentOptions {
    actor:Actor;
    view:View;
    directory:ReturnType<typeof usePlayerDirectory>;
    owner:ReturnType<typeof useOwnerManagement>;
    security:ReturnType<typeof useSecurityManagement>;
    creatorPageController:CreatorPageController;
    columns:ReturnType<typeof playerDirectoryColumns>;
    overviewLoading:boolean;
    totals:Record<string, number>;
    isOwner:boolean;
    can:(permission:PlayerAdminRequirement) => boolean;
    load:() => Promise<void>;
    navigate:(view:View) => void;
}

/** Select a business view without owning requests, permissions or dialog state. */
export function PlayerAdminContent({
    actor,
    view,
    directory,
    owner,
    security,
    creatorPageController,
    columns,
    overviewLoading,
    totals,
    isOwner,
    can,
    load,
    navigate,
}:AdminContentOptions):ReactElement {
    let body:ReactElement;
    if (view === 'creator-access' || view === 'creator-tokens') {
        body = <CreatorManagementPage mode={view} controller={creatorPageController} />;
    } else if (view === 'play-maps') {
        body = <PlayMapsPage canManage={can('play-maps.manage')} />;
    } else if (view === 'container-play') {
        body = <ContainerManagementPage mode="play" canManage={can('containers.manage')} />;
    } else if (view === 'container-creator') {
        body = <ContainerManagementPage mode="creator" canManage={can('containers.manage')} />;
    } else if (view === 'container-profiles') {
        body = <ContainerProfilesPage canManage={can('containers.manage')} />;
    } else if (view === 'container-resource-groups') {
        body = <ContainerResourceGroupsPage canManage={can('containers.manage')} />;
    } else if (view === 'overview') {
        body = (
            <OverviewPage
                loading={overviewLoading}
                totals={totals}
                canViewSecurity={canOpenPlayerAdminView(actor, 'security')}
                isOwner={isOwner}
                refresh={() => void load()}
                navigate={navigate}
            />
        );
    } else if (view === 'players' || view === 'online-sessions' || view === 'account-bans') {
        body = (
            <PlayerDirectoryPage
                mode={view}
                loading={directory.loading}
                players={directory.players}
                columns={columns}
                total={directory.total}
                page={directory.page}
                pageSize={directory.pageSize}
                search={directory.search}
                identity={directory.identity}
                selectedIds={directory.selectedIds}
                exporting={directory.exporting}
                canExport={can('players.export')}
                canCreate={can('players.create')}
                refresh={() => void load()}
                exportPlayers={() => void directory.exportPlayers()}
                createPlayer={directory.createDialog.show}
                openDetails={directory.openDetails}
                batchPlayers={directory.batchPlayers}
                setPage={directory.setPage}
                setPageSize={directory.setPageSize}
                setSearch={directory.setSearch}
                setIdentity={directory.setIdentity}
                setSelectedIds={directory.setSelectedIds}
            />
        );
    } else if (view === 'identity-bans') {
        body = (
            <IdentityBansPage
                {...security.identityBans}
                canManage={can('identity-bans.manage')}
                refresh={() => void load()}
            />
        );
    } else if (view === 'security') {
        body = <SecurityActivityPage {...security.activity} refresh={() => void load()} />;
    } else if (view === 'script-moderation') {
        body = <ScriptModerationPage />;
    } else if (view === 'admins') {
        body = (
            <AdminAccountsPage
                admins={owner.admins}
                loading={owner.loading}
                refresh={owner.load}
                edit={owner.adminDialog.openEditor}
                remove={owner.removeAdmin}
                toggleStatus={owner.toggleAdminStatus}
            />
        );
    } else {
        body = (
            <PermissionGroupsPage
                groups={owner.groups}
                loading={owner.loading}
                refresh={owner.load}
                edit={owner.groupDialog.openEditor}
                remove={owner.removeGroup}
            />
        );
    }

    return body;
}
