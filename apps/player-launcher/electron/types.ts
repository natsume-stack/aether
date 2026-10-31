export interface PlayerServerRecord {
    id:string;
    endpoint:string;
    name:string;
}

export interface PlayerServerState {
    servers:PlayerServerRecord[];
    selectedServerId:string | null;
}

export interface ApiRequest {
    endpoint:string;
    url:string;
    method:string;
    headers?:Array<[string, string]>;
    body?:string | null;
}

export interface ApiResponse {
    status:number;
    headers:Array<[string, string]>;
    body:string;
}

export interface ApiTransport {
    request(request:ApiRequest):Promise<ApiResponse>;
    /** Clear player session cookies while retaining the server-advertised login portal. */
    clear(endpoint:string):void;
    /** Forget both session cookies and the server-advertised login portal. */
    forget(endpoint:string):void;
    cookies(endpoint:string):Array<[string, string]>;
}

export interface PublicImageTransport {
    fetch(endpoint:string, url:string):Promise<string>;
}

export interface PackageAsset {
    hash:string;
    size:number;
    kind:'static';
    contentType:string;
}

export interface PackageDescriptor {
    formatVersion:1;
    permanentMapId:string;
    accessId:string;
    releaseVersion:string;
    required:PackageAsset[];
    optional:PackageAsset[];
    manifestDigest:string;
    signature:{
        algorithm:'ES256';
        keyId:string;
        publicKey:{ kty:'EC'; crv:'P-256'; x:string; y:string };
        value:string;
    };
}

export interface TrustedSigningKey {
    keyId:string;
    publicKey:{ kty:string; crv:string; x:string; y:string };
}

export interface ElectronCommandPayload extends Record<string, any> {
    endpoint?:string;
    url?:string;
    serverId?:string;
    name?:string;
    request?:ApiRequest;
    descriptor?:string;
    trustedSigningKey?:string;
}
