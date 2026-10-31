import { useEffect, useRef } from 'react';
import { subscribeRealtime } from '@box/realtime-client';
/** Notifications carry no player details; the normal API rechecks live read permissions. */
export function useAdminEvents(enabled:boolean, onChange:(topic:string) => void) {
    const latest = useRef(onChange);
    latest.current = onChange;
    useEffect(() => {
        if (!enabled) {
            return;
        }
        const cookie = document.cookie
            .split(';')
            .map((value) => value.trim())
            .find((value) => value.startsWith('box_local_admin_csrf='));
        const csrf = cookie ? decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1)) : '';
        let timer:ReturnType<typeof setTimeout> | undefined;
        let topic = '';
        const stop = subscribeRealtime(
            'admin-events',
            { body: { kind: 'admin-events' }, headers: { 'X-Box-Admin-Csrf': csrf } },
            (event) => {
                if (event.type === 'unauthorized' || event.type === 'reauthenticate') {
                    latest.current('authorization');
                    return;
                }
                if (event.type !== 'change' && event.type !== 'ready') {
                    return;
                }
                topic =
                    event.type === 'ready'
                        ? 'resync'
                        : topic && topic !== event.topic
                          ? 'resync'
                          : event.topic;
                if (!timer) {
                    timer = setTimeout(() => {
                        timer = undefined;
                        const value = topic;
                        topic = '';
                        latest.current(value);
                    }, 250);
                }
            },
        );
        return () => {
            clearTimeout(timer);
            stop();
        };
    }, [enabled]);
}
