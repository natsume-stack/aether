import { MuScheduler } from '@box/mudb/scheduler';
import { MuLocalSocketServer, createLocalSocket } from '@box/mudb/socket/local';

export class LocalScriptSocketServer extends MuLocalSocketServer {
  constructor(scheduler: MuScheduler) {
    super(scheduler);
  }

  public async launch(id: any, _module: any) {
    // The local-engine MVP starts with an empty default project. There is no
    // server-side script module to attach in that case, so keep the script
    // channel stopped instead of trying to call the empty launch argument.
    if (typeof _module !== 'function') {
      return;
    }

    const socket = createLocalSocket({
      sessionId: (Math.random() * 1e10).toString(32),
      server: this,
      scheduler: this.scheduler,
    });

    _module(socket, true);
  }
}
