interface GUIData {
    name: string;
    attributes?: {
        [name: string]: string | number;
    };
    children?: GUIData[];
}
interface GUIBind<T extends string> {
    event: string;
    selector?: string;
    action: T;
}
interface GUIBindDefinition<T> {
    drag: {
        attributes: {
            [name: string]: 'x' | '-x' | 'y' | '-y';
        };
        targetSelector: string;
    };
    show: {
        name: T;
        allowMultiple?: boolean;
    };
    remove: {
        targetSelector: string;
    };
    sendMessage: {
        messageName: string;
        messageData?: string[];
    };
    clipboardWrite: {
        targetSelector: string;
        attributeName: string;
    };
}
type GUIBindTypeMap<T> = {
    [key in keyof GUIBindDefinition<T>]: GUIBind<key> & GUIBindDefinition<T>[key];
};
type GUIBindTypes<T> = GUIBindTypeMap<T>[keyof GUIBindTypeMap<T>];
interface GUIConfigItem<T extends string> {
    display?: boolean;
    bindings?: GUIBindTypes<T>[];
    data: string | GUIData;
}
type GUIConfig<T extends string, U extends T> = {
    [name in T]: GUIConfigItem<U>;
};
