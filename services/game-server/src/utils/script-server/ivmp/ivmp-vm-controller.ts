import type { MuData, MuMessageHandler } from '@box/mudb/socket/socket';
import { EventBus } from '@box/utils/event';
import { Semaphore } from '@box/utils/semaphore';
import crypto from 'crypto';
import ivm from 'isolated-vm';
import type { Level, Logger } from 'pino';
import v8 from 'v8';
import { BOILERPLATE_FILENAME } from '../../../script/parse-error';
import type { ScriptShellSysLog } from '../../../script/script-shell';
import type {
  Ivm2HostInterface,
  Ivm2ShellInterface,
} from '../ivm2/ivm2-script-interface';

/**
 * IVM的控制器，里面封装了VM管理与消息中转用的指令
 * 运行在 ChildProcess 中
 */
export class IsolateVmController {
  private _isolate: ivm.Isolate | undefined;
  private _context: ivm.Context | undefined;
  private _script: ivm.Script | undefined;
  private _isRunning: boolean = false;
  private _cachedData: ivm.ExternalCopy<ArrayBuffer> | undefined;
  private _readySemaphore = new Semaphore(0);
  private _sendSemaphore = new Semaphore(0);
  private _pendingSendData: ivm.ExternalCopy<string | ArrayBuffer>[] = [];
  private _pendingSendUnreliable: boolean[] = [];
  private _shellInterface: Ivm2ShellInterface | undefined = undefined;
  private _hostInterface: Ivm2HostInterface | undefined;
  public readonly events = {
    /**
     * 用于将VM在异步执行代码时的错误向外传给用户控制台
     * 由于 https://github.com/laverdet/isolated-vm/issues/350 的缘故，暂时无法在 VM 里直接通过try catch进行捕获
     */
    error: new EventBus<Error>(),
    /**
     * 处理 VM 中的 ScriptShell 发往 ScriptHost 的消息
     */
    message: new EventBus<Parameters<MuMessageHandler>>(),
    /**
     * 处理 VM 崩溃停止的情况
     */
    crash: new EventBus<void>(),
  };

  constructor(
    private _entryScript: string,
    private _scriptTimeout: number,
    private _memoryLimitMb: number,
    private _logger: Logger,
  ) {}

