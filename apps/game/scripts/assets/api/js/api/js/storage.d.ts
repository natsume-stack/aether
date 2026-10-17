
type DB_ERROR_STATUS = 'CONSTRAINT_TARGET_INVALID' | 'PARAMS_INVALID' | 'DB_NAME_INVALID' | 'KEY_INVALID' | 'VALUE_INVALID' | 'SERVER_FETCH_ERROR' | 'REQUEST_THROTTLED' | 'INCREMENT_INVALID' | 'UNKNOWN';
declare class GameStorage implements I.GameStorage {
    getDataStorage: (key: string) => GameDataStorage;
    getGroupStorage: (key: string) => GameDataStorage | undefined;
    constructor(getDataStorage: (key: string) => GameDataStorage, getGroupStorage: (key: string) => GameDataStorage | undefined);
}
type JSONValue = I.JSONValue;
type ResultValue = {
    key: string;
    value: JSONValue;
    version: string;
    updateTime: number;
    createTime: number;
};
type ListReturnValue = {
    items: ResultValue[];
    isLastPage: boolean;
};
type ReturnValue = I.ReturnValue;
type ListPageOptions = I.ListPageOptions;
/**
 *
 * A Data storage class
 * @export
 * @class GameDataStorage
 */
declare class GameDataStorage implements I.GameDataStorage {
    readonly key: string;
    set: (key: string, value: JSONValue) => Promise<void>;
    update: (key: string, handler: (prevValue: ReturnValue) => JSONValue) => Promise<void>;
    get: (key: string) => Promise<ReturnValue>;
    increment: (key: string, value?: number) => Promise<number>;
    list: (options: ListPageOptions) => Promise<QueryList>;
    remove: (key: string) => Promise<ReturnValue>;
    destroy: () => Promise<void>;
    constructor(key: string, set: (key: string, value: JSONValue) => Promise<void>, update: (key: string, handler: (prevValue: ReturnValue) => JSONValue) => Promise<void>, get: (key: string) => Promise<ReturnValue>, increment: (key: string, value?: number) => Promise<number>, list: (options: ListPageOptions) => Promise<QueryList>, remove: (key: string) => Promise<ReturnValue>, destroy: () => Promise<void>);
}
declare class QueryList implements I.QueryList {
    getCurrentPage: () => ReturnValue[];
    nextPage: () => Promise<void>;
    isLastPage: boolean;
    constructor(getCurrentPage: () => ReturnValue[], nextPage: () => Promise<void>);
}
