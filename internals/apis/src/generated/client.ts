/**
 * Generated from openapi/openapi.json. Do not edit by hand.
 *
 * Every Local Engine HTTP operation is exposed as a named method so callers
 * never need to duplicate a route or HTTP verb.
 */
import createClient, {
  type Client,
  type ClientOptions,
  type FetchResponse,
  type PathBasedClient,
  wrapAsPathBasedClient,
} from 'openapi-fetch';

import type { paths } from './openapi';

export const apiOperations = {
  "deleteApiCreatorModelsId": {
    "path": "/api/creator-models/{id}",
    "method": "DELETE"
  },
  "deleteApiCreatorV1ProjectsProjectIdSceneSession": {
    "path": "/api/creator/v1/projects/{projectId}/scene/session",
    "method": "DELETE"
  },
  "deleteApiCreatorV1ProjectsProjectIdStorageScopeSpace": {
    "path": "/api/creator/v1/projects/{projectId}/storage/{scope}/{space}",
    "method": "DELETE"
  },
  "deleteApiLocalModelsId": {
    "path": "/api/local/models/{id}",
    "method": "DELETE"
  },
  "deleteApiLocalModelsIdEditLock": {
    "path": "/api/local/models/{id}/edit-lock",
    "method": "DELETE"
  },
  "deleteApiLocalProjectsId": {
    "path": "/api/local-projects/{id}",
    "method": "DELETE"
  },
  "deleteApiPlayAdminAdminsId": {
    "path": "/api/play-admin/admins/{id}",
    "method": "DELETE"
  },
  "deleteApiPlayAdminAiProvidersId": {
    "path": "/api/play-admin/ai-providers/{id}",
    "method": "DELETE"
  },
  "deleteApiPlayAdminAiProvidersPath": {
    "path": "/api/play-admin/ai-providers/{path}",
    "method": "DELETE"
  },
  "deleteApiPlayAdminContainerResourceGroupsId": {
    "path": "/api/play-admin/container-resource-groups/{id}",
    "method": "DELETE"
  },
  "deleteApiPlayAdminContainersPermanentMapId": {
    "path": "/api/play-admin/containers/{permanentMapId}",
    "method": "DELETE"
  },
  "deleteApiPlayAdminImport": {
    "path": "/api/play-admin/import",
    "method": "DELETE"
  },
  "deleteApiPlayAdminLibraryImport": {
    "path": "/api/play-admin/library/import",
    "method": "DELETE"
  },
  "deleteApiPlayAdminLibrarySection": {
    "path": "/api/play-admin/library/{section}",
    "method": "DELETE"
  },
  "deleteApiPlayAdminLibrarySectionId": {
    "path": "/api/play-admin/library/{section}/{id}",
    "method": "DELETE"
  },
  "deleteApiPlayAdminPermissionGroupsId": {
    "path": "/api/play-admin/permission-groups/{id}",
    "method": "DELETE"
  },
  "deleteApiPlayAdminPlayersSubjectId": {
    "path": "/api/play-admin/players/{subjectId}",
    "method": "DELETE"
  },
  "deleteApiPlayAdminWorldsId": {
    "path": "/api/play-admin/worlds/{id}",
    "method": "DELETE"
  },
  "deleteApiPlayerAiPath": {
    "path": "/api/player-ai/{path}",
    "method": "DELETE"
  },
  "deleteApiPlayPresence": {
    "path": "/api/play-presence",
    "method": "DELETE"
  },
  "deleteApiRuntimeContainerId": {
    "path": "/api/runtime/{container_id}",
    "method": "DELETE"
  },
  "getApiAgentV1LiveAction": {
    "path": "/api/agent/v1/live/{action}",
    "method": "GET"
  },
  "getApiAgentV1LiveManifest": {
    "path": "/api/agent/v1/live/manifest",
    "method": "GET"
  },
  "getApiAgentV1LiveMapProjectIdObserve": {
    "path": "/api/agent/v1/live/map/{projectId}/observe",
    "method": "GET"
  },
  "getApiAgentV1LiveMapProjectIdStatus": {
    "path": "/api/agent/v1/live/map/{projectId}/status",
    "method": "GET"
  },
  "getApiAgentV1LiveNext": {
    "path": "/api/agent/v1/live/next",
    "method": "GET"
  },
  "getApiAgentV1LiveStatus": {
    "path": "/api/agent/v1/live/status",
    "method": "GET"
  },
  "getApiAgentV1LiveVoxaAction": {
    "path": "/api/agent/v1/live/voxa/{action}",
    "method": "GET"
  },
  "getApiAgentV1MapProjectIdAction": {
    "path": "/api/agent/v1/map/{projectId}/{action}",
    "method": "GET"
  },
  "getApiAgentV1Models": {
    "path": "/api/agent/v1/models",
    "method": "GET"
  },
  "getApiAgentV1ModelsIdContext": {
    "path": "/api/agent/v1/models/{id}/context",
    "method": "GET"
  },
  "getApiAgentV1State": {
    "path": "/api/agent/v1/state",
    "method": "GET"
  },
  "getApiAuthSession": {
    "path": "/api/auth/session",
    "method": "GET"
  },
  "getApiBackupsArchiveDownload": {
    "path": "/api/backups/{archive}/download",
    "method": "GET"
  },
  "getApiConfigSlug": {
    "path": "/api/config/{slug}",
    "method": "GET"
  },
  "getApiCreatorModels": {
    "path": "/api/creator-models",
    "method": "GET"
  },
  "getApiCreatorModelsBlobsHash": {
    "path": "/api/creator-models/blobs/{hash}",
    "method": "GET"
  },
  "getApiCreatorModelsIdExport": {
    "path": "/api/creator-models/{id}/export",
    "method": "GET"
  },
  "getApiCreatorPermissions": {
    "path": "/api/creator-permissions",
    "method": "GET"
  },
  "getApiCreatorV1AuthoringAudit": {
    "path": "/api/creator/v1/authoring/audit",
    "method": "GET"
  },
  "getApiCreatorV1AuthoringProjectIdPreview": {
    "path": "/api/creator/v1/authoring/{projectId}/preview",
    "method": "GET"
  },
  "getApiCreatorV1AuthoringProjectIdStatus": {
    "path": "/api/creator/v1/authoring/{projectId}/status",
    "method": "GET"
  },
  "getApiCreatorV1AuthoringProjectIdTools": {
    "path": "/api/creator/v1/authoring/{projectId}/tools",
    "method": "GET"
  },
  "getApiCreatorV1Health": {
    "path": "/api/creator/v1/health",
    "method": "GET"
  },
  "getApiCreatorV1Projects": {
    "path": "/api/creator/v1/projects",
    "method": "GET"
  },
  "getApiCreatorV1ProjectsProjectIdResources": {
    "path": "/api/creator/v1/projects/{projectId}/resources",
    "method": "GET"
  },
  "getApiCreatorV1ProjectsProjectIdRuntime": {
    "path": "/api/creator/v1/projects/{projectId}/runtime",
    "method": "GET"
  },
  "getApiCreatorV1ProjectsProjectIdRuntimeEvents": {
    "path": "/api/creator/v1/projects/{projectId}/runtime/events",
    "method": "GET"
  },
  "getApiCreatorV1ProjectsProjectIdSceneAction": {
    "path": "/api/creator/v1/projects/{projectId}/scene/action",
    "method": "GET"
  },
  "getApiCreatorV1ProjectsProjectIdSceneCapture": {
    "path": "/api/creator/v1/projects/{projectId}/scene/capture",
    "method": "GET"
  },
  "getApiCreatorV1ProjectsProjectIdSceneSession": {
    "path": "/api/creator/v1/projects/{projectId}/scene/session",
    "method": "GET"
  },
  "getApiCreatorV1ProjectsProjectIdScripts": {
    "path": "/api/creator/v1/projects/{projectId}/scripts",
    "method": "GET"
  },
  "getApiCreatorV1ProjectsProjectIdScriptsSideEntry": {
    "path": "/api/creator/v1/projects/{projectId}/scripts/{side}/{entry}",
    "method": "GET"
  },
  "getApiCreatorV1ProjectsProjectIdStorageScopeSpace": {
    "path": "/api/creator/v1/projects/{projectId}/storage/{scope}/{space}",
    "method": "GET"
  },
  "getApiDiagnosticsArchiveDownload": {
    "path": "/api/diagnostics/{archive}/download",
    "method": "GET"
  },
  "getApiGetMapInfo": {
    "path": "/api/getMapInfo",
    "method": "GET"
  },
  "getApiHealth": {
    "path": "/api/health",
    "method": "GET"
  },
  "getApiHealthCheck": {
    "path": "/api/health-check",
    "method": "GET"
  },
  "getApiInternalMapAuthoringGuard": {
    "path": "/api/internal/map-authoring/_guard",
    "method": "GET"
  },
  "getApiInternalMapAuthoringProjectIdStatus": {
    "path": "/api/internal/map-authoring/{projectId}/status",
    "method": "GET"
  },
  "getApiInternalMapAuthoringProjectIdTool": {
    "path": "/api/internal/map-authoring/{projectId}/tool",
    "method": "GET"
  },
  "getApiLocalBlobsHash": {
    "path": "/api/local/blobs/{hash}",
    "method": "GET"
  },
  "getApiLocalDefaultSkin": {
    "path": "/api/local/default-skin",
    "method": "GET"
  },
  "getApiLocalModels": {
    "path": "/api/local/models",
    "method": "GET"
  },
  "getApiLocalModelsId": {
    "path": "/api/local/models/{id}",
    "method": "GET"
  },
  "getApiLocalModelsIdEditLock": {
    "path": "/api/local/models/{id}/edit-lock",
    "method": "GET"
  },
  "getApiLocalModelsIdEvents": {
    "path": "/api/local/models/{id}/events",
    "method": "GET"
  },
  "getApiLocalModelsIdExport": {
    "path": "/api/local/models/{id}/export",
    "method": "GET"
  },
  "getApiLocalModelsIdSnapshots": {
    "path": "/api/local/models/{id}/snapshots",
    "method": "GET"
  },
  "getApiLocalProjects": {
    "path": "/api/local-projects",
    "method": "GET"
  },
  "getApiLocalProjectsAssetDistribution": {
    "path": "/api/local-projects/asset-distribution",
    "method": "GET"
  },
  "getApiLocalProjectsIdAiPublications": {
    "path": "/api/local-projects/{id}/ai-publications",
    "method": "GET"
  },
  "getApiLocalProjectsIdExport": {
    "path": "/api/local-projects/{id}/export",
    "method": "GET"
  },
  "getApiLocalProjectsIdMaps": {
    "path": "/api/local-projects/{id}/maps",
    "method": "GET"
  },
  "getApiLocalProjectsIdRuntime": {
    "path": "/api/local-projects/{id}/runtime",
    "method": "GET"
  },
  "getApiLocalProjectsIdSnapshots": {
    "path": "/api/local-projects/{id}/snapshots",
    "method": "GET"
  },
  "getApiOperationsId": {
    "path": "/api/operations/{id}",
    "method": "GET"
  },
  "getApiPlayAdminActivity": {
    "path": "/api/play-admin/activity",
    "method": "GET"
  },
  "getApiPlayAdminAdmins": {
    "path": "/api/play-admin/admins",
    "method": "GET"
  },
  "getApiPlayAdminAiProviders": {
    "path": "/api/play-admin/ai-providers",
    "method": "GET"
  },
  "getApiPlayAdminAiProvidersControl": {
    "path": "/api/play-admin/ai-providers/control",
    "method": "GET"
  },
  "getApiPlayAdminAiProvidersPath": {
    "path": "/api/play-admin/ai-providers/{path}",
    "method": "GET"
  },
  "getApiPlayAdminAiProvidersRuns": {
    "path": "/api/play-admin/ai-providers/runs",
    "method": "GET"
  },
  "getApiPlayAdminContainerResourceGroups": {
    "path": "/api/play-admin/container-resource-groups",
    "method": "GET"
  },
  "getApiPlayAdminContainers": {
    "path": "/api/play-admin/containers",
    "method": "GET"
  },
  "getApiPlayAdminIdentityBans": {
    "path": "/api/play-admin/identity-bans",
    "method": "GET"
  },
  "getApiPlayAdminImport": {
    "path": "/api/play-admin/import",
    "method": "GET"
  },
  "getApiPlayAdminImportResource": {
    "path": "/api/play-admin/import-resource",
    "method": "GET"
  },
  "getApiPlayAdminLibraryImport": {
    "path": "/api/play-admin/library/import",
    "method": "GET"
  },
  "getApiPlayAdminLibrarySection": {
    "path": "/api/play-admin/library/{section}",
    "method": "GET"
  },
  "getApiPlayAdminLibrarySectionId": {
    "path": "/api/play-admin/library/{section}/{id}",
    "method": "GET"
  },
  "getApiPlayAdminPermissionGroups": {
    "path": "/api/play-admin/permission-groups",
    "method": "GET"
  },
  "getApiPlayAdminPlayers": {
    "path": "/api/play-admin/players",
    "method": "GET"
  },
  "getApiPlayAdminPlayersExport": {
    "path": "/api/play-admin/players/export",
    "method": "GET"
  },
  "getApiPlayAdminPlayersOverview": {
    "path": "/api/play-admin/players/overview",
    "method": "GET"
  },
  "getApiPlayAdminPlayersSubjectId": {
    "path": "/api/play-admin/players/{subjectId}",
    "method": "GET"
  },
  "getApiPlayAdminScriptModeration": {
    "path": "/api/play-admin/script-moderation",
    "method": "GET"
  },
  "getApiPlayAdminSiteConfig": {
    "path": "/api/play-admin/site-config",
    "method": "GET"
  },
  "getApiPlayAdminStatus": {
    "path": "/api/play-admin/status",
    "method": "GET"
  },
  "getApiPlayAdminVerify": {
    "path": "/api/play-admin/verify",
    "method": "GET"
  },
  "getApiPlayAdminWorlds": {
    "path": "/api/play-admin/worlds",
    "method": "GET"
  },
  "getApiPlayAdminWorldsStatus": {
    "path": "/api/play-admin/worlds/status",
    "method": "GET"
  },
  "getApiPlayerAi": {
    "path": "/api/player-ai",
    "method": "GET"
  },
  "getApiPlayerAiInternal": {
    "path": "/api/player-ai-internal",
    "method": "GET"
  },
  "getApiPlayerAiInternalPath": {
    "path": "/api/player-ai-internal/{path}",
    "method": "GET"
  },
  "getApiPlayerAiPath": {
    "path": "/api/player-ai/{path}",
    "method": "GET"
  },
  "getApiPlayerAuthLoginRequired": {
    "path": "/api/player-auth/login-required",
    "method": "GET"
  },
  "getApiPlayerAuthSession": {
    "path": "/api/player-auth/session",
    "method": "GET"
  },
  "getApiPlayerInternalMapLibrary": {
    "path": "/api/player-internal/map-library",
    "method": "GET"
  },
  "getApiPlayerInternalRevocations": {
    "path": "/api/player-internal/revocations",
    "method": "GET"
  },
  "getApiPlayerLauncherBootstrap": {
    "path": "/api/player-launcher/bootstrap",
    "method": "GET"
  },
  "getApiPlayerLauncherMaps": {
    "path": "/api/player-launcher/maps",
    "method": "GET"
  },
  "getApiPlayerLauncherMapsMapIdDescriptor": {
    "path": "/api/player-launcher/maps/{mapId}/descriptor",
    "method": "GET"
  },
  "getApiPlayerLauncherMapsMapIdDownloadPlan": {
    "path": "/api/player-launcher/maps/{mapId}/download-plan",
    "method": "GET"
  },
  "getApiPlayerLoginCallback": {
    "path": "/api/player-login/callback",
    "method": "GET"
  },
  "getApiPlayerLoginStart": {
    "path": "/api/player-login/start",
    "method": "GET"
  },
  "getApiPlayLibrary": {
    "path": "/api/play-library",
    "method": "GET"
  },
  "getApiPlayPresence": {
    "path": "/api/play-presence",
    "method": "GET"
  },
  "getApiPlayResourceCacheWorld": {
    "path": "/api/play-resource-cache/{world}",
    "method": "GET"
  },
  "getApiPlaySiteConfig": {
    "path": "/api/play-site-config",
    "method": "GET"
  },
  "getApiPlayWorlds": {
    "path": "/api/play-worlds",
    "method": "GET"
  },
  "getApiProjectModels": {
    "path": "/api/project-models",
    "method": "GET"
  },
  "getApiProjectSkinPreviews": {
    "path": "/api/project-skin-previews",
    "method": "GET"
  },
  "getApiProjectSkins": {
    "path": "/api/project-skins",
    "method": "GET"
  },
  "getApiRuntimeContainerIdStats": {
    "path": "/api/runtime/{container_id}/stats",
    "method": "GET"
  },
  "getApiServerInfo": {
    "path": "/api/server-info",
    "method": "GET"
  },
  "getApiSession": {
    "path": "/api/session",
    "method": "GET"
  },
  "getApiSystemBackups": {
    "path": "/api/system/backups",
    "method": "GET"
  },
  "getApiSystemBackupsProjectIdName": {
    "path": "/api/system/backups/{projectId}/{name}",
    "method": "GET"
  },
  "getApiSystemStatus": {
    "path": "/api/system/status",
    "method": "GET"
  },
  "getBlockHash": {
    "path": "/block/{hash}",
    "method": "GET"
  },
  "getInternalCreatorPreviewRuntime": {
    "path": "/internal/creator-preview-runtime",
    "method": "GET"
  },
  "getInternalCreatorPreviewRuntimeEvents": {
    "path": "/internal/creator-preview-runtime/events",
    "method": "GET"
  },
  "getLocalRuntimeStatus": {
    "path": "/__local_runtime/status",
    "method": "GET"
  },
  "patchApiAuthProfile": {
    "path": "/api/auth/profile",
    "method": "PATCH"
  },
  "patchApiCreatorProfile": {
    "path": "/api/creator-profile",
    "method": "PATCH"
  },
  "patchApiLocalProjectsAssetDistribution": {
    "path": "/api/local-projects/asset-distribution",
    "method": "PATCH"
  },
  "patchApiLocalProjectsId": {
    "path": "/api/local-projects/{id}",
    "method": "PATCH"
  },
  "patchApiPlayAdminAdminsId": {
    "path": "/api/play-admin/admins/{id}",
    "method": "PATCH"
  },
  "patchApiPlayAdminAiProvidersControl": {
    "path": "/api/play-admin/ai-providers/control",
    "method": "PATCH"
  },
  "patchApiPlayAdminAiProvidersId": {
    "path": "/api/play-admin/ai-providers/{id}",
    "method": "PATCH"
  },
  "patchApiPlayAdminAiProvidersPath": {
    "path": "/api/play-admin/ai-providers/{path}",
    "method": "PATCH"
  },
  "patchApiPlayAdminContainerResourceGroupsId": {
    "path": "/api/play-admin/container-resource-groups/{id}",
    "method": "PATCH"
  },
  "patchApiPlayAdminLibrarySection": {
    "path": "/api/play-admin/library/{section}",
    "method": "PATCH"
  },
  "patchApiPlayAdminLibrarySectionId": {
    "path": "/api/play-admin/library/{section}/{id}",
    "method": "PATCH"
  },
  "patchApiPlayAdminPermissionGroupsId": {
    "path": "/api/play-admin/permission-groups/{id}",
    "method": "PATCH"
  },
  "patchApiPlayAdminPlayersSubjectId": {
    "path": "/api/play-admin/players/{subjectId}",
    "method": "PATCH"
  },
  "patchApiPlayAdminSiteConfig": {
    "path": "/api/play-admin/site-config",
    "method": "PATCH"
  },
  "patchApiPlayAdminWorldsId": {
    "path": "/api/play-admin/worlds/{id}",
    "method": "PATCH"
  },
  "patchApiPlayerAiPath": {
    "path": "/api/player-ai/{path}",
    "method": "PATCH"
  },
  "patchApiPlayerAuthProfile": {
    "path": "/api/player-auth/profile",
    "method": "PATCH"
  },
  "patchApiPlayerInternalMapLibrary": {
    "path": "/api/player-internal/map-library",
    "method": "PATCH"
  },
  "patchApiPlayerInternalProfile": {
    "path": "/api/player-internal/profile",
    "method": "PATCH"
  },
  "patchApiPlayLibrary": {
    "path": "/api/play-library",
    "method": "PATCH"
  },
  "patchApiPlayProfile": {
    "path": "/api/play-profile",
    "method": "PATCH"
  },
  "postApiAgentV1Join": {
    "path": "/api/agent/v1/join",
    "method": "POST"
  },
  "postApiAgentV1LiveAck": {
    "path": "/api/agent/v1/live/ack",
    "method": "POST"
  },
  "postApiAgentV1LiveAction": {
    "path": "/api/agent/v1/live/{action}",
    "method": "POST"
  },
  "postApiAgentV1LiveAttach": {
    "path": "/api/agent/v1/live/attach",
    "method": "POST"
  },
  "postApiAgentV1LiveDetach": {
    "path": "/api/agent/v1/live/detach",
    "method": "POST"
  },
  "postApiAgentV1LiveMapProjectIdCmd": {
    "path": "/api/agent/v1/live/map/{projectId}/cmd",
    "method": "POST"
  },
  "postApiAgentV1LiveMapProjectIdObserve": {
    "path": "/api/agent/v1/live/map/{projectId}/observe",
    "method": "POST"
  },
  "postApiAgentV1LiveProgress": {
    "path": "/api/agent/v1/live/progress",
    "method": "POST"
  },
  "postApiAgentV1LiveVoxaAction": {
    "path": "/api/agent/v1/live/voxa/{action}",
    "method": "POST"
  },
  "postApiAgentV1MapProjectIdAction": {
    "path": "/api/agent/v1/map/{projectId}/{action}",
    "method": "POST"
  },
  "postApiAgentV1Models": {
    "path": "/api/agent/v1/models",
    "method": "POST"
  },
  "postApiAgentV1State": {
    "path": "/api/agent/v1/state",
    "method": "POST"
  },
  "postApiAiAction": {
    "path": "/api/ai/{action}",
    "method": "POST"
  },
  "postApiAuthLogin": {
    "path": "/api/auth/login",
    "method": "POST"
  },
  "postApiAuthLogout": {
    "path": "/api/auth/logout",
    "method": "POST"
  },
  "postApiAuthPassword": {
    "path": "/api/auth/password",
    "method": "POST"
  },
  "postApiAuthRegister": {
    "path": "/api/auth/register",
    "method": "POST"
  },
  "postApiBackupsUpload": {
    "path": "/api/backups/upload",
    "method": "POST"
  },
  "postApiCommandsName": {
    "path": "/api/commands/{name}",
    "method": "POST"
  },
  "postApiCreateSession": {
    "path": "/api/createSession",
    "method": "POST"
  },
  "postApiCreatorLogout": {
    "path": "/api/creator-logout",
    "method": "POST"
  },
  "postApiCreatorModelsImport": {
    "path": "/api/creator-models/import",
    "method": "POST"
  },
  "postApiCreatorV1AuthoringProjectIdPreview": {
    "path": "/api/creator/v1/authoring/{projectId}/preview",
    "method": "POST"
  },
  "postApiCreatorV1AuthoringProjectIdSave": {
    "path": "/api/creator/v1/authoring/{projectId}/save",
    "method": "POST"
  },
  "postApiCreatorV1AuthoringProjectIdTools": {
    "path": "/api/creator/v1/authoring/{projectId}/tools",
    "method": "POST"
  },
  "postApiCreatorV1ProjectsProjectIdRuntime": {
    "path": "/api/creator/v1/projects/{projectId}/runtime",
    "method": "POST"
  },
  "postApiCreatorV1ProjectsProjectIdSceneActionsRequestId": {
    "path": "/api/creator/v1/projects/{projectId}/scene/actions/{requestId}",
    "method": "POST"
  },
  "postApiCreatorV1ProjectsProjectIdSceneSession": {
    "path": "/api/creator/v1/projects/{projectId}/scene/session",
    "method": "POST"
  },
  "postApiInternalAiPublication": {
    "path": "/api/internal/ai-publication",
    "method": "POST"
  },
  "postApiInternalMapAuthoringProjectIdPreview": {
    "path": "/api/internal/map-authoring/{projectId}/preview",
    "method": "POST"
  },
  "postApiInternalMapAuthoringProjectIdSave": {
    "path": "/api/internal/map-authoring/{projectId}/save",
    "method": "POST"
  },
  "postApiInternalMapAuthoringProjectIdTool": {
    "path": "/api/internal/map-authoring/{projectId}/tool",
    "method": "POST"
  },
  "postApiLocalBlob": {
    "path": "/api/local/blob",
    "method": "POST"
  },
  "postApiLocalModels": {
    "path": "/api/local/models",
    "method": "POST"
  },
  "postApiLocalModelsIdEditLock": {
    "path": "/api/local/models/{id}/edit-lock",
    "method": "POST"
  },
  "postApiLocalModelsImport": {
    "path": "/api/local/models/import",
    "method": "POST"
  },
  "postApiLocalProjects": {
    "path": "/api/local-projects",
    "method": "POST"
  },
  "postApiLocalProjectsIdAiPublications": {
    "path": "/api/local-projects/{id}/ai-publications",
    "method": "POST"
  },
  "postApiLocalProjectsIdMaps": {
    "path": "/api/local-projects/{id}/maps",
    "method": "POST"
  },
  "postApiLocalProjectsIdPackage": {
    "path": "/api/local-projects/{id}/package",
    "method": "POST"
  },
  "postApiLocalProjectsIdPublish": {
    "path": "/api/local-projects/{id}/publish",
    "method": "POST"
  },
  "postApiLocalProjectsIdRuntime": {
    "path": "/api/local-projects/{id}/runtime",
    "method": "POST"
  },
  "postApiLocalProjectsIdSnapshots": {
    "path": "/api/local-projects/{id}/snapshots",
    "method": "POST"
  },
  "postApiLocalProjectsImport": {
    "path": "/api/local-projects/import",
    "method": "POST"
  },
  "postApiPlayAdminAdmins": {
    "path": "/api/play-admin/admins",
    "method": "POST"
  },
  "postApiPlayAdminAiProviders": {
    "path": "/api/play-admin/ai-providers",
    "method": "POST"
  },
  "postApiPlayAdminAiProvidersIdDefault": {
    "path": "/api/play-admin/ai-providers/{id}/default",
    "method": "POST"
  },
  "postApiPlayAdminAiProvidersIdModels": {
    "path": "/api/play-admin/ai-providers/{id}/models",
    "method": "POST"
  },
  "postApiPlayAdminAiProvidersIdSharing": {
    "path": "/api/play-admin/ai-providers/{id}/sharing",
    "method": "POST"
  },
  "postApiPlayAdminAiProvidersIdTest": {
    "path": "/api/play-admin/ai-providers/{id}/test",
    "method": "POST"
  },
  "postApiPlayAdminAiProvidersPath": {
    "path": "/api/play-admin/ai-providers/{path}",
    "method": "POST"
  },
  "postApiPlayAdminContainerResourceGroups": {
    "path": "/api/play-admin/container-resource-groups",
    "method": "POST"
  },
  "postApiPlayAdminContainers": {
    "path": "/api/play-admin/containers",
    "method": "POST"
  },
  "postApiPlayAdminIdentityBans": {
    "path": "/api/play-admin/identity-bans",
    "method": "POST"
  },
  "postApiPlayAdminImport": {
    "path": "/api/play-admin/import",
    "method": "POST"
  },
  "postApiPlayAdminLibraryImport": {
    "path": "/api/play-admin/library/import",
    "method": "POST"
  },
  "postApiPlayAdminLibrarySection": {
    "path": "/api/play-admin/library/{section}",
    "method": "POST"
  },
  "postApiPlayAdminLibrarySectionId": {
    "path": "/api/play-admin/library/{section}/{id}",
    "method": "POST"
  },
  "postApiPlayAdminLogin": {
    "path": "/api/play-admin/login",
    "method": "POST"
  },
  "postApiPlayAdminLogout": {
    "path": "/api/play-admin/logout",
    "method": "POST"
  },
  "postApiPlayAdminMaintenance": {
    "path": "/api/play-admin/maintenance",
    "method": "POST"
  },
  "postApiPlayAdminOwnerSession": {
    "path": "/api/play-admin/owner-session",
    "method": "POST"
  },
  "postApiPlayAdminPermissionGroups": {
    "path": "/api/play-admin/permission-groups",
    "method": "POST"
  },
  "postApiPlayAdminPlayers": {
    "path": "/api/play-admin/players",
    "method": "POST"
  },
  "postApiPlayAdminPlayersBatch": {
    "path": "/api/play-admin/players/batch",
    "method": "POST"
  },
  "postApiPlayAdminPlayersSubjectId": {
    "path": "/api/play-admin/players/{subjectId}",
    "method": "POST"
  },
  "postApiPlayAdminScriptModeration": {
    "path": "/api/play-admin/script-moderation",
    "method": "POST"
  },
  "postApiPlayAdminSelfPassword": {
    "path": "/api/play-admin/self-password",
    "method": "POST"
  },
  "postApiPlayAdminVerify": {
    "path": "/api/play-admin/verify",
    "method": "POST"
  },
  "postApiPlayerAiPath": {
    "path": "/api/player-ai/{path}",
    "method": "POST"
  },
  "postApiPlayerAuthLogin": {
    "path": "/api/player-auth/login",
    "method": "POST"
  },
  "postApiPlayerAuthLogout": {
    "path": "/api/player-auth/logout",
    "method": "POST"
  },
  "postApiPlayerAuthPassword": {
    "path": "/api/player-auth/password",
    "method": "POST"
  },
  "postApiPlayerAuthRegister": {
    "path": "/api/player-auth/register",
    "method": "POST"
  },
  "postApiPlayerAuthTransfer": {
    "path": "/api/player-auth/transfer",
    "method": "POST"
  },
  "postApiPlayerInternalLoginTransfer": {
    "path": "/api/player-internal/login-transfer",
    "method": "POST"
  },
  "postApiPlayerInternalLogout": {
    "path": "/api/player-internal/logout",
    "method": "POST"
  },
  "postApiPlayerInternalMapAdmission": {
    "path": "/api/player-internal/map-admission",
    "method": "POST"
  },
  "postApiPlayerInternalRuntimeIdentity": {
    "path": "/api/player-internal/runtime-identity",
    "method": "POST"
  },
  "postApiPlayerInternalScriptMetadata": {
    "path": "/api/player-internal/script-metadata",
    "method": "POST"
  },
  "postApiPlayerInternalScriptModeration": {
    "path": "/api/player-internal/script-moderation",
    "method": "POST"
  },
  "postApiPlayLogout": {
    "path": "/api/play-logout",
    "method": "POST"
  },
  "postApiPlayPresence": {
    "path": "/api/play-presence",
    "method": "POST"
  },
  "postApiProjectModels": {
    "path": "/api/project-models",
    "method": "POST"
  },
  "postApiProjectScripts": {
    "path": "/api/project-scripts",
    "method": "POST"
  },
  "postApiProjectSkins": {
    "path": "/api/project-skins",
    "method": "POST"
  },
  "postApiRealtimeSession": {
    "path": "/api/realtime/session",
    "method": "POST"
  },
  "postApiRuntimeEnsure": {
    "path": "/api/runtime/ensure",
    "method": "POST"
  },
  "postApiSystemBackups": {
    "path": "/api/system/backups",
    "method": "POST"
  },
  "postBlock": {
    "path": "/block",
    "method": "POST"
  },
  "postBlockHash": {
    "path": "/block/{hash}",
    "method": "POST"
  },
  "postCreateSession": {
    "path": "/createSession",
    "method": "POST"
  },
  "postInternalSaveLocalProject": {
    "path": "/internal/save-local-project",
    "method": "POST"
  },
  "postLocalRuntimeDestroy": {
    "path": "/__local_runtime/destroy",
    "method": "POST"
  },
  "postLocalRuntimeStart": {
    "path": "/__local_runtime/start",
    "method": "POST"
  },
  "postRoomRoomIdLocalRuntimeDestroy": {
    "path": "/__room/{roomId}/__local_runtime/destroy",
    "method": "POST"
  },
  "putApiCreatorModelsId": {
    "path": "/api/creator-models/{id}",
    "method": "PUT"
  },
  "putApiCreatorV1ProjectsProjectIdScriptsSideEntry": {
    "path": "/api/creator/v1/projects/{projectId}/scripts/{side}/{entry}",
    "method": "PUT"
  },
  "putApiCreatorV1ProjectsProjectIdStorageScopeSpace": {
    "path": "/api/creator/v1/projects/{projectId}/storage/{scope}/{space}",
    "method": "PUT"
  },
  "putApiLocalDefaultSkin": {
    "path": "/api/local/default-skin",
    "method": "PUT"
  },
  "putApiLocalModelsId": {
    "path": "/api/local/models/{id}",
    "method": "PUT"
  },
  "putApiLocalModelsIdModel": {
    "path": "/api/local/models/{id}/model",
    "method": "PUT"
  },
  "putApiPlayAdminSiteConfig": {
    "path": "/api/play-admin/site-config",
    "method": "PUT"
  },
  "putApiPlayerAiPath": {
    "path": "/api/player-ai/{path}",
    "method": "PUT"
  }
} as const;

