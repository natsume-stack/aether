import { useCallback, useState } from 'react';

import { reportAdminError } from '../player-admin-errors';

/** Each overlapping request contributes to loading until its own completion. */
export function useAdminRequest() {
    const [pending, setPending] = useState(0);
    const run = useCallback(async <T>(operation:() => Promise<T>):Promise<T | undefined> => {
        setPending((count) => count + 1);
        try {
            return await operation();
        } catch (error) {
            reportAdminError(error);
            return undefined;
        } finally {
            setPending((count) => count - 1);
        }
    }, []);
    return { loading: pending > 0, run };
}
