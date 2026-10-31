import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ApiRequestTiming {
    at:string;
    origin:string;
    path:string;
    method:string;
    elapsedMs:number;
    timeoutMs:number;
    status?:number;
    contentType?:string;
    outcome:'ok' | 'http-error' | 'timeout' | 'connection-error' | 'response-error' | 'blocked';
}

/** Bounded transport metadata only: no body, username, cookie, query or ticket. */
export function createRequestDiagnostics(filename:string):(record:ApiRequestTiming) => void {
    let records:ApiRequestTiming[] = [];
    try {
        const saved = JSON.parse(fs.readFileSync(filename, 'utf8'));
        if (Array.isArray(saved)) {
            records = saved.slice(-100);
        }
    } catch {
        /* Diagnostics are optional. */
    }
    return (record) => {
        records.push(record);
        records = records.slice(-100);
        try {
            fs.mkdirSync(path.dirname(filename), { recursive: true });
            fs.writeFileSync(filename, JSON.stringify(records), { mode: 0o600 });
        } catch {
            /* Recording must never change a request's outcome. */
        }
    };
}
