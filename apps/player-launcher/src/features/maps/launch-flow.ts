import type { PlayerServer, RemoteApi, ServerBootstrap } from '../../types';

export interface PrepareMapLaunchOptions {
    server:PlayerServer;
    mapId:string;
    bootstrap:ServerBootstrap;
    remoteApi:RemoteApi;
    onStage?:(stage:string) => void;
}

/** Verifies the server-signed map descriptor and obtains a short-lived launch ticket. */
export async function prepareMapLaunch({
    server,
    mapId,
    bootstrap,
    remoteApi,
    onStage,
}:PrepareMapLaunchOptions) {
    if (!bootstrap?.signingKey) {
        throw new Error('服务器未提供有效的地图资源签名信息。');
    }

    onStage?.('正在检查地图版本…');
    const descriptorResult = await remoteApi.getDescriptor(server.endpoint, mapId);
    if (!descriptorResult.response.ok || !descriptorResult.data) {
        throw new Error(
            descriptorResult.error?.message ||
                `读取地图资源清单失败（HTTP ${descriptorResult.response.status}）`,
        );
    }

    onStage?.('正在校验地图资源…');
    const trustedSigningKey = bootstrap.signingKey;
    const descriptor = await remoteApi.verifyDescriptor(descriptorResult.data, trustedSigningKey);

    onStage?.('正在准备进入地图…');
    const plan = await remoteApi.getDownloadPlan(server.endpoint, descriptor.accessId);
    if (!plan.response.ok || !plan.data?.ticket) {
        throw new Error(
            plan.error?.message || `获取地图启动授权失败（HTTP ${plan.response.status}）`,
        );
    }
    if (plan.data.manifestDigest !== descriptor.manifestDigest) {
        throw new Error('地图已发布新版本，请重新检查后再开始游玩。');
    }
    return { descriptor, trustedSigningKey, launchTicket: plan.data.ticket };
}
