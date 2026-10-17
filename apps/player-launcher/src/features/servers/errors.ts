import { ADDRESS_ERROR } from '../../../shared/server-address';

const CONNECTION_ERRORS:Array<[needle: string, message: string]> = [
    ['服务器服务未启动', '无法连接游玩服务，请确认服务已启动、地址和端口正确后重新检查。'],
    ['API 请求超时', '服务器响应超时，请稍后重新检查。'],
    ['无法解析服务器地址', '无法解析服务器地址，请检查地址后重新检查。'],
    ['服务器连接被中断', '服务器连接已中断，请稍后重新检查。'],
    ['无法连接到游玩端服务器', '无法连接游玩服务，请检查地址、端口和网络后重新检查。'],
    ['游玩端尚未就绪', '游玩端正在启动，请稍后重新检查。'],
];

/** Recognize known transport failures; never render raw IPC exceptions or stack details. */
export function playerServerConnectionError(error:unknown):string {
    const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
    return (
        CONNECTION_ERRORS.find(([needle]) => raw.includes(needle))?.[1] ||
        '无法读取服务器状态，请检查地址、端口和网络后重新检查。'
    );
}

const PLAYER_SERVER_ERRORS:Array<[needle: string, message: string]> = [
    [ADDRESS_ERROR, '服务器地址格式不正确，请输入有效的网址、IPv4 或 IPv6 地址。'],
    ['请输入有效的游玩端服务器 IP 或域名', '服务器地址格式不正确，请检查后重试。'],
    ['无法连接到游玩端服务器', '无法连接到游玩端服务器，请检查地址、端口和网络后重试。'],
    ['服务器已响应', '服务器已响应，但不是可用的 BOX3 游玩端。请检查地址和端口。'],
    ['游玩端尚未就绪', '游玩端正在启动，请稍后重试。'],
];

/** Converts desktop IPC/network failures into concise messages for players. */
export function playerServerAddError(error:unknown):string {
    const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
    for (const [needle, message] of PLAYER_SERVER_ERRORS) {
        if (raw.includes(needle)) {
            return message;
        }
    }
    return '无法添加服务器，请检查地址、端口和网络后重试。';
}
