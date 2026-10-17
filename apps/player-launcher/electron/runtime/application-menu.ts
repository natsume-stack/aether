import type { Menu, WebContents } from 'electron';

export function hideApplicationMenu(api:typeof Menu, platform = process.platform):void {
    // An explicit empty native menu prevents macOS restoring the default menu
    // when windows are created or become active.
    api.setApplicationMenu(platform === 'darwin' ? api.buildFromTemplate([]) : null);
}

export function installEditingShortcuts(contents:WebContents, platform = process.platform):void {
    // An empty native menu removes macOS edit accelerators. Dispatch them to
    // the focused frame without exposing a renderer clipboard bridge.
    contents.on('before-input-event', (event, input) => {
        if (
            input.type !== 'keyDown' ||
            input.alt ||
            !(platform === 'darwin' ? input.meta : input.control)
        ) {
            return;
        }
        const key = input.key.toLowerCase();
        const command =
            key === 'v' && input.shift
                ? 'pasteAndMatchStyle'
                : key === 'z'
                  ? input.shift
                      ? 'redo'
                      : 'undo'
                  : !input.shift
                    ? (
                          {
                              c: 'copy',
                              v: 'paste',
                              x: 'cut',
                              a: 'selectAll',
                              y: platform === 'darwin' ? undefined : 'redo',
                          } as const
                      )[key]
                    : undefined;
        if (!command) {
            return;
        }
        event.preventDefault();
        contents[command]();
    });
}
