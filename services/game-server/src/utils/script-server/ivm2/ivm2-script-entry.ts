import {
  MuData,
  MuMessageHandler,
  MuReadyHandler,
  MuSocket,
  MuSocketSpec,
  MuSocketState,
} from '@box/mudb/socket/socket';
import { Semaphore } from '@box/utils/semaphore';
import type { Level } from 'pino';
import { ScriptShell } from '../../../script/script-shell';
import { Ivm2HostInterface, Ivm2ShellInterface } from './ivm2-script-interface';

const host: Ivm2HostInterface = (<any>global).secret;
delete (<any>global).secret;

const { sessionId, ivm } = host;

const log: (level: Level, object: any, message?: any, ...args) => void =
  globalThis.log;

log('info', 'Script VM started.');

let socketState = MuSocketState.INIT;

const pendingRecvData: MuData[] = [];

const sendSemaphore = new Semaphore(0);
const pendingSendData: MuData[] = [];
const pendingSendUnreliable: boolean[] = [];

let onReady: MuReadyHandler = () => {};
let onMessage: MuMessageHandler = () => {};

async function sendDrain() {
  await sendSemaphore.p();
  try {
    while (socketState === MuSocketState.OPEN && pendingSendData.length > 0) {
      const data = pendingSendData.shift();
      const unreliable = !!pendingSendUnreliable.shift();
      if (typeof data === 'string') {
        await host.postMessage.apply(void 0, [data, !!unreliable], {
          arguments: {
            copy: true,
          },
        });
      } else if (data) {
        await host.postMessage.apply(void 0, [
          new ivm.ExternalCopy(data.buffer, {
            transferList: [data.buffer],
            transferOut: true,
          }).copyInto({
            transferIn: true,
            release: true,
          }),
          !!unreliable,
        ]);
      }
    }
  } finally {
    sendSemaphore.v();
  }
}

// then we construct a socket
const ivm2IsolateSocket: MuSocket = {
  sessionId,

  state: () => socketState,

  open: (spec: MuSocketSpec) => {
    if (socketState !== MuSocketState.INIT) {
      log('warn', 'Script server socket already opened.');
      return;
    }

    // set up handlers
    onReady = spec.ready;
    onMessage = spec.message;

    // close handler not needed, when socket is destroyed so is isolate
    host.notifyReady.applySync();
    log('info', 'Script server socket open finished.');
  },

  send: (data, unreliable) => {
    if (sendSemaphore.spinP()) {
      // fast send
      if (typeof data === 'string') {
        host.postMessage.applyIgnored(void 0, [data, !!unreliable], {
          arguments: {
            copy: true,
          },
        });
      } else {
        const buffer = new Uint8Array(data).buffer;
        const copy = new ivm.ExternalCopy(buffer, {
          transferList: [buffer],
          transferOut: true,
        });
        host.postMessage.applyIgnored(void 0, [
          copy.copyInto({
            transferIn: true,
            release: true,
          }),
          !!unreliable,
        ]);
      }
      sendSemaphore.v();
    } else {
      if (typeof data === 'string') {
        pendingSendData.push(data);
      } else {
        pendingSendData.push(new Uint8Array(data));
      }
      pendingSendUnreliable.push(!!unreliable);
      sendDrain().catch((e) => {
        throw e;
      });
    }
  },

  close: () => {
    if (socketState !== MuSocketState.OPEN) {
      return;
    }

    // fire close event on socket
    socketState = MuSocketState.CLOSED;

    // fire off a close event and die
    host.close.applyIgnored();
  },

  reliableBufferedAmount: () => 0,
  unreliableBufferedAmount: () => 0,
};

// next construct a shell
const shell = new ScriptShell(ivm2IsolateSocket, false, log);

// return the host interface
const result: Ivm2ShellInterface = {
  notifyReady: new ivm.Reference(() => {
    log('info', 'isolate received `notifyReady()`.');
    // set ready flag
    socketState = MuSocketState.OPEN;

    // notify ready
    onReady();

    // notify send semaphore we are ready
    sendSemaphore.v();

    // drain queue
    for (let i = 0; i < pendingRecvData.length; ++i) {
      onMessage(pendingRecvData[i], false);
    }
    pendingRecvData.length = 0;

    // return
    return true;
  }),

  postMessage: new ivm.Reference(
    (x: string | ArrayBuffer, unreliable: boolean) => {
      if (socketState === MuSocketState.INIT || pendingRecvData.length > 0) {
        if (!unreliable) {
          if (typeof x === 'string') {
            pendingRecvData.push(x);
          } else {
            pendingRecvData.push(new Uint8Array(x));
          }
        }
      } else if (socketState === MuSocketState.OPEN) {
        if (typeof x === 'string') {
          onMessage(x, unreliable);
        } else {
          onMessage(new Uint8Array(x), unreliable);
        }
      }
      return true;
    },
  ),

  sync: new ivm.Reference(() => {}),
};

// rollup iife 格式下会被打包成最后的返回值，而也就是 ivm 获取到的返回值
export default new ivm.ExternalCopy(result).copyInto({
  transferIn: true,
  release: true,
});