export interface ApiClientOptions extends ClientOptions {
  csrfCookie?: string;
  csrfHeader?: string;
  defaultErrorMessage?: string;
}

export class ApiClientError extends Error {
  constructor(
    message: string,
    readonly response: Response,
    readonly details: unknown,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

export class ApiClient {
  readonly raw: Client<paths>;
  private readonly paths: PathBasedClient<paths>;
  private readonly defaultErrorMessage: string;

  constructor(options: ApiClientOptions = {}) {
    const {
      csrfCookie,
      csrfHeader = 'X-CSRF-Token',
      defaultErrorMessage = '请求失败，请稍后重试',
      ...clientOptions
    } = options;
    this.defaultErrorMessage = defaultErrorMessage;
    this.raw = createClient<paths>({ credentials: 'same-origin', ...clientOptions });
    if (csrfCookie) {
      this.raw.use({
        onRequest({ request }) {
          if (typeof document === 'undefined' || /^(GET|HEAD|OPTIONS)$/i.test(request.method)) {
            return request;
          }
          const prefix = `${csrfCookie}=`;
          const entry = document.cookie.split('; ').find((item) => item.startsWith(prefix));
          if (entry) {
            request.headers.set(csrfHeader, decodeURIComponent(entry.slice(prefix.length)));
          }
          return request;
        },
      });
    }
    this.paths = wrapAsPathBasedClient(this.raw);
  }

  private async unwrap<T>(
    pending: Promise<{ data?: T; error?: unknown; response: Response }>,
  ): Promise<T> {
    const result = await pending;
    if (result.error !== undefined || !result.response.ok) {
      const details = result.error;
      const message =
        typeof details === 'string' && details.trim()
          ? details
          : details && typeof details === 'object' && 'message' in details &&
        typeof details.message === 'string'
          ? details.message
          : details && typeof details === 'object' && 'msg' in details &&
        typeof details.msg === 'string'
          ? details.msg
          : this.defaultErrorMessage;
      throw new ApiClientError(message, result.response, details);
    }
    return result.data as T;
  }

  deleteApiCreatorModelsIdRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/creator-models/{id}"]["DELETE"]>
  ) {
    return this.paths["/api/creator-models/{id}"].DELETE(...init);
  }

  deleteApiCreatorModelsId(
    ...init: Parameters<PathBasedClient<paths>["/api/creator-models/{id}"]["DELETE"]>
  ) {
    return this.unwrap(this.deleteApiCreatorModelsIdRaw(...init));
  }

  deleteApiCreatorV1ProjectsProjectIdSceneSessionRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/creator/v1/projects/{projectId}/scene/session"]["DELETE"]>
  ) {
    return this.paths["/api/creator/v1/projects/{projectId}/scene/session"].DELETE(...init);
  }

  deleteApiCreatorV1ProjectsProjectIdSceneSession(
    ...init: Parameters<PathBasedClient<paths>["/api/creator/v1/projects/{projectId}/scene/session"]["DELETE"]>
  ) {
    return this.unwrap(this.deleteApiCreatorV1ProjectsProjectIdSceneSessionRaw(...init));
  }

