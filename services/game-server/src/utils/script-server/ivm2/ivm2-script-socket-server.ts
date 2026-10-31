import ivm from 'isolated-vm';
import { ScriptServer } from '../type';
import {
  MuSocket,
  MuSocketServerSpec,
  MuSocketServerState,
  MuSocketState,
  MuSocketSpec,
  MuData,
  MuConnectionHandler,
  MuCloseHandler,
  MuMessageHandler,
  MuReadyHandler,
} from '@box/mudb/socket/socket';
import { Ivm2HostInterface, Ivm2ShellInterface } from './ivm2-script-interface';
import { Semaphore } from '@box/utils/semaphore';
import { EventBus } from '@box/utils/event';
import { parseIvmError } from './parse-error';
import { BOILERPLATE_FILENAME, ParsedError } from '../../../script/parse-error';
import crypto from 'crypto';

export class Ivm2ScriptSocket implements MuSocket {
  private _state = MuSocketState.INIT;

  private _onReady: MuReadyHandler = () => {};
  private _onMessage: MuMessageHandler = () => {};
  private _onClose: MuCloseHandler = () => {};

  public shellInterface: Ivm2ShellInterface | null = null;
  public hostInterface: Ivm2HostInterface;

  public state() {
    return this._state;
  }

  private _pendingRecvData: MuData[] = [];

  private _readyCondVar = new Semaphore(0);

  constructor(
    public onIsolateException: EventBus<ParsedError>,
    public scriptTimeout: number,
    public sessionId: string,
    public isolate: ivm.Isolate,
    public context: ivm.Context,
    public script: ivm.Script,
  ) {
    this.hostInterface = {
      sessionId: this.sessionId,
      close: new ivm.Reference(() => process.nextTick(() => this.close())),
      ivm,
      postMessage: new ivm.Reference(
        (x: string | ArrayBuffer, unreliable: boolean) => {
          if (
            this._state === MuSocketState.INIT ||
            this._pendingRecvData.length > 0
          ) {
            if (!unreliable) {
              if (typeof x === 'string') {
                this._pendingRecvData.push(x);
              } else {
                this._pendingRecvData.push(new Uint8Array(x));
              }
            }
          } else if (this._state === MuSocketState.OPEN) {
            if (typeof x === 'string') {
              this._onMessage(x, unreliable);
            } else {
              this._onMessage(new Uint8Array(x), unreliable);
            }
          }
        },
      ),
      notifyReady: new ivm.Reference(() => {
        this._readyCondVar.v();
      }),
    };
  }

  private _notifyError(_err: any) {
    const err = parseIvmError(_err instanceof Error ? _err : new Error(_err));
    const timedOut =
      err.message && err.message.indexOf('Script execution timed out') >= 0;
    if (!timedOut && !this.isolate.isDisposed && this.shellInterface) {
      // synchronize with script on error messages, ensures causality though delivery may be delayed
      this.shellInterface.sync
        .apply(void 0, [], { timeout: this.scriptTimeout })
        .then(() => {
          this.onIsolateException.notify(err);
        })
        .catch(() => {
          this.onIsolateException.notify(err);
        });
    } else {
      // notify isolate exception
      this.onIsolateException.notify(err);

      // close socket
      this.close();
    }
  }

  private _notifyScriptTimeout() {
    process.nextTick(() => {
      this.onIsolateException.notify(
        parseIvmError(new Error('Script timeout')),
      );
      this.close();
    });
  }

  private async _openAsync() {
    await this._readyCondVar.p();

    // kill socket if closed already
    if (this._state !== MuSocketState.INIT) {
      return;
    }

    // enter open state
    this._state = MuSocketState.OPEN;

    // set open flag
    this._onReady();

    // drain message queue
    for (let i = 0; i < this._pendingRecvData.length; ++i) {
      this._onMessage(this._pendingRecvData[i], false);
    }
    this._pendingRecvData.length = 0;

    // notify script start
    if (this.shellInterface) {
      try {
        if (
          !(await this.shellInterface.notifyReady.apply(void 0, [], {
            timeout: this.scriptTimeout + 10000,
          }))
        ) {
          this._notifyScriptTimeout();
        }
      } catch (err) {
        this._notifyError(err);
      }
      // can now send messages
      this._sendSemaphore.v();
    }
  }

