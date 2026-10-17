import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runSmoke } from './smoke-runner.mts';

const name = process.argv[2];
if (name !== 'desktop' && name !== 'cache' && name !== 'menu') {
    throw new Error('Usage: run-smoke.mts desktop | cache | menu');
}
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const file =
    name === 'desktop'
        ? 'launcher-smoke.cjs'
        : name === 'menu'
          ? 'menu-smoke.cjs'
          : 'cache-smoke.cjs';
await runSmoke({
    executable: require('electron') as string,
    args: [path.join(appRoot, 'dist-electron', file)],
    cwd: appRoot,
    name,
});
console.log(`${name} smoke process exited successfully`);
