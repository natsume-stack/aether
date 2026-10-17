'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const prettier = require(
    require.resolve('prettier', { paths: [path.join(__dirname, '../tools/repo-tooling')] }),
);
const plugin = require('./lib/client-format-plugin.cjs');
const ownedCode = require('./lib/owned-code-config.cjs');
const configuration = require('../.prettierrc.cjs');

test('editor and formatter resolve the same owned source and documentation indentation', async () => {
    assert.deepEqual(configuration.overrides[0].files, ownedCode.patterns);
    assert.deepEqual(configuration.overrides[0].options, ownedCode.options);
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'box-editor-style-'));
    try {
        const config = path.join(temporary, 'empty.json');
        fs.writeFileSync(config, '{}');
        const samples = [
            ...ownedCode.directories.map((directory) => `${directory}/format-example.ts`),
            ...ownedCode.documentationDirectories.map((directory) => `${directory}/README.md`),
            ...ownedCode.configurationFiles,
            ...ownedCode.documentationFiles,
        ];
        for (const file of samples) {
            const absolute = path.join(__dirname, '..', file);
            const resolved = await prettier.resolveConfig(absolute);
            const editor = await prettier.resolveConfig(absolute, { config, editorconfig: true });
            assert.equal(resolved.tabWidth, 4, file);
            assert.equal(editor.tabWidth, resolved.tabWidth, file);
            assert.equal(resolved.semi, true, file);
            assert.equal(resolved.singleQuote, true, file);
            assert.equal(resolved.trailingComma, 'all', file);
        }
    } finally {
        fs.rmSync(temporary, { recursive: true, force: true });
    }
});

test('client formatting adds control blocks and compact type annotations without altering literals', async () => {
    const source = `const label: string = 'if (value) return';\nfunction read(value: boolean): string { if (value) return label; else return ''; }`;
    const options = {
        parser: 'typescript',
        plugins: [plugin],
        tabWidth: 4,
        semi: true,
        singleQuote: true,
    };
    const formatted = await prettier.format(source, options);
    assert.match(formatted, /const label:string/);
    assert.match(formatted, /value:boolean\):string/);
    assert.match(formatted, /if \(value\) \{\n {8}return label;/);
    assert.match(formatted, /'if \(value\) return'/);
    assert.equal(await prettier.format(formatted, options), formatted);
});

test('imports are grouped and TypeScript class visibility is explicit', async () => {
    const source =
        "import {own} from './own'; import {external} from 'external'; import type {Data} from './types'; class Example { value:number = 1; run():void {own(external)} }";
    const options = {
        parser: 'typescript',
        plugins: [plugin],
        tabWidth: 4,
        semi: true,
        singleQuote: true,
    };
    const formatted = await prettier.format(source, options);
    assert.ok(formatted.indexOf("from 'external'") < formatted.indexOf("from './own'"));
    assert.match(formatted, /public value:number/);
    assert.match(formatted, /public run\(\):void/);
    assert.equal(await prettier.format(formatted, options), formatted);
});

test('nested branches and loop blocks preserve execution and literal content', async () => {
    const source = `
        let result = '';
        for (const value of [1, 2, 3]) if (value > 1) if (value === 2) result += 'two'; else result += 'three';
        for (const key in { a: 1 }) result += key;
        let remaining = 2;
        while (remaining > 0) remaining--;
        do remaining++; while (remaining < 1);
        const label = 'else if (x) return';
        result + remaining + label;
    `;
    const options = { parser: 'babel', plugins: [plugin], tabWidth: 4, singleQuote: true };
    const formatted = await prettier.format(source, options);
    assert.equal(vm.runInNewContext(formatted), vm.runInNewContext(source));
    assert.equal(await prettier.format(formatted, options), formatted);
});

test('side-effect imports and native private members keep their semantics', async () => {
    const source = `
        import { own } from './own';
        import './register';
        import { external } from 'external';
        class Example {
            #value:number = 1;
            private run():number { return this.#value; }
        }
    `;
    const options = { parser: 'typescript', plugins: [plugin], tabWidth: 4, singleQuote: true };
    const formatted = await prettier.format(source, options);
    assert.ok(formatted.indexOf("from './own'") < formatted.indexOf("import './register'"));
    assert.ok(formatted.indexOf("import './register'") < formatted.indexOf("from 'external'"));
    assert.match(formatted, /#value:number/);
    assert.doesNotMatch(formatted, /public #value/);
    assert.match(formatted, /private run\(\):number/);
    assert.equal(await prettier.format(formatted, options), formatted);
});