  public open(spec: MuSocketSpec) {
    if (this._state === MuSocketState.CLOSED) {
      process.nextTick(() => {
        spec.ready();
        spec.close();
      });
      return;
    }
    if (this._state !== MuSocketState.INIT) {
      return;
    }

    this._onReady = spec.ready;
    this._onMessage = spec.message;
    this._onClose = spec.close;
    this._openAsync().catch((err) => console.error(err));
  }

  private _pendingSendData: ivm.ExternalCopy<string | ArrayBuffer>[] = [];
  private _pendingSendUnreliable: boolean[] = [];
  private _sendSemaphore = new Semaphore(0);

  private async _sendDrain() {
    await this._sendSemaphore.p();
    try {
      while (
        this._state === MuSocketState.OPEN &&
        this._pendingSendData.length > 0 &&
        this.shellInterface
      ) {
        const data = this._pendingSendData.shift();
        const unreliable = this._pendingSendUnreliable.shift();
        if (data) {
          try {
            if (
              !(await this.shellInterface.postMessage.apply(
                undefined,
                [
                  data.copyInto({
                    transferIn: true,
                    release: true,
                  }),
                  !!unreliable,
                ],
                {
                  timeout: this.scriptTimeout,
                },
              ))
            ) {
              this._notifyScriptTimeout();
            }
          } catch (e) {
            this._notifyError(e);
          }
        }
      }
    } finally {
      this._sendSemaphore.v();
    }
  }

  private _sendOk = (v) => {
    if (!v) {
      this._notifyScriptTimeout();
    }
    this._sendSemaphore.v();
  };

  private _sendErr = (err) => {
    this._notifyError(err);
    this._sendSemaphore.v();
  };

  public send(data: MuData, unreliable?: boolean) {
    if (this._state === MuSocketState.CLOSED) {
      return;
    }
    if (this._sendSemaphore.spinP()) {
      if (this.shellInterface) {
        if (typeof data === 'string') {
          this.shellInterface.postMessage
            .apply(void 0, [data, !!unreliable], {
              timeout: this.scriptTimeout,
            })
            .then(this._sendOk)
            .catch(this._sendErr);
        } else {
          const buffer = new Uint8Array(data);
          const copy = new ivm.ExternalCopy(buffer.buffer, {
            transferList: [buffer.buffer],
            transferOut: true,
          });
          this.shellInterface.postMessage
            .apply(
              void 0,
              [
                copy.copyInto({
                  transferIn: true,
                  release: true,
                }),
                !!unreliable,
              ],
              {
                timeout: this.scriptTimeout,
              },
            )
            .then(this._sendOk)
            .catch(this._sendErr);
        }
      }
    } else {
      if (typeof data === 'string') {
        this._pendingSendData.push(new ivm.ExternalCopy(data));
      } else {
        const buffer = new Uint8Array(data);
        this._pendingSendData.push(
          new ivm.ExternalCopy(buffer.buffer, {
            transferList: [buffer.buffer],
            transferOut: true,
          }),
        );
      }
      this._pendingSendUnreliable.push(!!unreliable);
      this._sendDrain().catch((err) => {
        this._notifyError(err);
      });
    }
  }

