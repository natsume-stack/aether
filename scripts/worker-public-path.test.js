'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const webpack = require(
    require.resolve('webpack', { paths: [path.join(__dirname, '../apps/game')] }),
);
const configure = require(
    require.resolve('@box/deployment-routing/next-webpack', {
        paths: [path.join(__dirname, '../apps/game')],
    }),
);

test('worker chunks use the prefix of the worker script, including nested prefixes', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'box-worker-path-'));
    try {
        await fs.writeFile(path.join(directory, 'entry.js'), 'import("./lazy.js")');
        await fs.writeFile(path.join(directory, 'lazy.js'), 'export default 1');
        const config = configure(
            {
                mode: 'production',
                target: 'webworker',
                entry: path.join(directory, 'entry.js'),
                output: {
                    path: path.join(directory, 'output'),
                    filename: 'worker.js',
                    chunkFilename: 'static/chunks/[id].js',
                    publicPath: '/_next/',
                },
                resolve: { alias: {} },
                plugins: [],
            },
            { isServer: false, webpack, dir: path.join(__dirname, '../apps/game') },
        );
        await new Promise((resolve, reject) => {
            const compiler = webpack(config);
            compiler.run((error, stats) =>
                compiler.close((closeError) => {
                    if (error || closeError || stats.hasErrors()) {
                        reject(error || closeError || new Error(stats.toString()));
                    } else {
                        resolve();
                    }
                }),
            );
        });
        const source = await fs.readFile(path.join(directory, 'output/worker.js'), 'utf8');
        const chunks = new Map();
        for (const file of await fs.readdir(path.join(directory, 'output/static/chunks'))) {
            chunks.set(
                file,
                await fs.readFile(path.join(directory, 'output/static/chunks', file), 'utf8'),
            );
        }
        for (const prefix of ['', '/abc', '/team/play']) {
            const imports = [];
            const location = new URL(`http://engine.test${prefix}/_next/static/chunks/worker.js`);
            const context = vm.createContext({
                self: { location },
                importScripts(url) {
                    imports.push(url);
                    vm.runInContext(chunks.get(path.basename(url)), context);
                },
            });
            vm.runInContext(source, context);
            assert.equal(imports.length, 1);
            assert.ok(imports[0].startsWith(`${prefix}/_next/static/chunks/`), imports[0]);
        }
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
});
