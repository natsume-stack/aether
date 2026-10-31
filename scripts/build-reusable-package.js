'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

async function build() {
    const root = process.cwd();
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const { build } = require(require.resolve('esbuild', { paths: [root] }));
    const compiler = require.resolve('typescript/bin/tsc', { paths: [root] });
    fs.rmSync(path.join(root, 'dist'), { recursive: true, force: true });
    execFileSync(process.execPath, [compiler, '--project', 'tsconfig.json'], {
        cwd: root,
        stdio: 'inherit',
    });
    const entries = Object.keys(manifest.exports).filter((key) => key !== './package.json');
    for (const format of ['cjs', 'esm']) {
        await build({
            absWorkingDir: root,
            entryPoints: entries.map((key) => `src/${key === '.' ? 'index' : key.slice(2)}.ts`),
            outdir: 'dist',
            outExtension: { '.js': format === 'esm' ? '.mjs' : '.cjs' },
            bundle: true,
            platform: 'neutral',
            target: 'es2022',
            format,
            sourcemap: false,
        });
    }
}
build().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