  public close() {
    if (this._state === MuSocketState.CLOSED) {
      return;
    }
    this._state = MuSocketState.CLOSED;

    // just delete all pending recvs
    this._pendingRecvData.length = 0;

    // clean up host interface
    try {
      this.hostInterface.notifyReady.release();
    } catch (e) {
      console.error(e);
    }
    try {
      this.hostInterface.close.release();
    } catch (e) {
      console.error(e);
    }
    try {
      this.hostInterface.postMessage.release();
    } catch (e) {
      console.error(e);
    }

    // clean up shell interface
    if (this.shellInterface) {
      try {
        this.shellInterface.notifyReady.release();
      } catch (e) {
        console.error(e);
      }
      try {
        this.shellInterface.postMessage.release();
      } catch (e) {
        console.error(e);
      }
    }

    // clean up other refs
    try {
      this.script.release();
    } catch (e) {
      console.error(e);
    }
    try {
      this.context.release();
    } catch (e) {
      console.error(e);
    }
    try {
      this.isolate.dispose();
    } catch (e) {
      console.error(e);
    }

    // clear all pending messages
    for (let i = 0; i < this._pendingSendData.length; ++i) {
      try {
        this._pendingSendData[i].release();
      } catch (e) {
        console.error(e);
      }
    }
    this._pendingSendData.length = 0;
    this._pendingSendUnreliable.length = 0;

    // notify done
    process.nextTick(this._onClose);
  }

  public setShellInterface(props: Ivm2ShellInterface) {
    this.shellInterface = props;
  }

  public reliableBufferedAmount() {
    return 0;
  }

  public unreliableBufferedAmount() {
    return 0;
  }
}

export class Ivm2ScriptServer implements ScriptServer {
  private _cachedData: ivm.ExternalCopy<ArrayBuffer> | undefined;

  private _onConnection: MuConnectionHandler = () => {};
  private _onClose = () => {};

  private _state = MuSocketServerState.INIT;
  public state() {
    return this._state;
  }

  private _sessionIdCounter = 0;
  public clients: Ivm2ScriptSocket[] = [];

  public onIsolateException = new EventBus<ParsedError>();

  constructor(
    public entryScript: string,
    public scriptHeapLimit,
    public scriptTimeout,
  ) {}

  public start(spec: MuSocketServerSpec) {
    if (this._state !== MuSocketServerState.INIT) {
      return;
    }

    this._onClose = spec.close;
    this._onConnection = spec.connection;
    this._state = MuSocketServerState.RUNNING;
    process.nextTick(spec.ready);
  }

  public close() {
    if (this._state !== MuSocketServerState.RUNNING) {
      return;
    }

    this._state = MuSocketServerState.SHUTDOWN;
    this.clients.forEach((c) => c.close());
    this._onClose();
  }

  public async launch() {
    if (this._state !== MuSocketServerState.RUNNING) {
      return;
    }

    const sessionId = `script:${this._sessionIdCounter++}`;

    // set up ivm stuff
    const isolate = new ivm.Isolate({
      memoryLimit: this.scriptHeapLimit,
    });
    try {
      const context = isolate.createContextSync();
      try {
        const script = isolate.compileScriptSync(this.entryScript, {
          produceCachedData: true,
          cachedData: this._cachedData,
          filename: BOILERPLATE_FILENAME,
        });
        if ((<any>script).cachedData) {
          this._cachedData = (<any>script).cachedData;
        }
        try {
          const socket = new Ivm2ScriptSocket(
            this.onIsolateException,
            this.scriptTimeout,
            sessionId,
            isolate,
            context,
            script,
          );
          try {
            // inject global
            const jail = context.global;
            jail.setSync('global', jail.derefInto());
            // nanoid 需要这个模块
            jail.setSync('crypto', new ivm.Reference(crypto));
            jail.setSync('log', () => {});
            jail.setSync(
              'secret',
              new ivm.ExternalCopy(socket.hostInterface).copyInto({
                release: true,
              }),
            );

            // set shell interface
            const shellInterface = script.runSync(context);
            socket.setShellInterface(shellInterface);

            // save socket
            this.clients.push(socket);

            // notify connection
            this._onConnection(socket);
          } catch (e) {
            socket.close();
            throw e;
          }
        } catch (e) {
          try {
            script.release();
          } catch (e) {
            console.error(e);
          }
          throw e;
        }
      } catch (e) {
        try {
          context.release();
        } catch (e) {
          console.error(e);
        }
        throw e;
      }
    } catch (e) {
      if (!isolate.isDisposed) {
        try {
          isolate.dispose();
        } catch (e) {
          console.error(e);
        }
      }
      throw e;
    }
  }
}
