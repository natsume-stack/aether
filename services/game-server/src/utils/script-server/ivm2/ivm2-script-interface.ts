import ivm from 'isolated-vm';

export type Ivm2HostInterface = {
  sessionId: string;
  ivm: typeof ivm;

  notifyReady: ivm.Reference<() => void>;
  postMessage: ivm.Reference<
    (x: string | ArrayBuffer, unreliable: boolean) => void
  >;
  close: ivm.Reference<() => void>;
};

export type Ivm2ShellInterface = {
  notifyReady: ivm.Reference<() => boolean>;
  postMessage: ivm.Reference<
    (x: string | ArrayBuffer, unreliable: boolean) => boolean
  >;
  sync: ivm.Reference<() => void>;
};