  public async run(sessionId: string) {
    if (this._isRunning) {
      this._logger.error('Run failed: vm is already running!');
      return;
    }

    this._hostInterface = this.createHostInterface(sessionId);

    // set up ivm stuff
    this._logger.debug('Memory limit of isolate-vm: %dMB', this._memoryLimitMb);
    const isolate = new ivm.Isolate({
      memoryLimit: this._memoryLimitMb,
      onCatastrophicError: (message) => {
        const err = new Error(message);
        this._logger.error(err, 'Catastrophic error in isolate.');
        // 有可能是用户异步操作的问题
        this.events.error.notify(err);
        this.events.crash.notify();
        this.stop();
      },
      inspector: false,
    });
    this._isolate = isolate;
    try {
      const context = isolate.createContextSync({
        inspector: false,
      });
      this._context = context;
      try {
        const script = isolate.compileScriptSync(this._entryScript, {
          produceCachedData: true,
          cachedData: this._cachedData,
          filename: BOILERPLATE_FILENAME,
        });
        this._script = script;
        if ((<any>script).cachedData) {
          this._cachedData = (<any>script).cachedData;
        }

        const isolateLogger = this._logger.child({
          caller: 'isolate-' + sessionId,
        });

        const logFn: ScriptShellSysLog = (
          level: Level,
          object: any,
          message: any,
          ...args
        ) => {
          isolateLogger[level](object, message, ...args);
        };
        try {
          // inject global
          const jail = context.global;
          jail.setSync('global', jail.derefInto());
          // nanoid 需要这个模块
          jail.setSync('crypto', new ivm.Reference(crypto));
          jail.setSync('log', logFn);
          jail.setSync(
            'secret',
            new ivm.ExternalCopy(this._hostInterface).copyInto({
              release: true,
            }),
          );

          if (process.env.NODE_ENV === 'development') {
            // 用于本地测试 ivm 的库，提供 ivm.lib 上的 testOOM 和 testHang 方法
            // https://github.com/laverdet/isolated-vm/blob/3f13ecac00eaac57224222fef692a55aa10bf960/src/module/lib_handle.cc#L69
            // 虽然 host interface 里面有 ivm，但不适合在vm环境中加环境变量做判断，所以这里直接注入
            jail.setSync('ivm', ivm);
          }

          // set shell interface
          this._logger.info('Start running script.');
          const shellInterface = script.runSync(context);
          this._shellInterface = shellInterface;
        } catch (e) {
          this.events.crash.notify();
          try {
            script.release();
          } catch (e) {
            this._logger.error(e);
          }
          throw e;
        }
      } catch (e) {
        try {
          context.release();
        } catch (e) {
          this._logger.error(e);
        }
        throw e;
      }
    } catch (e) {
      if (!isolate.isDisposed) {
        try {
          isolate.dispose();
        } catch (e) {
          this._logger.error(e);
        }
      }
      throw e;
    }

    this._isRunning = true;

    // 确保 Shell 已经准备好接收消息，以防 Shell 进行异步的初始化
    // 由于目前 shell 会在 constructor 里执行 MuClient.start，
    // 而 MuClient.start 会同步执行 socket.open，里面就有 host.notifyReady，所以这里理论上不会被拦住。
    // 但保险起见，暂时保留原有的逻辑以防万一
    await this._readySemaphore.p();
    try {
      if (
        // 通知 Shell 说 Host 已经准备好接收消息了
        !(await this._shellInterface!.notifyReady.apply(void 0, [], {
          timeout: this._scriptTimeout + 10000,
        }))
      ) {
        const err = new Error('`notifyReady` script timeout.');
        this._notifyScriptTimeout(err);
      }
      this._logger.info('`notifyReady()` returned from isolate.');
    } catch (_err) {
      const err =
        _err instanceof Error ? _err : new Error(JSON.stringify(_err));
      this._logger.error(err, 'Error invoking `shell.notifyReady()`.');
      this._notifyError(err);
    }

    // can now send messages
    this._sendSemaphore.v();
  }
  public stop() {
    if (!this._isRunning) {
      return;
    }
    this._isRunning = false;

    // clean up host interface
    if (this._hostInterface) {
      try {
        this._hostInterface.notifyReady.release();
      } catch (e) {
        this._logger.error(e);
      }
      try {
        this._hostInterface.close.release();
      } catch (e) {
        this._logger.error(e);
      }
      try {
        this._hostInterface.postMessage.release();
      } catch (e) {
        this._logger.error(e);
      }
    }

    // clean up shell interface
    if (this._shellInterface) {
      try {
        this._shellInterface.notifyReady.release();
      } catch (e) {
        this._logger.error(e);
      }
      try {
        this._shellInterface.postMessage.release();
      } catch (e) {
        this._logger.error(e);
      }
    }

    // clean up other refs
    try {
      this._script!.release();
    } catch (e) {
      this._logger.error(e);
    }
    try {
      this._context!.release();
    } catch (e) {
      this._logger.error(e);
    }
    try {
      this._isolate!.dispose();
    } catch (e) {
      this._logger.warn(e, 'Error disposing isolate.');
    }
  }