  deleteApiCreatorV1ProjectsProjectIdStorageScopeSpaceRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/creator/v1/projects/{projectId}/storage/{scope}/{space}"]["DELETE"]>
  ) {
    return this.paths["/api/creator/v1/projects/{projectId}/storage/{scope}/{space}"].DELETE(...init);
  }

  deleteApiCreatorV1ProjectsProjectIdStorageScopeSpace(
    ...init: Parameters<PathBasedClient<paths>["/api/creator/v1/projects/{projectId}/storage/{scope}/{space}"]["DELETE"]>
  ) {
    return this.unwrap(this.deleteApiCreatorV1ProjectsProjectIdStorageScopeSpaceRaw(...init));
  }

  deleteApiLocalModelsIdRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/local/models/{id}"]["DELETE"]>
  ) {
    return this.paths["/api/local/models/{id}"].DELETE(...init);
  }

  deleteApiLocalModelsId(
    ...init: Parameters<PathBasedClient<paths>["/api/local/models/{id}"]["DELETE"]>
  ) {
    return this.unwrap(this.deleteApiLocalModelsIdRaw(...init));
  }

  deleteApiLocalModelsIdEditLockRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/local/models/{id}/edit-lock"]["DELETE"]>
  ) {
    return this.paths["/api/local/models/{id}/edit-lock"].DELETE(...init);
  }

  deleteApiLocalModelsIdEditLock(
    ...init: Parameters<PathBasedClient<paths>["/api/local/models/{id}/edit-lock"]["DELETE"]>
  ) {
    return this.unwrap(this.deleteApiLocalModelsIdEditLockRaw(...init));
  }

  deleteApiLocalProjectsIdRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/local-projects/{id}"]["DELETE"]>
  ) {
    return this.paths["/api/local-projects/{id}"].DELETE(...init);
  }

  deleteApiLocalProjectsId(
    ...init: Parameters<PathBasedClient<paths>["/api/local-projects/{id}"]["DELETE"]>
  ) {
    return this.unwrap(this.deleteApiLocalProjectsIdRaw(...init));
  }

  deleteApiPlayAdminAdminsIdRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/admins/{id}"]["DELETE"]>
  ) {
    return this.paths["/api/play-admin/admins/{id}"].DELETE(...init);
  }

  deleteApiPlayAdminAdminsId(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/admins/{id}"]["DELETE"]>
  ) {
    return this.unwrap(this.deleteApiPlayAdminAdminsIdRaw(...init));
  }

  deleteApiPlayAdminAiProvidersIdRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/ai-providers/{id}"]["DELETE"]>
  ) {
    return this.paths["/api/play-admin/ai-providers/{id}"].DELETE(...init);
  }

  deleteApiPlayAdminAiProvidersId(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/ai-providers/{id}"]["DELETE"]>
  ) {
    return this.unwrap(this.deleteApiPlayAdminAiProvidersIdRaw(...init));
  }

  deleteApiPlayAdminAiProvidersPathRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/ai-providers/{path}"]["DELETE"]>
  ) {
    return this.paths["/api/play-admin/ai-providers/{path}"].DELETE(...init);
  }

  deleteApiPlayAdminAiProvidersPath(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/ai-providers/{path}"]["DELETE"]>
  ) {
    return this.unwrap(this.deleteApiPlayAdminAiProvidersPathRaw(...init));
  }

  deleteApiPlayAdminContainerResourceGroupsIdRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/container-resource-groups/{id}"]["DELETE"]>
  ) {
    return this.paths["/api/play-admin/container-resource-groups/{id}"].DELETE(...init);
  }

  deleteApiPlayAdminContainerResourceGroupsId(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/container-resource-groups/{id}"]["DELETE"]>
  ) {
    return this.unwrap(this.deleteApiPlayAdminContainerResourceGroupsIdRaw(...init));
  }

  deleteApiPlayAdminContainersPermanentMapIdRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/containers/{permanentMapId}"]["DELETE"]>
  ) {
    return this.paths["/api/play-admin/containers/{permanentMapId}"].DELETE(...init);
  }

  deleteApiPlayAdminContainersPermanentMapId(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/containers/{permanentMapId}"]["DELETE"]>
  ) {
    return this.unwrap(this.deleteApiPlayAdminContainersPermanentMapIdRaw(...init));
  }

  deleteApiPlayAdminImportRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/import"]["DELETE"]>
  ) {
    return this.paths["/api/play-admin/import"].DELETE(...init);
  }

  deleteApiPlayAdminImport(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/import"]["DELETE"]>
  ) {
    return this.unwrap(this.deleteApiPlayAdminImportRaw(...init));
  }

  deleteApiPlayAdminLibraryImportRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/library/import"]["DELETE"]>
  ) {
    return this.paths["/api/play-admin/library/import"].DELETE(...init);
  }

  deleteApiPlayAdminLibraryImport(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/library/import"]["DELETE"]>
  ) {
    return this.unwrap(this.deleteApiPlayAdminLibraryImportRaw(...init));
  }

  deleteApiPlayAdminLibrarySectionRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/library/{section}"]["DELETE"]>
  ) {
    return this.paths["/api/play-admin/library/{section}"].DELETE(...init);
  }

  deleteApiPlayAdminLibrarySection(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/library/{section}"]["DELETE"]>
  ) {
    return this.unwrap(this.deleteApiPlayAdminLibrarySectionRaw(...init));
  }

  deleteApiPlayAdminLibrarySectionIdRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/library/{section}/{id}"]["DELETE"]>
  ) {
    return this.paths["/api/play-admin/library/{section}/{id}"].DELETE(...init);
  }

  deleteApiPlayAdminLibrarySectionId(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/library/{section}/{id}"]["DELETE"]>
  ) {
    return this.unwrap(this.deleteApiPlayAdminLibrarySectionIdRaw(...init));
  }

  deleteApiPlayAdminPermissionGroupsIdRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/permission-groups/{id}"]["DELETE"]>
  ) {
    return this.paths["/api/play-admin/permission-groups/{id}"].DELETE(...init);
  }

  deleteApiPlayAdminPermissionGroupsId(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/permission-groups/{id}"]["DELETE"]>
  ) {
    return this.unwrap(this.deleteApiPlayAdminPermissionGroupsIdRaw(...init));
  }

  deleteApiPlayAdminPlayersSubjectIdRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/players/{subjectId}"]["DELETE"]>
  ) {
    return this.paths["/api/play-admin/players/{subjectId}"].DELETE(...init);
  }

  deleteApiPlayAdminPlayersSubjectId(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/players/{subjectId}"]["DELETE"]>
  ) {
    return this.unwrap(this.deleteApiPlayAdminPlayersSubjectIdRaw(...init));
  }

  deleteApiPlayAdminWorldsIdRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/worlds/{id}"]["DELETE"]>
  ) {
    return this.paths["/api/play-admin/worlds/{id}"].DELETE(...init);
  }

  deleteApiPlayAdminWorldsId(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/worlds/{id}"]["DELETE"]>
  ) {
    return this.unwrap(this.deleteApiPlayAdminWorldsIdRaw(...init));
  }

  deleteApiPlayerAiPathRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/player-ai/{path}"]["DELETE"]>
  ) {
    return this.paths["/api/player-ai/{path}"].DELETE(...init);
  }

  deleteApiPlayerAiPath(
    ...init: Parameters<PathBasedClient<paths>["/api/player-ai/{path}"]["DELETE"]>
  ) {
    return this.unwrap(this.deleteApiPlayerAiPathRaw(...init));
  }

  deleteApiPlayPresenceRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/play-presence"]["DELETE"]>
  ) {
    return this.paths["/api/play-presence"].DELETE(...init);
  }

  deleteApiPlayPresence(
    ...init: Parameters<PathBasedClient<paths>["/api/play-presence"]["DELETE"]>
  ) {
    return this.unwrap(this.deleteApiPlayPresenceRaw(...init));
  }

  deleteApiRuntimeContainerIdRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/runtime/{container_id}"]["DELETE"]>
  ) {
    return this.paths["/api/runtime/{container_id}"].DELETE(...init);
  }

  deleteApiRuntimeContainerId(
    ...init: Parameters<PathBasedClient<paths>["/api/runtime/{container_id}"]["DELETE"]>
  ) {
    return this.unwrap(this.deleteApiRuntimeContainerIdRaw(...init));
  }

  getApiAgentV1LiveActionRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/agent/v1/live/{action}"]["GET"]>
  ) {
    return this.paths["/api/agent/v1/live/{action}"].GET(...init);
  }

  getApiAgentV1LiveAction(
    ...init: Parameters<PathBasedClient<paths>["/api/agent/v1/live/{action}"]["GET"]>
  ) {
    return this.unwrap(this.getApiAgentV1LiveActionRaw(...init));
  }

  getApiAgentV1LiveManifestRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/agent/v1/live/manifest"]["GET"]>
  ) {
    return this.paths["/api/agent/v1/live/manifest"].GET(...init);
  }

  getApiAgentV1LiveManifest(
    ...init: Parameters<PathBasedClient<paths>["/api/agent/v1/live/manifest"]["GET"]>
  ) {
    return this.unwrap(this.getApiAgentV1LiveManifestRaw(...init));
  }

  getApiAgentV1LiveMapProjectIdObserveRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/agent/v1/live/map/{projectId}/observe"]["GET"]>
  ) {
    return this.paths["/api/agent/v1/live/map/{projectId}/observe"].GET(...init);
  }

  getApiAgentV1LiveMapProjectIdObserve(
    ...init: Parameters<PathBasedClient<paths>["/api/agent/v1/live/map/{projectId}/observe"]["GET"]>
  ) {
    return this.unwrap(this.getApiAgentV1LiveMapProjectIdObserveRaw(...init));
  }

  getApiAgentV1LiveMapProjectIdStatusRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/agent/v1/live/map/{projectId}/status"]["GET"]>
  ) {
    return this.paths["/api/agent/v1/live/map/{projectId}/status"].GET(...init);
  }

  getApiAgentV1LiveMapProjectIdStatus(
    ...init: Parameters<PathBasedClient<paths>["/api/agent/v1/live/map/{projectId}/status"]["GET"]>
  ) {
    return this.unwrap(this.getApiAgentV1LiveMapProjectIdStatusRaw(...init));
  }

  getApiAgentV1LiveNextRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/agent/v1/live/next"]["GET"]>
  ) {
    return this.paths["/api/agent/v1/live/next"].GET(...init);
  }

  getApiAgentV1LiveNext(
    ...init: Parameters<PathBasedClient<paths>["/api/agent/v1/live/next"]["GET"]>
  ) {
    return this.unwrap(this.getApiAgentV1LiveNextRaw(...init));
  }

  getApiAgentV1LiveStatusRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/agent/v1/live/status"]["GET"]>
  ) {
    return this.paths["/api/agent/v1/live/status"].GET(...init);
  }

  getApiAgentV1LiveStatus(
    ...init: Parameters<PathBasedClient<paths>["/api/agent/v1/live/status"]["GET"]>
  ) {
    return this.unwrap(this.getApiAgentV1LiveStatusRaw(...init));
  }

  getApiAgentV1LiveVoxaActionRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/agent/v1/live/voxa/{action}"]["GET"]>
  ) {
    return this.paths["/api/agent/v1/live/voxa/{action}"].GET(...init);
  }

  getApiAgentV1LiveVoxaAction(
    ...init: Parameters<PathBasedClient<paths>["/api/agent/v1/live/voxa/{action}"]["GET"]>
  ) {
    return this.unwrap(this.getApiAgentV1LiveVoxaActionRaw(...init));
  }

  getApiAgentV1MapProjectIdActionRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/agent/v1/map/{projectId}/{action}"]["GET"]>
  ) {
    return this.paths["/api/agent/v1/map/{projectId}/{action}"].GET(...init);
  }

  getApiAgentV1MapProjectIdAction(
    ...init: Parameters<PathBasedClient<paths>["/api/agent/v1/map/{projectId}/{action}"]["GET"]>
  ) {
    return this.unwrap(this.getApiAgentV1MapProjectIdActionRaw(...init));
  }

  getApiAgentV1ModelsRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/agent/v1/models"]["GET"]>
  ) {
    return this.paths["/api/agent/v1/models"].GET(...init);
  }

  getApiAgentV1Models(
    ...init: Parameters<PathBasedClient<paths>["/api/agent/v1/models"]["GET"]>
  ) {
    return this.unwrap(this.getApiAgentV1ModelsRaw(...init));
  }

  getApiAgentV1ModelsIdContextRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/agent/v1/models/{id}/context"]["GET"]>
  ) {
    return this.paths["/api/agent/v1/models/{id}/context"].GET(...init);
  }

  getApiAgentV1ModelsIdContext(
    ...init: Parameters<PathBasedClient<paths>["/api/agent/v1/models/{id}/context"]["GET"]>
  ) {
    return this.unwrap(this.getApiAgentV1ModelsIdContextRaw(...init));
  }

  getApiAgentV1StateRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/agent/v1/state"]["GET"]>
  ) {
    return this.paths["/api/agent/v1/state"].GET(...init);
  }

  getApiAgentV1State(
    ...init: Parameters<PathBasedClient<paths>["/api/agent/v1/state"]["GET"]>
  ) {
    return this.unwrap(this.getApiAgentV1StateRaw(...init));
  }

  getApiAuthSessionRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/auth/session"]["GET"]>
  ) {
    return this.paths["/api/auth/session"].GET(...init);
  }

  getApiAuthSession(
    ...init: Parameters<PathBasedClient<paths>["/api/auth/session"]["GET"]>
  ) {
    return this.unwrap(this.getApiAuthSessionRaw(...init));
  }

  getApiBackupsArchiveDownloadRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/backups/{archive}/download"]["GET"]>
  ) {
    return this.paths["/api/backups/{archive}/download"].GET(...init);
  }

  getApiBackupsArchiveDownload(
    ...init: Parameters<PathBasedClient<paths>["/api/backups/{archive}/download"]["GET"]>
  ) {
    return this.unwrap(this.getApiBackupsArchiveDownloadRaw(...init));
  }

  getApiConfigSlugRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/config/{slug}"]["GET"]>
  ) {
    return this.paths["/api/config/{slug}"].GET(...init);
  }

  getApiConfigSlug(
    ...init: Parameters<PathBasedClient<paths>["/api/config/{slug}"]["GET"]>
  ) {
    return this.unwrap(this.getApiConfigSlugRaw(...init));
  }

  getApiCreatorModelsRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/creator-models"]["GET"]>
  ) {
    return this.paths["/api/creator-models"].GET(...init);
  }

  getApiCreatorModels(
    ...init: Parameters<PathBasedClient<paths>["/api/creator-models"]["GET"]>
  ) {
    return this.unwrap(this.getApiCreatorModelsRaw(...init));
  }

  getApiCreatorModelsBlobsHashRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/creator-models/blobs/{hash}"]["GET"]>
  ) {
    return this.paths["/api/creator-models/blobs/{hash}"].GET(...init);
  }

  getApiCreatorModelsBlobsHash(
    ...init: Parameters<PathBasedClient<paths>["/api/creator-models/blobs/{hash}"]["GET"]>
  ) {
    return this.unwrap(this.getApiCreatorModelsBlobsHashRaw(...init));
  }

  getApiCreatorModelsIdExportRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/creator-models/{id}/export"]["GET"]>
  ) {
    return this.paths["/api/creator-models/{id}/export"].GET(...init);
  }

  getApiCreatorModelsIdExport(
    ...init: Parameters<PathBasedClient<paths>["/api/creator-models/{id}/export"]["GET"]>
  ) {
    return this.unwrap(this.getApiCreatorModelsIdExportRaw(...init));
  }

  getApiCreatorPermissionsRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/creator-permissions"]["GET"]>
  ) {
    return this.paths["/api/creator-permissions"].GET(...init);
  }

  getApiCreatorPermissions(
    ...init: Parameters<PathBasedClient<paths>["/api/creator-permissions"]["GET"]>
  ) {
    return this.unwrap(this.getApiCreatorPermissionsRaw(...init));
  }

  getApiCreatorV1AuthoringAuditRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/creator/v1/authoring/audit"]["GET"]>
  ) {
    return this.paths["/api/creator/v1/authoring/audit"].GET(...init);
  }

  getApiCreatorV1AuthoringAudit(
    ...init: Parameters<PathBasedClient<paths>["/api/creator/v1/authoring/audit"]["GET"]>
  ) {
    return this.unwrap(this.getApiCreatorV1AuthoringAuditRaw(...init));
  }

  getApiCreatorV1AuthoringProjectIdPreviewRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/creator/v1/authoring/{projectId}/preview"]["GET"]>
  ) {
    return this.paths["/api/creator/v1/authoring/{projectId}/preview"].GET(...init);
  }

  getApiCreatorV1AuthoringProjectIdPreview(
    ...init: Parameters<PathBasedClient<paths>["/api/creator/v1/authoring/{projectId}/preview"]["GET"]>
  ) {
    return this.unwrap(this.getApiCreatorV1AuthoringProjectIdPreviewRaw(...init));
  }

  getApiCreatorV1AuthoringProjectIdStatusRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/creator/v1/authoring/{projectId}/status"]["GET"]>
  ) {
    return this.paths["/api/creator/v1/authoring/{projectId}/status"].GET(...init);
  }

  getApiCreatorV1AuthoringProjectIdStatus(
    ...init: Parameters<PathBasedClient<paths>["/api/creator/v1/authoring/{projectId}/status"]["GET"]>
  ) {
    return this.unwrap(this.getApiCreatorV1AuthoringProjectIdStatusRaw(...init));
  }

  getApiCreatorV1AuthoringProjectIdToolsRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/creator/v1/authoring/{projectId}/tools"]["GET"]>
  ) {
    return this.paths["/api/creator/v1/authoring/{projectId}/tools"].GET(...init);
  }

  getApiCreatorV1AuthoringProjectIdTools(
    ...init: Parameters<PathBasedClient<paths>["/api/creator/v1/authoring/{projectId}/tools"]["GET"]>
  ) {
    return this.unwrap(this.getApiCreatorV1AuthoringProjectIdToolsRaw(...init));
  }

  getApiCreatorV1HealthRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/creator/v1/health"]["GET"]>
  ) {
    return this.paths["/api/creator/v1/health"].GET(...init);
  }

  getApiCreatorV1Health(
    ...init: Parameters<PathBasedClient<paths>["/api/creator/v1/health"]["GET"]>
  ) {
    return this.unwrap(this.getApiCreatorV1HealthRaw(...init));
  }

  getApiCreatorV1ProjectsRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/creator/v1/projects"]["GET"]>
  ) {
    return this.paths["/api/creator/v1/projects"].GET(...init);
  }

  getApiCreatorV1Projects(
    ...init: Parameters<PathBasedClient<paths>["/api/creator/v1/projects"]["GET"]>
  ) {
    return this.unwrap(this.getApiCreatorV1ProjectsRaw(...init));
  }

  getApiCreatorV1ProjectsProjectIdResourcesRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/creator/v1/projects/{projectId}/resources"]["GET"]>
  ) {
    return this.paths["/api/creator/v1/projects/{projectId}/resources"].GET(...init);
  }

  getApiCreatorV1ProjectsProjectIdResources(
    ...init: Parameters<PathBasedClient<paths>["/api/creator/v1/projects/{projectId}/resources"]["GET"]>
  ) {
    return this.unwrap(this.getApiCreatorV1ProjectsProjectIdResourcesRaw(...init));
  }

  getApiCreatorV1ProjectsProjectIdRuntimeRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/creator/v1/projects/{projectId}/runtime"]["GET"]>
  ) {
    return this.paths["/api/creator/v1/projects/{projectId}/runtime"].GET(...init);
  }

  getApiCreatorV1ProjectsProjectIdRuntime(
    ...init: Parameters<PathBasedClient<paths>["/api/creator/v1/projects/{projectId}/runtime"]["GET"]>
  ) {
    return this.unwrap(this.getApiCreatorV1ProjectsProjectIdRuntimeRaw(...init));
  }

  getApiCreatorV1ProjectsProjectIdRuntimeEventsRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/creator/v1/projects/{projectId}/runtime/events"]["GET"]>
  ) {
    return this.paths["/api/creator/v1/projects/{projectId}/runtime/events"].GET(...init);
  }

  getApiCreatorV1ProjectsProjectIdRuntimeEvents(
    ...init: Parameters<PathBasedClient<paths>["/api/creator/v1/projects/{projectId}/runtime/events"]["GET"]>
  ) {
    return this.unwrap(this.getApiCreatorV1ProjectsProjectIdRuntimeEventsRaw(...init));
  }

  getApiCreatorV1ProjectsProjectIdSceneActionRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/creator/v1/projects/{projectId}/scene/action"]["GET"]>
  ) {
    return this.paths["/api/creator/v1/projects/{projectId}/scene/action"].GET(...init);
  }

  getApiCreatorV1ProjectsProjectIdSceneAction(
    ...init: Parameters<PathBasedClient<paths>["/api/creator/v1/projects/{projectId}/scene/action"]["GET"]>
  ) {
    return this.unwrap(this.getApiCreatorV1ProjectsProjectIdSceneActionRaw(...init));
  }

  getApiCreatorV1ProjectsProjectIdSceneCaptureRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/creator/v1/projects/{projectId}/scene/capture"]["GET"]>
  ) {
    return this.paths["/api/creator/v1/projects/{projectId}/scene/capture"].GET(...init);
  }

  getApiCreatorV1ProjectsProjectIdSceneCapture(
    ...init: Parameters<PathBasedClient<paths>["/api/creator/v1/projects/{projectId}/scene/capture"]["GET"]>
  ) {
    return this.unwrap(this.getApiCreatorV1ProjectsProjectIdSceneCaptureRaw(...init));
  }

  getApiCreatorV1ProjectsProjectIdSceneSessionRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/creator/v1/projects/{projectId}/scene/session"]["GET"]>
  ) {
    return this.paths["/api/creator/v1/projects/{projectId}/scene/session"].GET(...init);
  }

  getApiCreatorV1ProjectsProjectIdSceneSession(
    ...init: Parameters<PathBasedClient<paths>["/api/creator/v1/projects/{projectId}/scene/session"]["GET"]>
  ) {
    return this.unwrap(this.getApiCreatorV1ProjectsProjectIdSceneSessionRaw(...init));
  }

  getApiCreatorV1ProjectsProjectIdScriptsRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/creator/v1/projects/{projectId}/scripts"]["GET"]>
  ) {
    return this.paths["/api/creator/v1/projects/{projectId}/scripts"].GET(...init);
  }

  getApiCreatorV1ProjectsProjectIdScripts(
    ...init: Parameters<PathBasedClient<paths>["/api/creator/v1/projects/{projectId}/scripts"]["GET"]>
  ) {
    return this.unwrap(this.getApiCreatorV1ProjectsProjectIdScriptsRaw(...init));
  }

  getApiCreatorV1ProjectsProjectIdScriptsSideEntryRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/creator/v1/projects/{projectId}/scripts/{side}/{entry}"]["GET"]>
  ) {
    return this.paths["/api/creator/v1/projects/{projectId}/scripts/{side}/{entry}"].GET(...init);
  }

  getApiCreatorV1ProjectsProjectIdScriptsSideEntry(
    ...init: Parameters<PathBasedClient<paths>["/api/creator/v1/projects/{projectId}/scripts/{side}/{entry}"]["GET"]>
  ) {
    return this.unwrap(this.getApiCreatorV1ProjectsProjectIdScriptsSideEntryRaw(...init));
  }

  getApiCreatorV1ProjectsProjectIdStorageScopeSpaceRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/creator/v1/projects/{projectId}/storage/{scope}/{space}"]["GET"]>
  ) {
    return this.paths["/api/creator/v1/projects/{projectId}/storage/{scope}/{space}"].GET(...init);
  }

  getApiCreatorV1ProjectsProjectIdStorageScopeSpace(
    ...init: Parameters<PathBasedClient<paths>["/api/creator/v1/projects/{projectId}/storage/{scope}/{space}"]["GET"]>
  ) {
    return this.unwrap(this.getApiCreatorV1ProjectsProjectIdStorageScopeSpaceRaw(...init));
  }

  getApiDiagnosticsArchiveDownloadRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/diagnostics/{archive}/download"]["GET"]>
  ) {
    return this.paths["/api/diagnostics/{archive}/download"].GET(...init);
  }

  getApiDiagnosticsArchiveDownload(
    ...init: Parameters<PathBasedClient<paths>["/api/diagnostics/{archive}/download"]["GET"]>
  ) {
    return this.unwrap(this.getApiDiagnosticsArchiveDownloadRaw(...init));
  }

  getApiGetMapInfoRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/getMapInfo"]["GET"]>
  ) {
    return this.paths["/api/getMapInfo"].GET(...init);
  }

  getApiGetMapInfo(
    ...init: Parameters<PathBasedClient<paths>["/api/getMapInfo"]["GET"]>
  ) {
    return this.unwrap(this.getApiGetMapInfoRaw(...init));
  }

  getApiHealthRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/health"]["GET"]>
  ) {
    return this.paths["/api/health"].GET(...init);
  }

  getApiHealth(
    ...init: Parameters<PathBasedClient<paths>["/api/health"]["GET"]>
  ) {
    return this.unwrap(this.getApiHealthRaw(...init));
  }

  getApiHealthCheckRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/health-check"]["GET"]>
  ) {
    return this.paths["/api/health-check"].GET(...init);
  }

  getApiHealthCheck(
    ...init: Parameters<PathBasedClient<paths>["/api/health-check"]["GET"]>
  ) {
    return this.unwrap(this.getApiHealthCheckRaw(...init));
  }

  getApiInternalMapAuthoringGuardRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/internal/map-authoring/_guard"]["GET"]>
  ) {
    return this.paths["/api/internal/map-authoring/_guard"].GET(...init);
  }

  getApiInternalMapAuthoringGuard(
    ...init: Parameters<PathBasedClient<paths>["/api/internal/map-authoring/_guard"]["GET"]>
  ) {
    return this.unwrap(this.getApiInternalMapAuthoringGuardRaw(...init));
  }

  getApiInternalMapAuthoringProjectIdStatusRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/internal/map-authoring/{projectId}/status"]["GET"]>
  ) {
    return this.paths["/api/internal/map-authoring/{projectId}/status"].GET(...init);
  }

  getApiInternalMapAuthoringProjectIdStatus(
    ...init: Parameters<PathBasedClient<paths>["/api/internal/map-authoring/{projectId}/status"]["GET"]>
  ) {
    return this.unwrap(this.getApiInternalMapAuthoringProjectIdStatusRaw(...init));
  }

  getApiInternalMapAuthoringProjectIdToolRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/internal/map-authoring/{projectId}/tool"]["GET"]>
  ) {
    return this.paths["/api/internal/map-authoring/{projectId}/tool"].GET(...init);
  }

  getApiInternalMapAuthoringProjectIdTool(
    ...init: Parameters<PathBasedClient<paths>["/api/internal/map-authoring/{projectId}/tool"]["GET"]>
  ) {
    return this.unwrap(this.getApiInternalMapAuthoringProjectIdToolRaw(...init));
  }

  getApiLocalBlobsHashRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/local/blobs/{hash}"]["GET"]>
  ) {
    return this.paths["/api/local/blobs/{hash}"].GET(...init);
  }

  getApiLocalBlobsHash(
    ...init: Parameters<PathBasedClient<paths>["/api/local/blobs/{hash}"]["GET"]>
  ) {
    return this.unwrap(this.getApiLocalBlobsHashRaw(...init));
  }

  getApiLocalDefaultSkinRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/local/default-skin"]["GET"]>
  ) {
    return this.paths["/api/local/default-skin"].GET(...init);
  }

  getApiLocalDefaultSkin(
    ...init: Parameters<PathBasedClient<paths>["/api/local/default-skin"]["GET"]>
  ) {
    return this.unwrap(this.getApiLocalDefaultSkinRaw(...init));
  }

  getApiLocalModelsRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/local/models"]["GET"]>
  ) {
    return this.paths["/api/local/models"].GET(...init);
  }

  getApiLocalModels(
    ...init: Parameters<PathBasedClient<paths>["/api/local/models"]["GET"]>
  ) {
    return this.unwrap(this.getApiLocalModelsRaw(...init));
  }

  getApiLocalModelsIdRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/local/models/{id}"]["GET"]>
  ) {
    return this.paths["/api/local/models/{id}"].GET(...init);
  }

  getApiLocalModelsId(
    ...init: Parameters<PathBasedClient<paths>["/api/local/models/{id}"]["GET"]>
  ) {
    return this.unwrap(this.getApiLocalModelsIdRaw(...init));
  }

  getApiLocalModelsIdEditLockRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/local/models/{id}/edit-lock"]["GET"]>
  ) {
    return this.paths["/api/local/models/{id}/edit-lock"].GET(...init);
  }

  getApiLocalModelsIdEditLock(
    ...init: Parameters<PathBasedClient<paths>["/api/local/models/{id}/edit-lock"]["GET"]>
  ) {
    return this.unwrap(this.getApiLocalModelsIdEditLockRaw(...init));
  }

  getApiLocalModelsIdEventsRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/local/models/{id}/events"]["GET"]>
  ) {
    return this.paths["/api/local/models/{id}/events"].GET(...init);
  }

  getApiLocalModelsIdEvents(
    ...init: Parameters<PathBasedClient<paths>["/api/local/models/{id}/events"]["GET"]>
  ) {
    return this.unwrap(this.getApiLocalModelsIdEventsRaw(...init));
  }

  getApiLocalModelsIdExportRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/local/models/{id}/export"]["GET"]>
  ) {
    return this.paths["/api/local/models/{id}/export"].GET(...init);
  }

  getApiLocalModelsIdExport(
    ...init: Parameters<PathBasedClient<paths>["/api/local/models/{id}/export"]["GET"]>
  ) {
    return this.unwrap(this.getApiLocalModelsIdExportRaw(...init));
  }

  getApiLocalModelsIdSnapshotsRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/local/models/{id}/snapshots"]["GET"]>
  ) {
    return this.paths["/api/local/models/{id}/snapshots"].GET(...init);
  }

  getApiLocalModelsIdSnapshots(
    ...init: Parameters<PathBasedClient<paths>["/api/local/models/{id}/snapshots"]["GET"]>
  ) {
    return this.unwrap(this.getApiLocalModelsIdSnapshotsRaw(...init));
  }

  getApiLocalProjectsRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/local-projects"]["GET"]>
  ) {
    return this.paths["/api/local-projects"].GET(...init);
  }

  getApiLocalProjects(
    ...init: Parameters<PathBasedClient<paths>["/api/local-projects"]["GET"]>
  ) {
    return this.unwrap(this.getApiLocalProjectsRaw(...init));
  }

  getApiLocalProjectsAssetDistributionRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/local-projects/asset-distribution"]["GET"]>
  ) {
    return this.paths["/api/local-projects/asset-distribution"].GET(...init);
  }

  getApiLocalProjectsAssetDistribution(
    ...init: Parameters<PathBasedClient<paths>["/api/local-projects/asset-distribution"]["GET"]>
  ) {
    return this.unwrap(this.getApiLocalProjectsAssetDistributionRaw(...init));
  }

  getApiLocalProjectsIdAiPublicationsRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/local-projects/{id}/ai-publications"]["GET"]>
  ) {
    return this.paths["/api/local-projects/{id}/ai-publications"].GET(...init);
  }

  getApiLocalProjectsIdAiPublications(
    ...init: Parameters<PathBasedClient<paths>["/api/local-projects/{id}/ai-publications"]["GET"]>
  ) {
    return this.unwrap(this.getApiLocalProjectsIdAiPublicationsRaw(...init));
  }

  getApiLocalProjectsIdExportRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/local-projects/{id}/export"]["GET"]>
  ) {
    return this.paths["/api/local-projects/{id}/export"].GET(...init);
  }

  getApiLocalProjectsIdExport(
    ...init: Parameters<PathBasedClient<paths>["/api/local-projects/{id}/export"]["GET"]>
  ) {
    return this.unwrap(this.getApiLocalProjectsIdExportRaw(...init));
  }

  getApiLocalProjectsIdMapsRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/local-projects/{id}/maps"]["GET"]>
  ) {
    return this.paths["/api/local-projects/{id}/maps"].GET(...init);
  }

  getApiLocalProjectsIdMaps(
    ...init: Parameters<PathBasedClient<paths>["/api/local-projects/{id}/maps"]["GET"]>
  ) {
    return this.unwrap(this.getApiLocalProjectsIdMapsRaw(...init));
  }

  getApiLocalProjectsIdRuntimeRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/local-projects/{id}/runtime"]["GET"]>
  ) {
    return this.paths["/api/local-projects/{id}/runtime"].GET(...init);
  }

  getApiLocalProjectsIdRuntime(
    ...init: Parameters<PathBasedClient<paths>["/api/local-projects/{id}/runtime"]["GET"]>
  ) {
    return this.unwrap(this.getApiLocalProjectsIdRuntimeRaw(...init));
  }

  getApiLocalProjectsIdSnapshotsRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/local-projects/{id}/snapshots"]["GET"]>
  ) {
    return this.paths["/api/local-projects/{id}/snapshots"].GET(...init);
  }

  getApiLocalProjectsIdSnapshots(
    ...init: Parameters<PathBasedClient<paths>["/api/local-projects/{id}/snapshots"]["GET"]>
  ) {
    return this.unwrap(this.getApiLocalProjectsIdSnapshotsRaw(...init));
  }

  getApiOperationsIdRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/operations/{id}"]["GET"]>
  ) {
    return this.paths["/api/operations/{id}"].GET(...init);
  }

  getApiOperationsId(
    ...init: Parameters<PathBasedClient<paths>["/api/operations/{id}"]["GET"]>
  ) {
    return this.unwrap(this.getApiOperationsIdRaw(...init));
  }

  getApiPlayAdminActivityRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/activity"]["GET"]>
  ) {
    return this.paths["/api/play-admin/activity"].GET(...init);
  }

  getApiPlayAdminActivity(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/activity"]["GET"]>
  ) {
    return this.unwrap(this.getApiPlayAdminActivityRaw(...init));
  }

  getApiPlayAdminAdminsRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/admins"]["GET"]>
  ) {
    return this.paths["/api/play-admin/admins"].GET(...init);
  }

  getApiPlayAdminAdmins(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/admins"]["GET"]>
  ) {
    return this.unwrap(this.getApiPlayAdminAdminsRaw(...init));
  }

  getApiPlayAdminAiProvidersRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/ai-providers"]["GET"]>
  ) {
    return this.paths["/api/play-admin/ai-providers"].GET(...init);
  }

  getApiPlayAdminAiProviders(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/ai-providers"]["GET"]>
  ) {
    return this.unwrap(this.getApiPlayAdminAiProvidersRaw(...init));
  }

  getApiPlayAdminAiProvidersControlRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/ai-providers/control"]["GET"]>
  ) {
    return this.paths["/api/play-admin/ai-providers/control"].GET(...init);
  }

  getApiPlayAdminAiProvidersControl(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/ai-providers/control"]["GET"]>
  ) {
    return this.unwrap(this.getApiPlayAdminAiProvidersControlRaw(...init));
  }

  getApiPlayAdminAiProvidersPathRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/ai-providers/{path}"]["GET"]>
  ) {
    return this.paths["/api/play-admin/ai-providers/{path}"].GET(...init);
  }

  getApiPlayAdminAiProvidersPath(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/ai-providers/{path}"]["GET"]>
  ) {
    return this.unwrap(this.getApiPlayAdminAiProvidersPathRaw(...init));
  }

  getApiPlayAdminAiProvidersRunsRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/ai-providers/runs"]["GET"]>
  ) {
    return this.paths["/api/play-admin/ai-providers/runs"].GET(...init);
  }

  getApiPlayAdminAiProvidersRuns(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/ai-providers/runs"]["GET"]>
  ) {
    return this.unwrap(this.getApiPlayAdminAiProvidersRunsRaw(...init));
  }

  getApiPlayAdminContainerResourceGroupsRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/container-resource-groups"]["GET"]>
  ) {
    return this.paths["/api/play-admin/container-resource-groups"].GET(...init);
  }

  getApiPlayAdminContainerResourceGroups(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/container-resource-groups"]["GET"]>
  ) {
    return this.unwrap(this.getApiPlayAdminContainerResourceGroupsRaw(...init));
  }

  getApiPlayAdminContainersRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/containers"]["GET"]>
  ) {
    return this.paths["/api/play-admin/containers"].GET(...init);
  }

  getApiPlayAdminContainers(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/containers"]["GET"]>
  ) {
    return this.unwrap(this.getApiPlayAdminContainersRaw(...init));
  }

  getApiPlayAdminIdentityBansRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/identity-bans"]["GET"]>
  ) {
    return this.paths["/api/play-admin/identity-bans"].GET(...init);
  }

  getApiPlayAdminIdentityBans(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/identity-bans"]["GET"]>
  ) {
    return this.unwrap(this.getApiPlayAdminIdentityBansRaw(...init));
  }

  getApiPlayAdminImportRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/import"]["GET"]>
  ) {
    return this.paths["/api/play-admin/import"].GET(...init);
  }

  getApiPlayAdminImport(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/import"]["GET"]>
  ) {
    return this.unwrap(this.getApiPlayAdminImportRaw(...init));
  }

  getApiPlayAdminImportResourceRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/import-resource"]["GET"]>
  ) {
    return this.paths["/api/play-admin/import-resource"].GET(...init);
  }

  getApiPlayAdminImportResource(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/import-resource"]["GET"]>
  ) {
    return this.unwrap(this.getApiPlayAdminImportResourceRaw(...init));
  }

  getApiPlayAdminLibraryImportRaw<const Init extends Parameters<PathBasedClient<paths>["/api/play-admin/library/import"]["GET"]>>(...init: Init): Promise<FetchResponse<paths["/api/play-admin/library/import"]["get"], Init[0], `${string}/${string}`>> {
    // Preserve parseAs when callers download text or binary resources.
    return this.paths["/api/play-admin/library/import"].GET(...(init as Parameters<PathBasedClient<paths>["/api/play-admin/library/import"]["GET"]>)) as Promise<FetchResponse<paths["/api/play-admin/library/import"]["get"], Init[0], `${string}/${string}`>>;
  }

  getApiPlayAdminLibraryImport<const Init extends Parameters<PathBasedClient<paths>["/api/play-admin/library/import"]["GET"]>>(...init: Init): Promise<NonNullable<FetchResponse<paths["/api/play-admin/library/import"]["get"], Init[0], `${string}/${string}`>["data"]>> {
    return this.unwrap(this.getApiPlayAdminLibraryImportRaw(...init)) as Promise<NonNullable<FetchResponse<paths["/api/play-admin/library/import"]["get"], Init[0], `${string}/${string}`>["data"]>>;
  }

  getApiPlayAdminLibrarySectionRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/library/{section}"]["GET"]>
  ) {
    return this.paths["/api/play-admin/library/{section}"].GET(...init);
  }

  getApiPlayAdminLibrarySection(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/library/{section}"]["GET"]>
  ) {
    return this.unwrap(this.getApiPlayAdminLibrarySectionRaw(...init));
  }

  getApiPlayAdminLibrarySectionIdRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/library/{section}/{id}"]["GET"]>
  ) {
    return this.paths["/api/play-admin/library/{section}/{id}"].GET(...init);
  }

  getApiPlayAdminLibrarySectionId(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/library/{section}/{id}"]["GET"]>
  ) {
    return this.unwrap(this.getApiPlayAdminLibrarySectionIdRaw(...init));
  }

  getApiPlayAdminPermissionGroupsRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/permission-groups"]["GET"]>
  ) {
    return this.paths["/api/play-admin/permission-groups"].GET(...init);
  }

  getApiPlayAdminPermissionGroups(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/permission-groups"]["GET"]>
  ) {
    return this.unwrap(this.getApiPlayAdminPermissionGroupsRaw(...init));
  }

  getApiPlayAdminPlayersRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/players"]["GET"]>
  ) {
    return this.paths["/api/play-admin/players"].GET(...init);
  }

  getApiPlayAdminPlayers(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/players"]["GET"]>
  ) {
    return this.unwrap(this.getApiPlayAdminPlayersRaw(...init));
  }

  getApiPlayAdminPlayersExportRaw<const Init extends Parameters<PathBasedClient<paths>["/api/play-admin/players/export"]["GET"]>>(...init: Init): Promise<FetchResponse<paths["/api/play-admin/players/export"]["get"], Init[0], `${string}/${string}`>> {
    // Preserve parseAs when callers download text or binary resources.
    return this.paths["/api/play-admin/players/export"].GET(...(init as Parameters<PathBasedClient<paths>["/api/play-admin/players/export"]["GET"]>)) as Promise<FetchResponse<paths["/api/play-admin/players/export"]["get"], Init[0], `${string}/${string}`>>;
  }

  getApiPlayAdminPlayersExport<const Init extends Parameters<PathBasedClient<paths>["/api/play-admin/players/export"]["GET"]>>(...init: Init): Promise<NonNullable<FetchResponse<paths["/api/play-admin/players/export"]["get"], Init[0], `${string}/${string}`>["data"]>> {
    return this.unwrap(this.getApiPlayAdminPlayersExportRaw(...init)) as Promise<NonNullable<FetchResponse<paths["/api/play-admin/players/export"]["get"], Init[0], `${string}/${string}`>["data"]>>;
  }

  getApiPlayAdminPlayersOverviewRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/players/overview"]["GET"]>
  ) {
    return this.paths["/api/play-admin/players/overview"].GET(...init);
  }

  getApiPlayAdminPlayersOverview(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/players/overview"]["GET"]>
  ) {
    return this.unwrap(this.getApiPlayAdminPlayersOverviewRaw(...init));
  }

  getApiPlayAdminPlayersSubjectIdRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/players/{subjectId}"]["GET"]>
  ) {
    return this.paths["/api/play-admin/players/{subjectId}"].GET(...init);
  }

  getApiPlayAdminPlayersSubjectId(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/players/{subjectId}"]["GET"]>
  ) {
    return this.unwrap(this.getApiPlayAdminPlayersSubjectIdRaw(...init));
  }

  getApiPlayAdminScriptModerationRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/script-moderation"]["GET"]>
  ) {
    return this.paths["/api/play-admin/script-moderation"].GET(...init);
  }

  getApiPlayAdminScriptModeration(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/script-moderation"]["GET"]>
  ) {
    return this.unwrap(this.getApiPlayAdminScriptModerationRaw(...init));
  }

  getApiPlayAdminSiteConfigRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/site-config"]["GET"]>
  ) {
    return this.paths["/api/play-admin/site-config"].GET(...init);
  }

  getApiPlayAdminSiteConfig(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/site-config"]["GET"]>
  ) {
    return this.unwrap(this.getApiPlayAdminSiteConfigRaw(...init));
  }

  getApiPlayAdminStatusRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/status"]["GET"]>
  ) {
    return this.paths["/api/play-admin/status"].GET(...init);
  }

  getApiPlayAdminStatus(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/status"]["GET"]>
  ) {
    return this.unwrap(this.getApiPlayAdminStatusRaw(...init));
  }

  getApiPlayAdminVerifyRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/verify"]["GET"]>
  ) {
    return this.paths["/api/play-admin/verify"].GET(...init);
  }

  getApiPlayAdminVerify(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/verify"]["GET"]>
  ) {
    return this.unwrap(this.getApiPlayAdminVerifyRaw(...init));
  }

  getApiPlayAdminWorldsRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/worlds"]["GET"]>
  ) {
    return this.paths["/api/play-admin/worlds"].GET(...init);
  }

  getApiPlayAdminWorlds(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/worlds"]["GET"]>
  ) {
    return this.unwrap(this.getApiPlayAdminWorldsRaw(...init));
  }

  getApiPlayAdminWorldsStatusRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/worlds/status"]["GET"]>
  ) {
    return this.paths["/api/play-admin/worlds/status"].GET(...init);
  }

  getApiPlayAdminWorldsStatus(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/worlds/status"]["GET"]>
  ) {
    return this.unwrap(this.getApiPlayAdminWorldsStatusRaw(...init));
  }

  getApiPlayerAiRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/player-ai"]["GET"]>
  ) {
    return this.paths["/api/player-ai"].GET(...init);
  }

  getApiPlayerAi(
    ...init: Parameters<PathBasedClient<paths>["/api/player-ai"]["GET"]>
  ) {
    return this.unwrap(this.getApiPlayerAiRaw(...init));
  }

  getApiPlayerAiInternalRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/player-ai-internal"]["GET"]>
  ) {
    return this.paths["/api/player-ai-internal"].GET(...init);
  }

  getApiPlayerAiInternal(
    ...init: Parameters<PathBasedClient<paths>["/api/player-ai-internal"]["GET"]>
  ) {
    return this.unwrap(this.getApiPlayerAiInternalRaw(...init));
  }

  getApiPlayerAiInternalPathRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/player-ai-internal/{path}"]["GET"]>
  ) {
    return this.paths["/api/player-ai-internal/{path}"].GET(...init);
  }

  getApiPlayerAiInternalPath(
    ...init: Parameters<PathBasedClient<paths>["/api/player-ai-internal/{path}"]["GET"]>
  ) {
    return this.unwrap(this.getApiPlayerAiInternalPathRaw(...init));
  }

  getApiPlayerAiPathRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/player-ai/{path}"]["GET"]>
  ) {
    return this.paths["/api/player-ai/{path}"].GET(...init);
  }

  getApiPlayerAiPath(
    ...init: Parameters<PathBasedClient<paths>["/api/player-ai/{path}"]["GET"]>
  ) {
    return this.unwrap(this.getApiPlayerAiPathRaw(...init));
  }

  getApiPlayerAuthLoginRequiredRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/player-auth/login-required"]["GET"]>
  ) {
    return this.paths["/api/player-auth/login-required"].GET(...init);
  }

  getApiPlayerAuthLoginRequired(
    ...init: Parameters<PathBasedClient<paths>["/api/player-auth/login-required"]["GET"]>
  ) {
    return this.unwrap(this.getApiPlayerAuthLoginRequiredRaw(...init));
  }

  getApiPlayerAuthSessionRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/player-auth/session"]["GET"]>
  ) {
    return this.paths["/api/player-auth/session"].GET(...init);
  }

  getApiPlayerAuthSession(
    ...init: Parameters<PathBasedClient<paths>["/api/player-auth/session"]["GET"]>
  ) {
    return this.unwrap(this.getApiPlayerAuthSessionRaw(...init));
  }

  getApiPlayerInternalMapLibraryRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/player-internal/map-library"]["GET"]>
  ) {
    return this.paths["/api/player-internal/map-library"].GET(...init);
  }

  getApiPlayerInternalMapLibrary(
    ...init: Parameters<PathBasedClient<paths>["/api/player-internal/map-library"]["GET"]>
  ) {
    return this.unwrap(this.getApiPlayerInternalMapLibraryRaw(...init));
  }

  getApiPlayerInternalRevocationsRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/player-internal/revocations"]["GET"]>
  ) {
    return this.paths["/api/player-internal/revocations"].GET(...init);
  }

  getApiPlayerInternalRevocations(
    ...init: Parameters<PathBasedClient<paths>["/api/player-internal/revocations"]["GET"]>
  ) {
    return this.unwrap(this.getApiPlayerInternalRevocationsRaw(...init));
  }

  getApiPlayerLauncherBootstrapRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/player-launcher/bootstrap"]["GET"]>
  ) {
    return this.paths["/api/player-launcher/bootstrap"].GET(...init);
  }

  getApiPlayerLauncherBootstrap(
    ...init: Parameters<PathBasedClient<paths>["/api/player-launcher/bootstrap"]["GET"]>
  ) {
    return this.unwrap(this.getApiPlayerLauncherBootstrapRaw(...init));
  }

  getApiPlayerLauncherMapsRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/player-launcher/maps"]["GET"]>
  ) {
    return this.paths["/api/player-launcher/maps"].GET(...init);
  }

  getApiPlayerLauncherMaps(
    ...init: Parameters<PathBasedClient<paths>["/api/player-launcher/maps"]["GET"]>
  ) {
    return this.unwrap(this.getApiPlayerLauncherMapsRaw(...init));
  }

  getApiPlayerLauncherMapsMapIdDescriptorRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/player-launcher/maps/{mapId}/descriptor"]["GET"]>
  ) {
    return this.paths["/api/player-launcher/maps/{mapId}/descriptor"].GET(...init);
  }

  getApiPlayerLauncherMapsMapIdDescriptor(
    ...init: Parameters<PathBasedClient<paths>["/api/player-launcher/maps/{mapId}/descriptor"]["GET"]>
  ) {
    return this.unwrap(this.getApiPlayerLauncherMapsMapIdDescriptorRaw(...init));
  }

  getApiPlayerLauncherMapsMapIdDownloadPlanRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/player-launcher/maps/{mapId}/download-plan"]["GET"]>
  ) {
    return this.paths["/api/player-launcher/maps/{mapId}/download-plan"].GET(...init);
  }

  getApiPlayerLauncherMapsMapIdDownloadPlan(
    ...init: Parameters<PathBasedClient<paths>["/api/player-launcher/maps/{mapId}/download-plan"]["GET"]>
  ) {
    return this.unwrap(this.getApiPlayerLauncherMapsMapIdDownloadPlanRaw(...init));
  }

  getApiPlayerLoginCallbackRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/player-login/callback"]["GET"]>
  ) {
    return this.paths["/api/player-login/callback"].GET(...init);
  }

  getApiPlayerLoginCallback(
    ...init: Parameters<PathBasedClient<paths>["/api/player-login/callback"]["GET"]>
  ) {
    return this.unwrap(this.getApiPlayerLoginCallbackRaw(...init));
  }

  getApiPlayerLoginStartRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/player-login/start"]["GET"]>
  ) {
    return this.paths["/api/player-login/start"].GET(...init);
  }

  getApiPlayerLoginStart(
    ...init: Parameters<PathBasedClient<paths>["/api/player-login/start"]["GET"]>
  ) {
    return this.unwrap(this.getApiPlayerLoginStartRaw(...init));
  }

  getApiPlayLibraryRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/play-library"]["GET"]>
  ) {
    return this.paths["/api/play-library"].GET(...init);
  }

  getApiPlayLibrary(
    ...init: Parameters<PathBasedClient<paths>["/api/play-library"]["GET"]>
  ) {
    return this.unwrap(this.getApiPlayLibraryRaw(...init));
  }

  getApiPlayPresenceRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/play-presence"]["GET"]>
  ) {
    return this.paths["/api/play-presence"].GET(...init);
  }

  getApiPlayPresence(
    ...init: Parameters<PathBasedClient<paths>["/api/play-presence"]["GET"]>
  ) {
    return this.unwrap(this.getApiPlayPresenceRaw(...init));
  }

  getApiPlayResourceCacheWorldRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/play-resource-cache/{world}"]["GET"]>
  ) {
    return this.paths["/api/play-resource-cache/{world}"].GET(...init);
  }

  getApiPlayResourceCacheWorld(
    ...init: Parameters<PathBasedClient<paths>["/api/play-resource-cache/{world}"]["GET"]>
  ) {
    return this.unwrap(this.getApiPlayResourceCacheWorldRaw(...init));
  }

  getApiPlaySiteConfigRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/play-site-config"]["GET"]>
  ) {
    return this.paths["/api/play-site-config"].GET(...init);
  }

  getApiPlaySiteConfig(
    ...init: Parameters<PathBasedClient<paths>["/api/play-site-config"]["GET"]>
  ) {
    return this.unwrap(this.getApiPlaySiteConfigRaw(...init));
  }

  getApiPlayWorldsRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/play-worlds"]["GET"]>
  ) {
    return this.paths["/api/play-worlds"].GET(...init);
  }

  getApiPlayWorlds(
    ...init: Parameters<PathBasedClient<paths>["/api/play-worlds"]["GET"]>
  ) {
    return this.unwrap(this.getApiPlayWorldsRaw(...init));
  }

  getApiProjectModelsRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/project-models"]["GET"]>
  ) {
    return this.paths["/api/project-models"].GET(...init);
  }

  getApiProjectModels(
    ...init: Parameters<PathBasedClient<paths>["/api/project-models"]["GET"]>
  ) {
    return this.unwrap(this.getApiProjectModelsRaw(...init));
  }

  getApiProjectSkinPreviewsRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/project-skin-previews"]["GET"]>
  ) {
    return this.paths["/api/project-skin-previews"].GET(...init);
  }

  getApiProjectSkinPreviews(
    ...init: Parameters<PathBasedClient<paths>["/api/project-skin-previews"]["GET"]>
  ) {
    return this.unwrap(this.getApiProjectSkinPreviewsRaw(...init));
  }

  getApiProjectSkinsRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/project-skins"]["GET"]>
  ) {
    return this.paths["/api/project-skins"].GET(...init);
  }

  getApiProjectSkins(
    ...init: Parameters<PathBasedClient<paths>["/api/project-skins"]["GET"]>
  ) {
    return this.unwrap(this.getApiProjectSkinsRaw(...init));
  }

  getApiRuntimeContainerIdStatsRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/runtime/{container_id}/stats"]["GET"]>
  ) {
    return this.paths["/api/runtime/{container_id}/stats"].GET(...init);
  }

  getApiRuntimeContainerIdStats(
    ...init: Parameters<PathBasedClient<paths>["/api/runtime/{container_id}/stats"]["GET"]>
  ) {
    return this.unwrap(this.getApiRuntimeContainerIdStatsRaw(...init));
  }

  getApiServerInfoRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/server-info"]["GET"]>
  ) {
    return this.paths["/api/server-info"].GET(...init);
  }

  getApiServerInfo(
    ...init: Parameters<PathBasedClient<paths>["/api/server-info"]["GET"]>
  ) {
    return this.unwrap(this.getApiServerInfoRaw(...init));
  }

  getApiSessionRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/session"]["GET"]>
  ) {
    return this.paths["/api/session"].GET(...init);
  }

  getApiSession(
    ...init: Parameters<PathBasedClient<paths>["/api/session"]["GET"]>
  ) {
    return this.unwrap(this.getApiSessionRaw(...init));
  }

  getApiSystemBackupsRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/system/backups"]["GET"]>
  ) {
    return this.paths["/api/system/backups"].GET(...init);
  }

  getApiSystemBackups(
    ...init: Parameters<PathBasedClient<paths>["/api/system/backups"]["GET"]>
  ) {
    return this.unwrap(this.getApiSystemBackupsRaw(...init));
  }

  getApiSystemBackupsProjectIdNameRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/system/backups/{projectId}/{name}"]["GET"]>
  ) {
    return this.paths["/api/system/backups/{projectId}/{name}"].GET(...init);
  }

  getApiSystemBackupsProjectIdName(
    ...init: Parameters<PathBasedClient<paths>["/api/system/backups/{projectId}/{name}"]["GET"]>
  ) {
    return this.unwrap(this.getApiSystemBackupsProjectIdNameRaw(...init));
  }

  getApiSystemStatusRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/system/status"]["GET"]>
  ) {
    return this.paths["/api/system/status"].GET(...init);
  }

  getApiSystemStatus(
    ...init: Parameters<PathBasedClient<paths>["/api/system/status"]["GET"]>
  ) {
    return this.unwrap(this.getApiSystemStatusRaw(...init));
  }

  getBlockHashRaw(
    ...init: Parameters<PathBasedClient<paths>["/block/{hash}"]["GET"]>
  ) {
    return this.paths["/block/{hash}"].GET(...init);
  }

  getBlockHash(
    ...init: Parameters<PathBasedClient<paths>["/block/{hash}"]["GET"]>
  ) {
    return this.unwrap(this.getBlockHashRaw(...init));
  }

  getInternalCreatorPreviewRuntimeRaw(
    ...init: Parameters<PathBasedClient<paths>["/internal/creator-preview-runtime"]["GET"]>
  ) {
    return this.paths["/internal/creator-preview-runtime"].GET(...init);
  }

  getInternalCreatorPreviewRuntime(
    ...init: Parameters<PathBasedClient<paths>["/internal/creator-preview-runtime"]["GET"]>
  ) {
    return this.unwrap(this.getInternalCreatorPreviewRuntimeRaw(...init));
  }

  getInternalCreatorPreviewRuntimeEventsRaw(
    ...init: Parameters<PathBasedClient<paths>["/internal/creator-preview-runtime/events"]["GET"]>
  ) {
    return this.paths["/internal/creator-preview-runtime/events"].GET(...init);
  }

  getInternalCreatorPreviewRuntimeEvents(
    ...init: Parameters<PathBasedClient<paths>["/internal/creator-preview-runtime/events"]["GET"]>
  ) {
    return this.unwrap(this.getInternalCreatorPreviewRuntimeEventsRaw(...init));
  }

  getLocalRuntimeStatusRaw(
    ...init: Parameters<PathBasedClient<paths>["/__local_runtime/status"]["GET"]>
  ) {
    return this.paths["/__local_runtime/status"].GET(...init);
  }

  getLocalRuntimeStatus(
    ...init: Parameters<PathBasedClient<paths>["/__local_runtime/status"]["GET"]>
  ) {
    return this.unwrap(this.getLocalRuntimeStatusRaw(...init));
  }

  patchApiAuthProfileRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/auth/profile"]["PATCH"]>
  ) {
    return this.paths["/api/auth/profile"].PATCH(...init);
  }

  patchApiAuthProfile(
    ...init: Parameters<PathBasedClient<paths>["/api/auth/profile"]["PATCH"]>
  ) {
    return this.unwrap(this.patchApiAuthProfileRaw(...init));
  }

  patchApiCreatorProfileRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/creator-profile"]["PATCH"]>
  ) {
    return this.paths["/api/creator-profile"].PATCH(...init);
  }

  patchApiCreatorProfile(
    ...init: Parameters<PathBasedClient<paths>["/api/creator-profile"]["PATCH"]>
  ) {
    return this.unwrap(this.patchApiCreatorProfileRaw(...init));
  }

  patchApiLocalProjectsAssetDistributionRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/local-projects/asset-distribution"]["PATCH"]>
  ) {
    return this.paths["/api/local-projects/asset-distribution"].PATCH(...init);
  }

  patchApiLocalProjectsAssetDistribution(
    ...init: Parameters<PathBasedClient<paths>["/api/local-projects/asset-distribution"]["PATCH"]>
  ) {
    return this.unwrap(this.patchApiLocalProjectsAssetDistributionRaw(...init));
  }

  patchApiLocalProjectsIdRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/local-projects/{id}"]["PATCH"]>
  ) {
    return this.paths["/api/local-projects/{id}"].PATCH(...init);
  }

  patchApiLocalProjectsId(
    ...init: Parameters<PathBasedClient<paths>["/api/local-projects/{id}"]["PATCH"]>
  ) {
    return this.unwrap(this.patchApiLocalProjectsIdRaw(...init));
  }

  patchApiPlayAdminAdminsIdRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/admins/{id}"]["PATCH"]>
  ) {
    return this.paths["/api/play-admin/admins/{id}"].PATCH(...init);
  }

  patchApiPlayAdminAdminsId(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/admins/{id}"]["PATCH"]>
  ) {
    return this.unwrap(this.patchApiPlayAdminAdminsIdRaw(...init));
  }

  patchApiPlayAdminAiProvidersControlRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/ai-providers/control"]["PATCH"]>
  ) {
    return this.paths["/api/play-admin/ai-providers/control"].PATCH(...init);
  }

  patchApiPlayAdminAiProvidersControl(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/ai-providers/control"]["PATCH"]>
  ) {
    return this.unwrap(this.patchApiPlayAdminAiProvidersControlRaw(...init));
  }

  patchApiPlayAdminAiProvidersIdRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/ai-providers/{id}"]["PATCH"]>
  ) {
    return this.paths["/api/play-admin/ai-providers/{id}"].PATCH(...init);
  }

  patchApiPlayAdminAiProvidersId(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/ai-providers/{id}"]["PATCH"]>
  ) {
    return this.unwrap(this.patchApiPlayAdminAiProvidersIdRaw(...init));
  }

  patchApiPlayAdminAiProvidersPathRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/ai-providers/{path}"]["PATCH"]>
  ) {
    return this.paths["/api/play-admin/ai-providers/{path}"].PATCH(...init);
  }

  patchApiPlayAdminAiProvidersPath(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/ai-providers/{path}"]["PATCH"]>
  ) {
    return this.unwrap(this.patchApiPlayAdminAiProvidersPathRaw(...init));
  }

  patchApiPlayAdminContainerResourceGroupsIdRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/container-resource-groups/{id}"]["PATCH"]>
  ) {
    return this.paths["/api/play-admin/container-resource-groups/{id}"].PATCH(...init);
  }

  patchApiPlayAdminContainerResourceGroupsId(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/container-resource-groups/{id}"]["PATCH"]>
  ) {
    return this.unwrap(this.patchApiPlayAdminContainerResourceGroupsIdRaw(...init));
  }

  patchApiPlayAdminLibrarySectionRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/library/{section}"]["PATCH"]>
  ) {
    return this.paths["/api/play-admin/library/{section}"].PATCH(...init);
  }

  patchApiPlayAdminLibrarySection(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/library/{section}"]["PATCH"]>
  ) {
    return this.unwrap(this.patchApiPlayAdminLibrarySectionRaw(...init));
  }

  patchApiPlayAdminLibrarySectionIdRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/library/{section}/{id}"]["PATCH"]>
  ) {
    return this.paths["/api/play-admin/library/{section}/{id}"].PATCH(...init);
  }

  patchApiPlayAdminLibrarySectionId(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/library/{section}/{id}"]["PATCH"]>
  ) {
    return this.unwrap(this.patchApiPlayAdminLibrarySectionIdRaw(...init));
  }

  patchApiPlayAdminPermissionGroupsIdRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/permission-groups/{id}"]["PATCH"]>
  ) {
    return this.paths["/api/play-admin/permission-groups/{id}"].PATCH(...init);
  }

  patchApiPlayAdminPermissionGroupsId(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/permission-groups/{id}"]["PATCH"]>
  ) {
    return this.unwrap(this.patchApiPlayAdminPermissionGroupsIdRaw(...init));
  }

  patchApiPlayAdminPlayersSubjectIdRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/players/{subjectId}"]["PATCH"]>
  ) {
    return this.paths["/api/play-admin/players/{subjectId}"].PATCH(...init);
  }

  patchApiPlayAdminPlayersSubjectId(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/players/{subjectId}"]["PATCH"]>
  ) {
    return this.unwrap(this.patchApiPlayAdminPlayersSubjectIdRaw(...init));
  }

  patchApiPlayAdminSiteConfigRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/site-config"]["PATCH"]>
  ) {
    return this.paths["/api/play-admin/site-config"].PATCH(...init);
  }

  patchApiPlayAdminSiteConfig(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/site-config"]["PATCH"]>
  ) {
    return this.unwrap(this.patchApiPlayAdminSiteConfigRaw(...init));
  }

  patchApiPlayAdminWorldsIdRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/worlds/{id}"]["PATCH"]>
  ) {
    return this.paths["/api/play-admin/worlds/{id}"].PATCH(...init);
  }

  patchApiPlayAdminWorldsId(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/worlds/{id}"]["PATCH"]>
  ) {
    return this.unwrap(this.patchApiPlayAdminWorldsIdRaw(...init));
  }

  patchApiPlayerAiPathRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/player-ai/{path}"]["PATCH"]>
  ) {
    return this.paths["/api/player-ai/{path}"].PATCH(...init);
  }

  patchApiPlayerAiPath(
    ...init: Parameters<PathBasedClient<paths>["/api/player-ai/{path}"]["PATCH"]>
  ) {
    return this.unwrap(this.patchApiPlayerAiPathRaw(...init));
  }

  patchApiPlayerAuthProfileRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/player-auth/profile"]["PATCH"]>
  ) {
    return this.paths["/api/player-auth/profile"].PATCH(...init);
  }

  patchApiPlayerAuthProfile(
    ...init: Parameters<PathBasedClient<paths>["/api/player-auth/profile"]["PATCH"]>
  ) {
    return this.unwrap(this.patchApiPlayerAuthProfileRaw(...init));
  }

  patchApiPlayerInternalMapLibraryRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/player-internal/map-library"]["PATCH"]>
  ) {
    return this.paths["/api/player-internal/map-library"].PATCH(...init);
  }

  patchApiPlayerInternalMapLibrary(
    ...init: Parameters<PathBasedClient<paths>["/api/player-internal/map-library"]["PATCH"]>
  ) {
    return this.unwrap(this.patchApiPlayerInternalMapLibraryRaw(...init));
  }

  patchApiPlayerInternalProfileRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/player-internal/profile"]["PATCH"]>
  ) {
    return this.paths["/api/player-internal/profile"].PATCH(...init);
  }

  patchApiPlayerInternalProfile(
    ...init: Parameters<PathBasedClient<paths>["/api/player-internal/profile"]["PATCH"]>
  ) {
    return this.unwrap(this.patchApiPlayerInternalProfileRaw(...init));
  }

  patchApiPlayLibraryRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/play-library"]["PATCH"]>
  ) {
    return this.paths["/api/play-library"].PATCH(...init);
  }

  patchApiPlayLibrary(
    ...init: Parameters<PathBasedClient<paths>["/api/play-library"]["PATCH"]>
  ) {
    return this.unwrap(this.patchApiPlayLibraryRaw(...init));
  }

  patchApiPlayProfileRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/play-profile"]["PATCH"]>
  ) {
    return this.paths["/api/play-profile"].PATCH(...init);
  }

  patchApiPlayProfile(
    ...init: Parameters<PathBasedClient<paths>["/api/play-profile"]["PATCH"]>
  ) {
    return this.unwrap(this.patchApiPlayProfileRaw(...init));
  }

  postApiAgentV1JoinRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/agent/v1/join"]["POST"]>
  ) {
    return this.paths["/api/agent/v1/join"].POST(...init);
  }

  postApiAgentV1Join(
    ...init: Parameters<PathBasedClient<paths>["/api/agent/v1/join"]["POST"]>
  ) {
    return this.unwrap(this.postApiAgentV1JoinRaw(...init));
  }

  postApiAgentV1LiveAckRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/agent/v1/live/ack"]["POST"]>
  ) {
    return this.paths["/api/agent/v1/live/ack"].POST(...init);
  }

  postApiAgentV1LiveAck(
    ...init: Parameters<PathBasedClient<paths>["/api/agent/v1/live/ack"]["POST"]>
  ) {
    return this.unwrap(this.postApiAgentV1LiveAckRaw(...init));
  }

  postApiAgentV1LiveActionRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/agent/v1/live/{action}"]["POST"]>
  ) {
    return this.paths["/api/agent/v1/live/{action}"].POST(...init);
  }

  postApiAgentV1LiveAction(
    ...init: Parameters<PathBasedClient<paths>["/api/agent/v1/live/{action}"]["POST"]>
  ) {
    return this.unwrap(this.postApiAgentV1LiveActionRaw(...init));
  }

  postApiAgentV1LiveAttachRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/agent/v1/live/attach"]["POST"]>
  ) {
    return this.paths["/api/agent/v1/live/attach"].POST(...init);
  }

  postApiAgentV1LiveAttach(
    ...init: Parameters<PathBasedClient<paths>["/api/agent/v1/live/attach"]["POST"]>
  ) {
    return this.unwrap(this.postApiAgentV1LiveAttachRaw(...init));
  }

  postApiAgentV1LiveDetachRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/agent/v1/live/detach"]["POST"]>
  ) {
    return this.paths["/api/agent/v1/live/detach"].POST(...init);
  }

  postApiAgentV1LiveDetach(
    ...init: Parameters<PathBasedClient<paths>["/api/agent/v1/live/detach"]["POST"]>
  ) {
    return this.unwrap(this.postApiAgentV1LiveDetachRaw(...init));
  }

  postApiAgentV1LiveMapProjectIdCmdRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/agent/v1/live/map/{projectId}/cmd"]["POST"]>
  ) {
    return this.paths["/api/agent/v1/live/map/{projectId}/cmd"].POST(...init);
  }

  postApiAgentV1LiveMapProjectIdCmd(
    ...init: Parameters<PathBasedClient<paths>["/api/agent/v1/live/map/{projectId}/cmd"]["POST"]>
  ) {
    return this.unwrap(this.postApiAgentV1LiveMapProjectIdCmdRaw(...init));
  }

  postApiAgentV1LiveMapProjectIdObserveRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/agent/v1/live/map/{projectId}/observe"]["POST"]>
  ) {
    return this.paths["/api/agent/v1/live/map/{projectId}/observe"].POST(...init);
  }

  postApiAgentV1LiveMapProjectIdObserve(
    ...init: Parameters<PathBasedClient<paths>["/api/agent/v1/live/map/{projectId}/observe"]["POST"]>
  ) {
    return this.unwrap(this.postApiAgentV1LiveMapProjectIdObserveRaw(...init));
  }

  postApiAgentV1LiveProgressRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/agent/v1/live/progress"]["POST"]>
  ) {
    return this.paths["/api/agent/v1/live/progress"].POST(...init);
  }

  postApiAgentV1LiveProgress(
    ...init: Parameters<PathBasedClient<paths>["/api/agent/v1/live/progress"]["POST"]>
  ) {
    return this.unwrap(this.postApiAgentV1LiveProgressRaw(...init));
  }

  postApiAgentV1LiveVoxaActionRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/agent/v1/live/voxa/{action}"]["POST"]>
  ) {
    return this.paths["/api/agent/v1/live/voxa/{action}"].POST(...init);
  }

  postApiAgentV1LiveVoxaAction(
    ...init: Parameters<PathBasedClient<paths>["/api/agent/v1/live/voxa/{action}"]["POST"]>
  ) {
    return this.unwrap(this.postApiAgentV1LiveVoxaActionRaw(...init));
  }

  postApiAgentV1MapProjectIdActionRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/agent/v1/map/{projectId}/{action}"]["POST"]>
  ) {
    return this.paths["/api/agent/v1/map/{projectId}/{action}"].POST(...init);
  }

  postApiAgentV1MapProjectIdAction(
    ...init: Parameters<PathBasedClient<paths>["/api/agent/v1/map/{projectId}/{action}"]["POST"]>
  ) {
    return this.unwrap(this.postApiAgentV1MapProjectIdActionRaw(...init));
  }

  postApiAgentV1ModelsRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/agent/v1/models"]["POST"]>
  ) {
    return this.paths["/api/agent/v1/models"].POST(...init);
  }

  postApiAgentV1Models(
    ...init: Parameters<PathBasedClient<paths>["/api/agent/v1/models"]["POST"]>
  ) {
    return this.unwrap(this.postApiAgentV1ModelsRaw(...init));
  }

  postApiAgentV1StateRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/agent/v1/state"]["POST"]>
  ) {
    return this.paths["/api/agent/v1/state"].POST(...init);
  }

  postApiAgentV1State(
    ...init: Parameters<PathBasedClient<paths>["/api/agent/v1/state"]["POST"]>
  ) {
    return this.unwrap(this.postApiAgentV1StateRaw(...init));
  }

  postApiAiActionRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/ai/{action}"]["POST"]>
  ) {
    return this.paths["/api/ai/{action}"].POST(...init);
  }

  postApiAiAction(
    ...init: Parameters<PathBasedClient<paths>["/api/ai/{action}"]["POST"]>
  ) {
    return this.unwrap(this.postApiAiActionRaw(...init));
  }

  postApiAuthLoginRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/auth/login"]["POST"]>
  ) {
    return this.paths["/api/auth/login"].POST(...init);
  }

  postApiAuthLogin(
    ...init: Parameters<PathBasedClient<paths>["/api/auth/login"]["POST"]>
  ) {
    return this.unwrap(this.postApiAuthLoginRaw(...init));
  }

  postApiAuthLogoutRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/auth/logout"]["POST"]>
  ) {
    return this.paths["/api/auth/logout"].POST(...init);
  }

  postApiAuthLogout(
    ...init: Parameters<PathBasedClient<paths>["/api/auth/logout"]["POST"]>
  ) {
    return this.unwrap(this.postApiAuthLogoutRaw(...init));
  }

  postApiAuthPasswordRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/auth/password"]["POST"]>
  ) {
    return this.paths["/api/auth/password"].POST(...init);
  }

  postApiAuthPassword(
    ...init: Parameters<PathBasedClient<paths>["/api/auth/password"]["POST"]>
  ) {
    return this.unwrap(this.postApiAuthPasswordRaw(...init));
  }

  postApiAuthRegisterRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/auth/register"]["POST"]>
  ) {
    return this.paths["/api/auth/register"].POST(...init);
  }

  postApiAuthRegister(
    ...init: Parameters<PathBasedClient<paths>["/api/auth/register"]["POST"]>
  ) {
    return this.unwrap(this.postApiAuthRegisterRaw(...init));
  }

  postApiBackupsUploadRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/backups/upload"]["POST"]>
  ) {
    return this.paths["/api/backups/upload"].POST(...init);
  }

  postApiBackupsUpload(
    ...init: Parameters<PathBasedClient<paths>["/api/backups/upload"]["POST"]>
  ) {
    return this.unwrap(this.postApiBackupsUploadRaw(...init));
  }

  postApiCommandsNameRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/commands/{name}"]["POST"]>
  ) {
    return this.paths["/api/commands/{name}"].POST(...init);
  }

  postApiCommandsName(
    ...init: Parameters<PathBasedClient<paths>["/api/commands/{name}"]["POST"]>
  ) {
    return this.unwrap(this.postApiCommandsNameRaw(...init));
  }

  postApiCreateSessionRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/createSession"]["POST"]>
  ) {
    return this.paths["/api/createSession"].POST(...init);
  }

  postApiCreateSession(
    ...init: Parameters<PathBasedClient<paths>["/api/createSession"]["POST"]>
  ) {
    return this.unwrap(this.postApiCreateSessionRaw(...init));
  }

  postApiCreatorLogoutRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/creator-logout"]["POST"]>
  ) {
    return this.paths["/api/creator-logout"].POST(...init);
  }

  postApiCreatorLogout(
    ...init: Parameters<PathBasedClient<paths>["/api/creator-logout"]["POST"]>
  ) {
    return this.unwrap(this.postApiCreatorLogoutRaw(...init));
  }

  postApiCreatorModelsImportRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/creator-models/import"]["POST"]>
  ) {
    return this.paths["/api/creator-models/import"].POST(...init);
  }

  postApiCreatorModelsImport(
    ...init: Parameters<PathBasedClient<paths>["/api/creator-models/import"]["POST"]>
  ) {
    return this.unwrap(this.postApiCreatorModelsImportRaw(...init));
  }

  postApiCreatorV1AuthoringProjectIdPreviewRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/creator/v1/authoring/{projectId}/preview"]["POST"]>
  ) {
    return this.paths["/api/creator/v1/authoring/{projectId}/preview"].POST(...init);
  }

  postApiCreatorV1AuthoringProjectIdPreview(
    ...init: Parameters<PathBasedClient<paths>["/api/creator/v1/authoring/{projectId}/preview"]["POST"]>
  ) {
    return this.unwrap(this.postApiCreatorV1AuthoringProjectIdPreviewRaw(...init));
  }

  postApiCreatorV1AuthoringProjectIdSaveRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/creator/v1/authoring/{projectId}/save"]["POST"]>
  ) {
    return this.paths["/api/creator/v1/authoring/{projectId}/save"].POST(...init);
  }

  postApiCreatorV1AuthoringProjectIdSave(
    ...init: Parameters<PathBasedClient<paths>["/api/creator/v1/authoring/{projectId}/save"]["POST"]>
  ) {
    return this.unwrap(this.postApiCreatorV1AuthoringProjectIdSaveRaw(...init));
  }

  postApiCreatorV1AuthoringProjectIdToolsRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/creator/v1/authoring/{projectId}/tools"]["POST"]>
  ) {
    return this.paths["/api/creator/v1/authoring/{projectId}/tools"].POST(...init);
  }

  postApiCreatorV1AuthoringProjectIdTools(
    ...init: Parameters<PathBasedClient<paths>["/api/creator/v1/authoring/{projectId}/tools"]["POST"]>
  ) {
    return this.unwrap(this.postApiCreatorV1AuthoringProjectIdToolsRaw(...init));
  }

  postApiCreatorV1ProjectsProjectIdRuntimeRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/creator/v1/projects/{projectId}/runtime"]["POST"]>
  ) {
    return this.paths["/api/creator/v1/projects/{projectId}/runtime"].POST(...init);
  }

  postApiCreatorV1ProjectsProjectIdRuntime(
    ...init: Parameters<PathBasedClient<paths>["/api/creator/v1/projects/{projectId}/runtime"]["POST"]>
  ) {
    return this.unwrap(this.postApiCreatorV1ProjectsProjectIdRuntimeRaw(...init));
  }

  postApiCreatorV1ProjectsProjectIdSceneActionsRequestIdRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/creator/v1/projects/{projectId}/scene/actions/{requestId}"]["POST"]>
  ) {
    return this.paths["/api/creator/v1/projects/{projectId}/scene/actions/{requestId}"].POST(...init);
  }

  postApiCreatorV1ProjectsProjectIdSceneActionsRequestId(
    ...init: Parameters<PathBasedClient<paths>["/api/creator/v1/projects/{projectId}/scene/actions/{requestId}"]["POST"]>
  ) {
    return this.unwrap(this.postApiCreatorV1ProjectsProjectIdSceneActionsRequestIdRaw(...init));
  }

  postApiCreatorV1ProjectsProjectIdSceneSessionRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/creator/v1/projects/{projectId}/scene/session"]["POST"]>
  ) {
    return this.paths["/api/creator/v1/projects/{projectId}/scene/session"].POST(...init);
  }

  postApiCreatorV1ProjectsProjectIdSceneSession(
    ...init: Parameters<PathBasedClient<paths>["/api/creator/v1/projects/{projectId}/scene/session"]["POST"]>
  ) {
    return this.unwrap(this.postApiCreatorV1ProjectsProjectIdSceneSessionRaw(...init));
  }

  postApiInternalAiPublicationRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/internal/ai-publication"]["POST"]>
  ) {
    return this.paths["/api/internal/ai-publication"].POST(...init);
  }

  postApiInternalAiPublication(
    ...init: Parameters<PathBasedClient<paths>["/api/internal/ai-publication"]["POST"]>
  ) {
    return this.unwrap(this.postApiInternalAiPublicationRaw(...init));
  }

  postApiInternalMapAuthoringProjectIdPreviewRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/internal/map-authoring/{projectId}/preview"]["POST"]>
  ) {
    return this.paths["/api/internal/map-authoring/{projectId}/preview"].POST(...init);
  }

  postApiInternalMapAuthoringProjectIdPreview(
    ...init: Parameters<PathBasedClient<paths>["/api/internal/map-authoring/{projectId}/preview"]["POST"]>
  ) {
    return this.unwrap(this.postApiInternalMapAuthoringProjectIdPreviewRaw(...init));
  }

  postApiInternalMapAuthoringProjectIdSaveRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/internal/map-authoring/{projectId}/save"]["POST"]>
  ) {
    return this.paths["/api/internal/map-authoring/{projectId}/save"].POST(...init);
  }

  postApiInternalMapAuthoringProjectIdSave(
    ...init: Parameters<PathBasedClient<paths>["/api/internal/map-authoring/{projectId}/save"]["POST"]>
  ) {
    return this.unwrap(this.postApiInternalMapAuthoringProjectIdSaveRaw(...init));
  }

  postApiInternalMapAuthoringProjectIdToolRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/internal/map-authoring/{projectId}/tool"]["POST"]>
  ) {
    return this.paths["/api/internal/map-authoring/{projectId}/tool"].POST(...init);
  }

  postApiInternalMapAuthoringProjectIdTool(
    ...init: Parameters<PathBasedClient<paths>["/api/internal/map-authoring/{projectId}/tool"]["POST"]>
  ) {
    return this.unwrap(this.postApiInternalMapAuthoringProjectIdToolRaw(...init));
  }

  postApiLocalBlobRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/local/blob"]["POST"]>
  ) {
    return this.paths["/api/local/blob"].POST(...init);
  }

  postApiLocalBlob(
    ...init: Parameters<PathBasedClient<paths>["/api/local/blob"]["POST"]>
  ) {
    return this.unwrap(this.postApiLocalBlobRaw(...init));
  }

  postApiLocalModelsRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/local/models"]["POST"]>
  ) {
    return this.paths["/api/local/models"].POST(...init);
  }

  postApiLocalModels(
    ...init: Parameters<PathBasedClient<paths>["/api/local/models"]["POST"]>
  ) {
    return this.unwrap(this.postApiLocalModelsRaw(...init));
  }

  postApiLocalModelsIdEditLockRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/local/models/{id}/edit-lock"]["POST"]>
  ) {
    return this.paths["/api/local/models/{id}/edit-lock"].POST(...init);
  }

  postApiLocalModelsIdEditLock(
    ...init: Parameters<PathBasedClient<paths>["/api/local/models/{id}/edit-lock"]["POST"]>
  ) {
    return this.unwrap(this.postApiLocalModelsIdEditLockRaw(...init));
  }

  postApiLocalModelsImportRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/local/models/import"]["POST"]>
  ) {
    return this.paths["/api/local/models/import"].POST(...init);
  }

  postApiLocalModelsImport(
    ...init: Parameters<PathBasedClient<paths>["/api/local/models/import"]["POST"]>
  ) {
    return this.unwrap(this.postApiLocalModelsImportRaw(...init));
  }

  postApiLocalProjectsRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/local-projects"]["POST"]>
  ) {
    return this.paths["/api/local-projects"].POST(...init);
  }

  postApiLocalProjects(
    ...init: Parameters<PathBasedClient<paths>["/api/local-projects"]["POST"]>
  ) {
    return this.unwrap(this.postApiLocalProjectsRaw(...init));
  }

  postApiLocalProjectsIdAiPublicationsRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/local-projects/{id}/ai-publications"]["POST"]>
  ) {
    return this.paths["/api/local-projects/{id}/ai-publications"].POST(...init);
  }

  postApiLocalProjectsIdAiPublications(
    ...init: Parameters<PathBasedClient<paths>["/api/local-projects/{id}/ai-publications"]["POST"]>
  ) {
    return this.unwrap(this.postApiLocalProjectsIdAiPublicationsRaw(...init));
  }

  postApiLocalProjectsIdMapsRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/local-projects/{id}/maps"]["POST"]>
  ) {
    return this.paths["/api/local-projects/{id}/maps"].POST(...init);
  }

  postApiLocalProjectsIdMaps(
    ...init: Parameters<PathBasedClient<paths>["/api/local-projects/{id}/maps"]["POST"]>
  ) {
    return this.unwrap(this.postApiLocalProjectsIdMapsRaw(...init));
  }

  postApiLocalProjectsIdPackageRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/local-projects/{id}/package"]["POST"]>
  ) {
    return this.paths["/api/local-projects/{id}/package"].POST(...init);
  }

  postApiLocalProjectsIdPackage(
    ...init: Parameters<PathBasedClient<paths>["/api/local-projects/{id}/package"]["POST"]>
  ) {
    return this.unwrap(this.postApiLocalProjectsIdPackageRaw(...init));
  }

  postApiLocalProjectsIdPublishRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/local-projects/{id}/publish"]["POST"]>
  ) {
    return this.paths["/api/local-projects/{id}/publish"].POST(...init);
  }

  postApiLocalProjectsIdPublish(
    ...init: Parameters<PathBasedClient<paths>["/api/local-projects/{id}/publish"]["POST"]>
  ) {
    return this.unwrap(this.postApiLocalProjectsIdPublishRaw(...init));
  }

  postApiLocalProjectsIdRuntimeRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/local-projects/{id}/runtime"]["POST"]>
  ) {
    return this.paths["/api/local-projects/{id}/runtime"].POST(...init);
  }

  postApiLocalProjectsIdRuntime(
    ...init: Parameters<PathBasedClient<paths>["/api/local-projects/{id}/runtime"]["POST"]>
  ) {
    return this.unwrap(this.postApiLocalProjectsIdRuntimeRaw(...init));
  }

  postApiLocalProjectsIdSnapshotsRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/local-projects/{id}/snapshots"]["POST"]>
  ) {
    return this.paths["/api/local-projects/{id}/snapshots"].POST(...init);
  }

  postApiLocalProjectsIdSnapshots(
    ...init: Parameters<PathBasedClient<paths>["/api/local-projects/{id}/snapshots"]["POST"]>
  ) {
    return this.unwrap(this.postApiLocalProjectsIdSnapshotsRaw(...init));
  }

  postApiLocalProjectsImportRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/local-projects/import"]["POST"]>
  ) {
    return this.paths["/api/local-projects/import"].POST(...init);
  }

  postApiLocalProjectsImport(
    ...init: Parameters<PathBasedClient<paths>["/api/local-projects/import"]["POST"]>
  ) {
    return this.unwrap(this.postApiLocalProjectsImportRaw(...init));
  }

  postApiPlayAdminAdminsRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/admins"]["POST"]>
  ) {
    return this.paths["/api/play-admin/admins"].POST(...init);
  }

  postApiPlayAdminAdmins(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/admins"]["POST"]>
  ) {
    return this.unwrap(this.postApiPlayAdminAdminsRaw(...init));
  }

  postApiPlayAdminAiProvidersRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/ai-providers"]["POST"]>
  ) {
    return this.paths["/api/play-admin/ai-providers"].POST(...init);
  }

  postApiPlayAdminAiProviders(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/ai-providers"]["POST"]>
  ) {
    return this.unwrap(this.postApiPlayAdminAiProvidersRaw(...init));
  }

  postApiPlayAdminAiProvidersIdDefaultRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/ai-providers/{id}/default"]["POST"]>
  ) {
    return this.paths["/api/play-admin/ai-providers/{id}/default"].POST(...init);
  }

  postApiPlayAdminAiProvidersIdDefault(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/ai-providers/{id}/default"]["POST"]>
  ) {
    return this.unwrap(this.postApiPlayAdminAiProvidersIdDefaultRaw(...init));
  }

  postApiPlayAdminAiProvidersIdModelsRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/ai-providers/{id}/models"]["POST"]>
  ) {
    return this.paths["/api/play-admin/ai-providers/{id}/models"].POST(...init);
  }

  postApiPlayAdminAiProvidersIdModels(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/ai-providers/{id}/models"]["POST"]>
  ) {
    return this.unwrap(this.postApiPlayAdminAiProvidersIdModelsRaw(...init));
  }

  postApiPlayAdminAiProvidersIdSharingRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/ai-providers/{id}/sharing"]["POST"]>
  ) {
    return this.paths["/api/play-admin/ai-providers/{id}/sharing"].POST(...init);
  }

  postApiPlayAdminAiProvidersIdSharing(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/ai-providers/{id}/sharing"]["POST"]>
  ) {
    return this.unwrap(this.postApiPlayAdminAiProvidersIdSharingRaw(...init));
  }

  postApiPlayAdminAiProvidersIdTestRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/ai-providers/{id}/test"]["POST"]>
  ) {
    return this.paths["/api/play-admin/ai-providers/{id}/test"].POST(...init);
  }

  postApiPlayAdminAiProvidersIdTest(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/ai-providers/{id}/test"]["POST"]>
  ) {
    return this.unwrap(this.postApiPlayAdminAiProvidersIdTestRaw(...init));
  }

  postApiPlayAdminAiProvidersPathRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/ai-providers/{path}"]["POST"]>
  ) {
    return this.paths["/api/play-admin/ai-providers/{path}"].POST(...init);
  }

  postApiPlayAdminAiProvidersPath(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/ai-providers/{path}"]["POST"]>
  ) {
    return this.unwrap(this.postApiPlayAdminAiProvidersPathRaw(...init));
  }

  postApiPlayAdminContainerResourceGroupsRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/container-resource-groups"]["POST"]>
  ) {
    return this.paths["/api/play-admin/container-resource-groups"].POST(...init);
  }

  postApiPlayAdminContainerResourceGroups(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/container-resource-groups"]["POST"]>
  ) {
    return this.unwrap(this.postApiPlayAdminContainerResourceGroupsRaw(...init));
  }

  postApiPlayAdminContainersRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/containers"]["POST"]>
  ) {
    return this.paths["/api/play-admin/containers"].POST(...init);
  }

  postApiPlayAdminContainers(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/containers"]["POST"]>
  ) {
    return this.unwrap(this.postApiPlayAdminContainersRaw(...init));
  }

  postApiPlayAdminIdentityBansRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/identity-bans"]["POST"]>
  ) {
    return this.paths["/api/play-admin/identity-bans"].POST(...init);
  }

  postApiPlayAdminIdentityBans(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/identity-bans"]["POST"]>
  ) {
    return this.unwrap(this.postApiPlayAdminIdentityBansRaw(...init));
  }

  postApiPlayAdminImportRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/import"]["POST"]>
  ) {
    return this.paths["/api/play-admin/import"].POST(...init);
  }

  postApiPlayAdminImport(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/import"]["POST"]>
  ) {
    return this.unwrap(this.postApiPlayAdminImportRaw(...init));
  }

  postApiPlayAdminLibraryImportRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/library/import"]["POST"]>
  ) {
    return this.paths["/api/play-admin/library/import"].POST(...init);
  }

  postApiPlayAdminLibraryImport(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/library/import"]["POST"]>
  ) {
    return this.unwrap(this.postApiPlayAdminLibraryImportRaw(...init));
  }

  postApiPlayAdminLibrarySectionRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/library/{section}"]["POST"]>
  ) {
    return this.paths["/api/play-admin/library/{section}"].POST(...init);
  }

  postApiPlayAdminLibrarySection(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/library/{section}"]["POST"]>
  ) {
    return this.unwrap(this.postApiPlayAdminLibrarySectionRaw(...init));
  }

  postApiPlayAdminLibrarySectionIdRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/library/{section}/{id}"]["POST"]>
  ) {
    return this.paths["/api/play-admin/library/{section}/{id}"].POST(...init);
  }

  postApiPlayAdminLibrarySectionId(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/library/{section}/{id}"]["POST"]>
  ) {
    return this.unwrap(this.postApiPlayAdminLibrarySectionIdRaw(...init));
  }

  postApiPlayAdminLoginRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/login"]["POST"]>
  ) {
    return this.paths["/api/play-admin/login"].POST(...init);
  }

  postApiPlayAdminLogin(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/login"]["POST"]>
  ) {
    return this.unwrap(this.postApiPlayAdminLoginRaw(...init));
  }

  postApiPlayAdminLogoutRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/logout"]["POST"]>
  ) {
    return this.paths["/api/play-admin/logout"].POST(...init);
  }

  postApiPlayAdminLogout(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/logout"]["POST"]>
  ) {
    return this.unwrap(this.postApiPlayAdminLogoutRaw(...init));
  }

  postApiPlayAdminMaintenanceRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/maintenance"]["POST"]>
  ) {
    return this.paths["/api/play-admin/maintenance"].POST(...init);
  }

  postApiPlayAdminMaintenance(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/maintenance"]["POST"]>
  ) {
    return this.unwrap(this.postApiPlayAdminMaintenanceRaw(...init));
  }

  postApiPlayAdminOwnerSessionRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/owner-session"]["POST"]>
  ) {
    return this.paths["/api/play-admin/owner-session"].POST(...init);
  }

  postApiPlayAdminOwnerSession(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/owner-session"]["POST"]>
  ) {
    return this.unwrap(this.postApiPlayAdminOwnerSessionRaw(...init));
  }

  postApiPlayAdminPermissionGroupsRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/permission-groups"]["POST"]>
  ) {
    return this.paths["/api/play-admin/permission-groups"].POST(...init);
  }

  postApiPlayAdminPermissionGroups(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/permission-groups"]["POST"]>
  ) {
    return this.unwrap(this.postApiPlayAdminPermissionGroupsRaw(...init));
  }

  postApiPlayAdminPlayersRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/players"]["POST"]>
  ) {
    return this.paths["/api/play-admin/players"].POST(...init);
  }

  postApiPlayAdminPlayers(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/players"]["POST"]>
  ) {
    return this.unwrap(this.postApiPlayAdminPlayersRaw(...init));
  }

  postApiPlayAdminPlayersBatchRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/players/batch"]["POST"]>
  ) {
    return this.paths["/api/play-admin/players/batch"].POST(...init);
  }

  postApiPlayAdminPlayersBatch(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/players/batch"]["POST"]>
  ) {
    return this.unwrap(this.postApiPlayAdminPlayersBatchRaw(...init));
  }

  postApiPlayAdminPlayersSubjectIdRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/players/{subjectId}"]["POST"]>
  ) {
    return this.paths["/api/play-admin/players/{subjectId}"].POST(...init);
  }

  postApiPlayAdminPlayersSubjectId(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/players/{subjectId}"]["POST"]>
  ) {
    return this.unwrap(this.postApiPlayAdminPlayersSubjectIdRaw(...init));
  }

  postApiPlayAdminScriptModerationRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/script-moderation"]["POST"]>
  ) {
    return this.paths["/api/play-admin/script-moderation"].POST(...init);
  }

  postApiPlayAdminScriptModeration(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/script-moderation"]["POST"]>
  ) {
    return this.unwrap(this.postApiPlayAdminScriptModerationRaw(...init));
  }

  postApiPlayAdminSelfPasswordRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/self-password"]["POST"]>
  ) {
    return this.paths["/api/play-admin/self-password"].POST(...init);
  }

  postApiPlayAdminSelfPassword(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/self-password"]["POST"]>
  ) {
    return this.unwrap(this.postApiPlayAdminSelfPasswordRaw(...init));
  }

  postApiPlayAdminVerifyRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/verify"]["POST"]>
  ) {
    return this.paths["/api/play-admin/verify"].POST(...init);
  }

  postApiPlayAdminVerify(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/verify"]["POST"]>
  ) {
    return this.unwrap(this.postApiPlayAdminVerifyRaw(...init));
  }

  postApiPlayerAiPathRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/player-ai/{path}"]["POST"]>
  ) {
    return this.paths["/api/player-ai/{path}"].POST(...init);
  }

  postApiPlayerAiPath(
    ...init: Parameters<PathBasedClient<paths>["/api/player-ai/{path}"]["POST"]>
  ) {
    return this.unwrap(this.postApiPlayerAiPathRaw(...init));
  }

  postApiPlayerAuthLoginRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/player-auth/login"]["POST"]>
  ) {
    return this.paths["/api/player-auth/login"].POST(...init);
  }

  postApiPlayerAuthLogin(
    ...init: Parameters<PathBasedClient<paths>["/api/player-auth/login"]["POST"]>
  ) {
    return this.unwrap(this.postApiPlayerAuthLoginRaw(...init));
  }

  postApiPlayerAuthLogoutRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/player-auth/logout"]["POST"]>
  ) {
    return this.paths["/api/player-auth/logout"].POST(...init);
  }

  postApiPlayerAuthLogout(
    ...init: Parameters<PathBasedClient<paths>["/api/player-auth/logout"]["POST"]>
  ) {
    return this.unwrap(this.postApiPlayerAuthLogoutRaw(...init));
  }

  postApiPlayerAuthPasswordRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/player-auth/password"]["POST"]>
  ) {
    return this.paths["/api/player-auth/password"].POST(...init);
  }

  postApiPlayerAuthPassword(
    ...init: Parameters<PathBasedClient<paths>["/api/player-auth/password"]["POST"]>
  ) {
    return this.unwrap(this.postApiPlayerAuthPasswordRaw(...init));
  }

  postApiPlayerAuthRegisterRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/player-auth/register"]["POST"]>
  ) {
    return this.paths["/api/player-auth/register"].POST(...init);
  }

  postApiPlayerAuthRegister(
    ...init: Parameters<PathBasedClient<paths>["/api/player-auth/register"]["POST"]>
  ) {
    return this.unwrap(this.postApiPlayerAuthRegisterRaw(...init));
  }

  postApiPlayerAuthTransferRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/player-auth/transfer"]["POST"]>
  ) {
    return this.paths["/api/player-auth/transfer"].POST(...init);
  }

  postApiPlayerAuthTransfer(
    ...init: Parameters<PathBasedClient<paths>["/api/player-auth/transfer"]["POST"]>
  ) {
    return this.unwrap(this.postApiPlayerAuthTransferRaw(...init));
  }

  postApiPlayerInternalLoginTransferRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/player-internal/login-transfer"]["POST"]>
  ) {
    return this.paths["/api/player-internal/login-transfer"].POST(...init);
  }

  postApiPlayerInternalLoginTransfer(
    ...init: Parameters<PathBasedClient<paths>["/api/player-internal/login-transfer"]["POST"]>
  ) {
    return this.unwrap(this.postApiPlayerInternalLoginTransferRaw(...init));
  }

  postApiPlayerInternalLogoutRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/player-internal/logout"]["POST"]>
  ) {
    return this.paths["/api/player-internal/logout"].POST(...init);
  }

  postApiPlayerInternalLogout(
    ...init: Parameters<PathBasedClient<paths>["/api/player-internal/logout"]["POST"]>
  ) {
    return this.unwrap(this.postApiPlayerInternalLogoutRaw(...init));
  }

  postApiPlayerInternalMapAdmissionRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/player-internal/map-admission"]["POST"]>
  ) {
    return this.paths["/api/player-internal/map-admission"].POST(...init);
  }

  postApiPlayerInternalMapAdmission(
    ...init: Parameters<PathBasedClient<paths>["/api/player-internal/map-admission"]["POST"]>
  ) {
    return this.unwrap(this.postApiPlayerInternalMapAdmissionRaw(...init));
  }

  postApiPlayerInternalRuntimeIdentityRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/player-internal/runtime-identity"]["POST"]>
  ) {
    return this.paths["/api/player-internal/runtime-identity"].POST(...init);
  }

  postApiPlayerInternalRuntimeIdentity(
    ...init: Parameters<PathBasedClient<paths>["/api/player-internal/runtime-identity"]["POST"]>
  ) {
    return this.unwrap(this.postApiPlayerInternalRuntimeIdentityRaw(...init));
  }

  postApiPlayerInternalScriptMetadataRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/player-internal/script-metadata"]["POST"]>
  ) {
    return this.paths["/api/player-internal/script-metadata"].POST(...init);
  }

  postApiPlayerInternalScriptMetadata(
    ...init: Parameters<PathBasedClient<paths>["/api/player-internal/script-metadata"]["POST"]>
  ) {
    return this.unwrap(this.postApiPlayerInternalScriptMetadataRaw(...init));
  }

  postApiPlayerInternalScriptModerationRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/player-internal/script-moderation"]["POST"]>
  ) {
    return this.paths["/api/player-internal/script-moderation"].POST(...init);
  }

  postApiPlayerInternalScriptModeration(
    ...init: Parameters<PathBasedClient<paths>["/api/player-internal/script-moderation"]["POST"]>
  ) {
    return this.unwrap(this.postApiPlayerInternalScriptModerationRaw(...init));
  }

  postApiPlayLogoutRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/play-logout"]["POST"]>
  ) {
    return this.paths["/api/play-logout"].POST(...init);
  }

  postApiPlayLogout(
    ...init: Parameters<PathBasedClient<paths>["/api/play-logout"]["POST"]>
  ) {
    return this.unwrap(this.postApiPlayLogoutRaw(...init));
  }

  postApiPlayPresenceRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/play-presence"]["POST"]>
  ) {
    return this.paths["/api/play-presence"].POST(...init);
  }

  postApiPlayPresence(
    ...init: Parameters<PathBasedClient<paths>["/api/play-presence"]["POST"]>
  ) {
    return this.unwrap(this.postApiPlayPresenceRaw(...init));
  }

  postApiProjectModelsRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/project-models"]["POST"]>
  ) {
    return this.paths["/api/project-models"].POST(...init);
  }

  postApiProjectModels(
    ...init: Parameters<PathBasedClient<paths>["/api/project-models"]["POST"]>
  ) {
    return this.unwrap(this.postApiProjectModelsRaw(...init));
  }

  postApiProjectScriptsRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/project-scripts"]["POST"]>
  ) {
    return this.paths["/api/project-scripts"].POST(...init);
  }

  postApiProjectScripts(
    ...init: Parameters<PathBasedClient<paths>["/api/project-scripts"]["POST"]>
  ) {
    return this.unwrap(this.postApiProjectScriptsRaw(...init));
  }

  postApiProjectSkinsRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/project-skins"]["POST"]>
  ) {
    return this.paths["/api/project-skins"].POST(...init);
  }

  postApiProjectSkins(
    ...init: Parameters<PathBasedClient<paths>["/api/project-skins"]["POST"]>
  ) {
    return this.unwrap(this.postApiProjectSkinsRaw(...init));
  }

  postApiRealtimeSessionRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/realtime/session"]["POST"]>
  ) {
    return this.paths["/api/realtime/session"].POST(...init);
  }

  postApiRealtimeSession(
    ...init: Parameters<PathBasedClient<paths>["/api/realtime/session"]["POST"]>
  ) {
    return this.unwrap(this.postApiRealtimeSessionRaw(...init));
  }

  postApiRuntimeEnsureRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/runtime/ensure"]["POST"]>
  ) {
    return this.paths["/api/runtime/ensure"].POST(...init);
  }

  postApiRuntimeEnsure(
    ...init: Parameters<PathBasedClient<paths>["/api/runtime/ensure"]["POST"]>
  ) {
    return this.unwrap(this.postApiRuntimeEnsureRaw(...init));
  }

  postApiSystemBackupsRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/system/backups"]["POST"]>
  ) {
    return this.paths["/api/system/backups"].POST(...init);
  }

  postApiSystemBackups(
    ...init: Parameters<PathBasedClient<paths>["/api/system/backups"]["POST"]>
  ) {
    return this.unwrap(this.postApiSystemBackupsRaw(...init));
  }

  postBlockRaw(
    ...init: Parameters<PathBasedClient<paths>["/block"]["POST"]>
  ) {
    return this.paths["/block"].POST(...init);
  }

  postBlock(
    ...init: Parameters<PathBasedClient<paths>["/block"]["POST"]>
  ) {
    return this.unwrap(this.postBlockRaw(...init));
  }

  postBlockHashRaw(
    ...init: Parameters<PathBasedClient<paths>["/block/{hash}"]["POST"]>
  ) {
    return this.paths["/block/{hash}"].POST(...init);
  }

  postBlockHash(
    ...init: Parameters<PathBasedClient<paths>["/block/{hash}"]["POST"]>
  ) {
    return this.unwrap(this.postBlockHashRaw(...init));
  }

  postCreateSessionRaw(
    ...init: Parameters<PathBasedClient<paths>["/createSession"]["POST"]>
  ) {
    return this.paths["/createSession"].POST(...init);
  }

  postCreateSession(
    ...init: Parameters<PathBasedClient<paths>["/createSession"]["POST"]>
  ) {
    return this.unwrap(this.postCreateSessionRaw(...init));
  }

  postInternalSaveLocalProjectRaw(
    ...init: Parameters<PathBasedClient<paths>["/internal/save-local-project"]["POST"]>
  ) {
    return this.paths["/internal/save-local-project"].POST(...init);
  }

  postInternalSaveLocalProject(
    ...init: Parameters<PathBasedClient<paths>["/internal/save-local-project"]["POST"]>
  ) {
    return this.unwrap(this.postInternalSaveLocalProjectRaw(...init));
  }

  postLocalRuntimeDestroyRaw(
    ...init: Parameters<PathBasedClient<paths>["/__local_runtime/destroy"]["POST"]>
  ) {
    return this.paths["/__local_runtime/destroy"].POST(...init);
  }

  postLocalRuntimeDestroy(
    ...init: Parameters<PathBasedClient<paths>["/__local_runtime/destroy"]["POST"]>
  ) {
    return this.unwrap(this.postLocalRuntimeDestroyRaw(...init));
  }

  postLocalRuntimeStartRaw(
    ...init: Parameters<PathBasedClient<paths>["/__local_runtime/start"]["POST"]>
  ) {
    return this.paths["/__local_runtime/start"].POST(...init);
  }

  postLocalRuntimeStart(
    ...init: Parameters<PathBasedClient<paths>["/__local_runtime/start"]["POST"]>
  ) {
    return this.unwrap(this.postLocalRuntimeStartRaw(...init));
  }

  postRoomRoomIdLocalRuntimeDestroyRaw(
    ...init: Parameters<PathBasedClient<paths>["/__room/{roomId}/__local_runtime/destroy"]["POST"]>
  ) {
    return this.paths["/__room/{roomId}/__local_runtime/destroy"].POST(...init);
  }

  postRoomRoomIdLocalRuntimeDestroy(
    ...init: Parameters<PathBasedClient<paths>["/__room/{roomId}/__local_runtime/destroy"]["POST"]>
  ) {
    return this.unwrap(this.postRoomRoomIdLocalRuntimeDestroyRaw(...init));
  }

  putApiCreatorModelsIdRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/creator-models/{id}"]["PUT"]>
  ) {
    return this.paths["/api/creator-models/{id}"].PUT(...init);
  }

  putApiCreatorModelsId(
    ...init: Parameters<PathBasedClient<paths>["/api/creator-models/{id}"]["PUT"]>
  ) {
    return this.unwrap(this.putApiCreatorModelsIdRaw(...init));
  }

  putApiCreatorV1ProjectsProjectIdScriptsSideEntryRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/creator/v1/projects/{projectId}/scripts/{side}/{entry}"]["PUT"]>
  ) {
    return this.paths["/api/creator/v1/projects/{projectId}/scripts/{side}/{entry}"].PUT(...init);
  }

  putApiCreatorV1ProjectsProjectIdScriptsSideEntry(
    ...init: Parameters<PathBasedClient<paths>["/api/creator/v1/projects/{projectId}/scripts/{side}/{entry}"]["PUT"]>
  ) {
    return this.unwrap(this.putApiCreatorV1ProjectsProjectIdScriptsSideEntryRaw(...init));
  }

  putApiCreatorV1ProjectsProjectIdStorageScopeSpaceRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/creator/v1/projects/{projectId}/storage/{scope}/{space}"]["PUT"]>
  ) {
    return this.paths["/api/creator/v1/projects/{projectId}/storage/{scope}/{space}"].PUT(...init);
  }

  putApiCreatorV1ProjectsProjectIdStorageScopeSpace(
    ...init: Parameters<PathBasedClient<paths>["/api/creator/v1/projects/{projectId}/storage/{scope}/{space}"]["PUT"]>
  ) {
    return this.unwrap(this.putApiCreatorV1ProjectsProjectIdStorageScopeSpaceRaw(...init));
  }

  putApiLocalDefaultSkinRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/local/default-skin"]["PUT"]>
  ) {
    return this.paths["/api/local/default-skin"].PUT(...init);
  }

  putApiLocalDefaultSkin(
    ...init: Parameters<PathBasedClient<paths>["/api/local/default-skin"]["PUT"]>
  ) {
    return this.unwrap(this.putApiLocalDefaultSkinRaw(...init));
  }

  putApiLocalModelsIdRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/local/models/{id}"]["PUT"]>
  ) {
    return this.paths["/api/local/models/{id}"].PUT(...init);
  }

  putApiLocalModelsId(
    ...init: Parameters<PathBasedClient<paths>["/api/local/models/{id}"]["PUT"]>
  ) {
    return this.unwrap(this.putApiLocalModelsIdRaw(...init));
  }

  putApiLocalModelsIdModelRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/local/models/{id}/model"]["PUT"]>
  ) {
    return this.paths["/api/local/models/{id}/model"].PUT(...init);
  }

  putApiLocalModelsIdModel(
    ...init: Parameters<PathBasedClient<paths>["/api/local/models/{id}/model"]["PUT"]>
  ) {
    return this.unwrap(this.putApiLocalModelsIdModelRaw(...init));
  }

  putApiPlayAdminSiteConfigRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/site-config"]["PUT"]>
  ) {
    return this.paths["/api/play-admin/site-config"].PUT(...init);
  }

  putApiPlayAdminSiteConfig(
    ...init: Parameters<PathBasedClient<paths>["/api/play-admin/site-config"]["PUT"]>
  ) {
    return this.unwrap(this.putApiPlayAdminSiteConfigRaw(...init));
  }

  putApiPlayerAiPathRaw(
    ...init: Parameters<PathBasedClient<paths>["/api/player-ai/{path}"]["PUT"]>
  ) {
    return this.paths["/api/player-ai/{path}"].PUT(...init);
  }

  putApiPlayerAiPath(
    ...init: Parameters<PathBasedClient<paths>["/api/player-ai/{path}"]["PUT"]>
  ) {
    return this.unwrap(this.putApiPlayerAiPathRaw(...init));
  }

}

export const createApiClient = (options: ApiClientOptions = {}) => new ApiClient(options);
