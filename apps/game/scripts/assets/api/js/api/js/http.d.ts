type GameHttpFetchHeaders = {
    [name: string]: string | string[];
};
type GameHttpFetchRequestOptions = {
    timeout?: number;
    method?: 'OPTIONS' | 'GET' | 'HEAD' | 'PUT' | 'POST' | 'DELETE' | 'PATCH';
    headers?: GameHttpFetchHeaders;
    body?: string | ArrayBuffer;
};
declare class GameHttpFetchResponse {
    status: number;
    statusText: string;
    headers: GameHttpFetchHeaders;
    json: () => Promise<any>;
    text: () => Promise<string>;
    arrayBuffer: () => Promise<ArrayBuffer>;
    close: () => Promise<void>;
    constructor(status: number, statusText: string, headers: GameHttpFetchHeaders, json: () => Promise<any>, text: () => Promise<string>, arrayBuffer: () => Promise<ArrayBuffer>, close: () => Promise<void>);
    get ok(): boolean;
}
declare class GameHttpRequest {
}
declare class GameHttpResponse {
}
type GameHttpHandler = (request: GameHttpRequest, response: GameHttpResponse) => void;
declare class GameHttpAPI {
    fetch: (url: string, options?: GameHttpFetchRequestOptions) => Promise<GameHttpFetchResponse>;
    constructor(fetch: (url: string, options?: GameHttpFetchRequestOptions) => Promise<GameHttpFetchResponse>);
}
