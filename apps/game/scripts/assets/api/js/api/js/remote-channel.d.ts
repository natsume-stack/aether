

type SendClientEventType = (entities: GamePlayerEntity | GamePlayerEntity[], clientEvent: JSONValue) => void;
type ServerEvent = {
    tick: number;
    entity: GamePlayerEntity;
    args: JSONValue;
};
declare class ServerRemoteChannel {
    sendClientEvent: SendClientEventType;
    broadcastClientEvent: (clientEvent: JSONValue) => void;
    onServerEvent: GameEventChannel<ServerEvent>;
    constructor(sendClientEvent: SendClientEventType, broadcastClientEvent: (clientEvent: JSONValue) => void, onServerEvent: GameEventChannel<ServerEvent>);
}
