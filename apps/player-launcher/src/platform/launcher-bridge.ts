type LauncherEvent<T = unknown> = { payload:T };
type Unlisten = () => void;

declare global {
    interface Window {
        boxPlayerLauncher?:{
            invoke<T = unknown>(command:string, payload?:unknown):Promise<T>;
            listen<T = unknown>(
                eventName:string,
                callback:(event:LauncherEvent<T>) => void,
            ):Promise<Unlisten>;
        };
    }
}

export function isDesktopLauncher() {
    return Boolean(window.boxPlayerLauncher);
}

export function invoke<T = unknown>(command:string, payload?:unknown):Promise<T> {
    if (!window.boxPlayerLauncher) {
        return Promise.reject(new Error('请在 BOX3 Player Launcher 桌面应用中使用此功能'));
    }
    return window.boxPlayerLauncher.invoke<T>(command, payload);
}

export function listen<T = unknown>(
    eventName:string,
    callback:(event:LauncherEvent<T>) => void,
):Promise<Unlisten> {
    if (!window.boxPlayerLauncher) {
        return Promise.reject(new Error('桌面启动器事件通道不可用'));
    }
    return window.boxPlayerLauncher.listen<T>(eventName, callback);
}
