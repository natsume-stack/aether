import fs from 'fs';
import path from 'path';
import pino from 'pino';
import { MuServer } from '@box/mudb';
import { MuChildProcessSocketServer } from '@box/mudb/socket/child_process/server';
import { IsolateVmController } from './ivmp-vm-controller';
import { RemoteScriptProtocol } from './protocol';
import { parseIvmError } from '../ivm2/parse-error';
import { ParsedErrorSchema } from '../../../script/parse-error';

const logger = pino({
  base: {
    pid: 'script-' + process.pid,
    hostname: process.env.HOST_UUID,
  },
  level: process.env.LOG_LEVEL || 'info',
  transport:
    process.env.NODE_ENV == 'development'
      ? {
          target: 'pino-pretty',
          options: {
            singleLine: true, // for loki to show
            ignore: null, // show hostname
          },
        }
      : undefined,
});

// 初始化VM控制器
const ivm2Script = fs.readFileSync(
  path.resolve(__dirname, '../../../assets/isolate/ivm2-script-entry.js'),
  { encoding: 'utf8' },
);

const controller = new IsolateVmController(
  ivm2Script,
  Number(process.env.SCRIPT_TIMEOUT) || 5000,
  Number(process.env.SCRIPT_MEMORY_LIMIT) || 1024,
  logger,
);

// 初始化进程间通信
const socket = new MuChildProcessSocketServer();
const server = new MuServer(socket, undefined, true);

// TODO 考虑让controller依赖server
const protocol = server.protocol(RemoteScriptProtocol);
protocol.configure({
  message: {
    launch(client, sessionId) {
      logger.info('Script process start launching...');
      controller.run(sessionId).then(() => {
        client.message.vmReady();
        logger.info('Instance of isolated-vm is ready.');
      });
    },
    close() {
      controller.stop();
    },
  },
  raw(client, data, unreliable) {
    controller.send(data, unreliable);
  },
});

// 将VM控制器对应的事件绑定对应的通信消息
controller.events.message.sub(([data, unreliable]) => {
  protocol.broadcastRaw(data, unreliable);
});
controller.events.error.sub((e) => {
  const parsed = parseIvmError(e);
  protocol.broadcast.vmError(parsed);
  ParsedErrorSchema.free(parsed);
});

controller.events.crash.sub((e) => {
  protocol.broadcast.vmCrash();
});

server.start({
  ready() {
    logger.info('Child process socket server is ready.');
  },
  close() {
    logger.info('Child process socket server is closed.');
  },
});