  public send(data: MuData, unreliable?: boolean) {
    if (this._sendSemaphore.spinP()) {
      if (typeof data === 'string') {
        this._shellInterface!.postMessage.apply(void 0, [data, !!unreliable], {
          timeout: this._scriptTimeout,
        })
          .then(this._sendOk)
          .catch((_err) => {
            const err =
              _err instanceof Error ? _err : new Error(JSON.stringify(_err));
            this._logger.error(err, 'Error invoking `shell.postMessage()`.');
            this._sendErr(err);
          });
      } else {
        const buffer = new Uint8Array(data);
        const copy = new ivm.ExternalCopy(buffer.buffer, {
          transferList: [buffer.buffer],
          transferOut: true,
        });
        this._shellInterface!.postMessage.apply(
          void 0,
          [
            copy.copyInto({
              transferIn: true,
              release: true,
            }),
            !!unreliable,
          ],
          {
            timeout: this._scriptTimeout,
          },
        )
          .then(this._sendOk)
          .catch((_err) => {
            const err =
              _err instanceof Error ? _err : new Error(JSON.stringify(_err));
            this._logger.error(err, 'Error invoking `shell.postMessage()`.');
            this._sendErr(err);
          });
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
      this._sendDrain().catch((_err) => {
        const err =
          _err instanceof Error ? _err : new Error(JSON.stringify(_err));
        this._logger.error(err, 'Error sending drain messages.');
        this._notifyError(err);
      });
    }
  }

  private async _sendDrain() {
    await this._sendSemaphore.p();
    try {
      while (this._isRunning && this._pendingSendData.length > 0) {
        const data = this._pendingSendData.shift();
        const unreliable = this._pendingSendUnreliable.shift();
        if (data) {
          try {
            if (
              !(await this._shellInterface!.postMessage.apply(
                undefined,
                [
                  data.copyInto({
                    transferIn: true,
                    release: true,
                  }),
                  !!unreliable,
                ],
                {
                  timeout: this._scriptTimeout,
                },
              ))
            ) {
              const err = new Error(
                '`postMessage` script timeout when sendDrain.',
              );
              this._notifyScriptTimeout(err);
            }
          } catch (_err) {
            const err =
              _err instanceof Error ? _err : new Error(JSON.stringify(_err));
            this._logger.error(err, 'Error sending drain message.');
            this._notifyError(err);
          }
        }
      }
    } finally {
      this._sendSemaphore.v();
    }
  }

  private _sendOk = (v) => {
    if (!v) {
      const err = new Error('`postMessage` script timeout when send.');
      this._notifyScriptTimeout(err);
    }
    this._sendSemaphore.v();
  };

  private _sendErr = (err: Error) => {
    this._notifyError(err);
    this._sendSemaphore.v();
  };

  /**
   * 输出超时日志，并发送给用户控制台
   * @param err
   */
  private _notifyScriptTimeout(err: Error) {
    this._logger.error(err);
    process.nextTick(() => {
      this.events.error.notify(err);
      this.events.crash.notify();
      this.stop();
    });
  }

  /**
   * Log and notify error to user debug console
   * @param err
   */
  private _notifyError(err: Error) {
    // 不是 Error 就当作 string 处理
    const timedOut =
      err.message && err.message.indexOf('Script execution timed out') >= 0;
    if (!timedOut && !this._isolate!.isDisposed && this._shellInterface) {
      // synchronize with script on error messages, ensures causality though delivery may be delayed
      this._shellInterface.sync
        .apply(void 0, [], { timeout: this._scriptTimeout })
        .then(() => {
          this.events.error.notify(err);
        })
        .catch(() => {
          this.events.error.notify(err);
        });
    } else {
      // notify isolate exception
      this.events.error.notify(err);
      this.events.crash.notify();
      // close socket
      this.stop();
    }
  }

  private createHostInterface(sessionId: string): Ivm2HostInterface {
    return {
      sessionId: sessionId,
      close: new ivm.Reference(() => process.nextTick(() => this.stop())),
      ivm,
      postMessage: new ivm.Reference(
        (x: string | ArrayBuffer, unreliable: boolean) => {
          if (typeof x === 'string') {
            this.events.message.notify([x, unreliable]);
          } else {
            this.events.message.notify([new Uint8Array(x), unreliable]);
          }
        },
      ),
      /**
       * 接收 shell ready 的消息，确保我们在 shell ready 后再往里头发消息
       */
      notifyReady: new ivm.Reference(() => {
        this._readySemaphore.v();
      }),
    };
  }
}
