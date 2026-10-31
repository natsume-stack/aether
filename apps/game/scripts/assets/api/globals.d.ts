declare type GameLoggerMethod = (...args: any[]) => void;

declare const console: {
  assert: (assertion, ...args: any[]) => void;
  log: GameLoggerMethod;
  debug: GameLoggerMethod;
  error: GameLoggerMethod;
  warn: GameLoggerMethod;
  clear: GameLoggerMethod;
};

declare const world: GameWorld;
declare const voxels: GameVoxels;
declare const resources: {
  ls: (path?: string) => GameAssetListEntry[];
};
declare const db: GameDatabase;
declare const storage: GameStorage;
declare const http: GameHttpAPI;
declare const rtc: GameRTC;
declare const gui: GameGUI;
declare const remoteChannel: ServerRemoteChannel;

declare function sleep(ms: number): Promise<void>;

declare const require: {
  (module: string): any;
  resolve: (path: string) => string;
};
declare const module: {
  exports: any;
};
declare const exports: any;
declare const __dirname: string;
declare const __filename: string;
