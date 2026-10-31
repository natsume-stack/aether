import { spawn } from 'child_process';
import { bundleServerTypes } from './build-server-types';

function run(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`声明生成失败：${code ?? signal}`)));
  });
}

async function generate(tsconfig: string, target: string) {
  await run([require.resolve('typescript/bin/tsc'), '-p', tsconfig, '--declaration', '--emitDeclarationOnly']);
  await run(['scripts/fix-declaration.js', target]);
}

// Await both compilers and propagate failures; otherwise a failed generator
// can leave old declarations behind while the parent build still reports success.
Promise.all([
  generate('api-tsconfig.json', './scripts/assets/api/**/*.d.ts'),
  generate('client-api-tsconfig.json', './scripts/assets/client_api/**/*.d.ts'),
]).then(bundleServerTypes).catch(error => { console.error(error); process.exitCode = 1; });
