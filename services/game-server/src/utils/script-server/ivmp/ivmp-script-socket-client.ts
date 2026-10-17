import { MuClient } from '@box/mudb';
import { MuClientProtocol } from '@box/mudb/client';
import {
  MuData,
  MuSessionId,
  MuSocket,
  MuSocketSpec,
  MuSocketState,
} from '@box/mudb/socket/socket';
import type { ParsedError } from '@box/schema/debugger-console/schema';
import { EventBus } from '@box/utils/event';

import { RemoteScriptProtocol } from './protocol';
import type { Logger } from 'pino';

/**
 * Socket Client 都是一次性的，关闭后就没有用了，开个新的吧
 * 代表的是 ScriptHost 控制 ScriptServer 的接口
 */
export class IvmpScriptSocketClient implements MuSocket {
  private _state = MuSocketState.INIT;
  public state() {
    return this._state;
  }

  /**
   * 从 MuServer 注册过来的回调
   */
  private _spec: MuSocketSpec | undefined;

  /**
   * 用于向外部通知事件
   */
  public readonly events = {
    ready: new EventBus<void>(),
    /**
     * 用于通知外部 SocketClient 已经关闭
     */
    close: new EventBus<void>(),
  };

  /**
   * 接收到来自VM的消息时，如果 SocketClient 还没有 ready 的话就先放在这里
   * 存放在这里的消息会在 open 时以 unreliable 的方式处理
   */
  private _pendingReceivedMessages: MuData[] = [];
  private _pendingSendData: (string | ArrayBuffer)[] = [];
  private _pendingSendUnreliable: boolean[] = [];

  private readonly remoteClient: MuClient;
  private readonly remoteProtocol: MuClientProtocol<
    typeof RemoteScriptProtocol
  >;

  constructor(
    public sessionId: MuSessionId,
    remoteSocket: MuSocket,
    /**
     * 由 SocketServer 传入，用于处理 VM 接收到的脚本中未捕获错误
     * 传进来可以少维护一个 EventBus 实例，毕竟都是一个作用
     */
    private onIsolateException: EventBus<ParsedError>,
    private logger: Logger,
  ) {
    this.remoteClient = new MuClient(remoteSocket, undefined, true);
    this.remoteProtocol = this.remoteClient.protocol(RemoteScriptProtocol);
  }

  /**
   * socket server 完成 connect 时触发，而connect 又是由 launch触发的
   * ScriptSocketServer Launch ->  ScriptSocketServer Connect -> ScriptSocketClient Open -> RemoteClient Start ->
   * VM Controller Run -> VM Ready -> ScriptSocketClient Ready 此时 VM 开始可以接收消息
   * @param spec
   * @returns
   */
  public open(spec: MuSocketSpec) {
    // 已经 Closed 的 Socket 进行 Open 的话就会直接 Ready 再 Close
    this.logger.debug('Socket opening.');
    if (this._state === MuSocketState.CLOSED) {
      process.nextTick(() => {
        spec.ready();
        spec.close();
      });
      this.logger.warn('Socket already closed.');
      return;
    }

    // 已经 Open 过就什么也不会发生
    if (this._state !== MuSocketState.INIT) {
      this.logger.warn('Socket already opened.');
      return;
    }

    this._spec = spec;

    this._state = MuSocketState.OPEN;

    this.remoteProtocol.configure({
      message: {
        vmReady: () => {
          this.logger.debug('`vmReady` received.');
          for (let i = 0; i < this._pendingReceivedMessages.length; ++i) {
            this._spec?.message(this._pendingReceivedMessages[i], false);
          }
          this._pendingReceivedMessages.length = 0;
          this._spec?.ready();
          this.events.ready.notify();
        },
        vmError: (data) => {
          this.onIsolateException.notify(data);
        },

        vmCrash: () => {
          this.logger.info('Receive `vmCrash`, try to close socket client.');
          this.close();
        },
      },
      // 处理所有来自 ScriptShell 直接发往 ScriptHost 的消息
      raw: (bytes, unreliable) => {
        if (this._state === MuSocketState.OPEN) {
          // 转发所有消息到 SocketClient
          this._spec?.message(bytes, unreliable);
        } else {
          // SocketClient 从 Open 到 Ready 之间收到的消息放这里
          this._pendingReceivedMessages.push(bytes);
        }
      },
    });

    this.remoteClient.start({
      ready: () => {
        this.logger.debug('Process socket client is ready.');
        // 连接建立，开始启动 VM，成功后会返回 vmReady
        this.remoteProtocol.server.message.launch(this.sessionId);
      },
      close: (error) => {
        if (!error) {
          // 没有错误时，不做处理
          return;
        }
        // 子进程发生错误，向容器打印错误信息，并关闭自身。
        this.logger.error(
          new Error(error),
          'Script process socket client closed with error.',
        );
        this.close();
      },
    });
  }

  public close() {
    if (this._state === MuSocketState.CLOSED) {
      this.logger.debug(
        'closing socket failed since socket client already closed',
      );
      return;
    }

    // just delete all pending messages
    this._pendingReceivedMessages.length = 0;

    // clear all pending messages
    this._pendingSendData.length = 0;
    this._pendingSendUnreliable.length = 0;

    this._state = MuSocketState.CLOSED;

    // 由于外部 MuServer 并不知道 ProcessClient 的存在
    // 需要通过 ProcessClient 告知 VM 进行关闭
    // 并关闭 ProcessClient 本身
    if (this.remoteClient.running) {
      this.remoteProtocol.server.message.close();
      this.remoteClient.destroy();
    }

    this._spec?.close();
    this.events.close.notify();
    this.logger.debug('socket client closed');
  }

  public send(data: MuData, unreliable?: boolean) {
    if (this._state === MuSocketState.CLOSED) {
      return;
    }
    this.remoteProtocol.server.sendRaw(data, unreliable);
  }

  public reliableBufferedAmount() {
    return 0;
  }

  public unreliableBufferedAmount() {
    return 0;
  }
}
