import path from 'path';
import { start } from '@box/build-system/build';
import { getServerConfig } from '../configs/server';

const Paths = {
  targetDir: path.join(__dirname, '../src/resource'),
  assetsDir: path.join(__dirname, 'assets'),
  tasksDir: path.join(__dirname, 'resources'),
};

// Fail the build in CI if we have any errors
(async () => {
  try {
    const config = await getServerConfig();
    await start(Paths, {
      contentHostURL: config.CONTENT_SERVER_URL,
      maxIPFSConnections: config.MAX_CONTENT_SERVER_CONNECTIONS,
      // 这个步骤不需要上传下载oss，这里两个url给空即可
      ossCdnURL: '',
      ossUploadURL: '',
      nextUidListUsingGet: () => Promise.resolve(['']),
    });
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
})();

process.on('warning', console.warn);
