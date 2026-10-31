import { Logger } from '@box/utils/logger';
import { filterSink } from './utils/filter-sink';
import { consoleSink } from '@box/utils/console-sink';
import { prettySink } from './utils/pretty-log-sink';
import { getServerConfig } from '../configs/server';

let _sharedLogger: Logger;

export async function getSharedLogger() {
  const ServerConfig = await getServerConfig();

  if (!_sharedLogger) {
    _sharedLogger = new Logger(
      filterSink(
        ServerConfig.APP_ENV === 'development' ? consoleSink : prettySink,
        ServerConfig.LOG_LEVEL,
        ServerConfig.logPrefixRegex,
      ),
      ['server'],
      'server:' + Math.floor(Math.random() * 1e8).toString(16),
    );
  }

  return _sharedLogger;
}
