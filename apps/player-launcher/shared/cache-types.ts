export interface CachedMap {
    mapId:string;
    name:string;
    versions:string[];
    bytes:number;
    resources:number;
}

export interface ServerCacheUsage {
    serverId:string;
    staticBytes:number;
    httpBytes:number;
    inUse:boolean;
    maps:CachedMap[];
}
