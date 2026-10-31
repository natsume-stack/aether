import * as fs from 'node:fs';
import * as path from 'node:path';

interface WindowSize {
    width:number;
    height:number;
    maximized:boolean;
}

export function createWindowStateStore(filename:string) {
    let sizes:Record<string, WindowSize> = {};
    try {
        sizes = JSON.parse(fs.readFileSync(filename, 'utf8'));
    } catch {
        /* First launch uses defaults. */
    }
    return {
        read(key:string, defaults:{ width:number; height:number }):WindowSize {
            const value = sizes[key];
            if (
                !value ||
                !Number.isFinite(value.width) ||
                !Number.isFinite(value.height) ||
                value.width < 900 ||
                value.height < 620 ||
                value.width > 8192 ||
                value.height > 8192
            ) {
                return { ...defaults, maximized: false };
            }
            return value;
        },
        save(key:string, value:WindowSize):void {
            sizes[key] = value;
            try {
                fs.mkdirSync(path.dirname(filename), { recursive: true });
                fs.writeFileSync(filename, JSON.stringify(sizes), { mode: 0o600 });
            } catch {
                /* Window preferences must never prevent closing the app. */
            }
        },
    };
}
