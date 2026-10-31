export function icon(name:string):string {
    const paths = {
        servers:
            '<rect x="3" y="4" width="18" height="6" rx="1.5"/><rect x="3" y="14" width="18" height="6" rx="1.5"/><path d="M7 7h.01M7 17h.01M11 7h6M11 17h6"/>',
        packages:
            '<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z"/><path d="m4.5 7.8 7.5 4.3 7.5-4.3M12 12v9"/>',
        plus: '<path d="M12 5v14M5 12h14"/>',
        globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/>',
        play: '<path d="m8 5 11 7-11 7V5Z"/>',
        trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 14h10l1-14M9 7V4h6v3"/>',
        arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
        device: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
        chevron: '<path d="m9 18 6-6-6-6"/>',
        edit: '<path d="m15 5 4 4M4 20l4-.8L19 8a2.12 2.12 0 0 0-3-3L5 16l-1 4Z"/>',
        check: '<path d="m5 12 4 4L19 6"/>',
        close: '<path d="m6 6 12 12M18 6 6 18"/>',
    };
    return `<svg aria-hidden="true" viewBox="0 0 24 24">${paths[name] || ''}</svg>`;
}
