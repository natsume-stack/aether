import { contextBridge, ipcRenderer } from 'electron';

const allowedEvents = new Set<string>(['game-state']);

contextBridge.exposeInMainWorld(
    'boxPlayerLauncher',
    Object.freeze({
        invoke(command:string, payload:unknown = {}):Promise<unknown> {
            return ipcRenderer.invoke('launcher:invoke', command, payload);
        },
        listen(eventName:string, callback:(event:{ payload:unknown }) => void):Promise<() => void> {
            if (!allowedEvents.has(eventName) || typeof callback !== 'function') {
                throw new Error('不允许的启动器事件');
            }
            const listener = (_event:Electron.IpcRendererEvent, payload:unknown) =>
                callback({ payload });
            ipcRenderer.on(`launcher:event:${eventName}`, listener);
            return Promise.resolve(() =>
                ipcRenderer.removeListener(`launcher:event:${eventName}`, listener),
            );
        },
    }),
);
