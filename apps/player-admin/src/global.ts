import bootstrap from '@box/deployment-routing/browser';
const script = document.currentScript as HTMLScriptElement | null;
const source =
    script?.src ||
    Array.from(document.scripts)
        .map((script) => script.src)
        .find((src) => src.includes('/player-admin/')) ||
    '';
const pathname = source ? new URL(source).pathname : '';
const basePath = pathname.includes('/player-admin/')
    ? pathname.slice(0, pathname.indexOf('/player-admin/'))
    : '';
if (basePath && !(window as any).__BOX_APP_BASE_PATH__) {
    const configure = document.createElement('script');
    configure.textContent = bootstrap({ basePath, peerPaths: [] });
    document.head.prepend(configure);
}
