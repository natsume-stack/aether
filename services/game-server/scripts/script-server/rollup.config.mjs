/**
 * 构建：Script Server 内部 Shell 用来初始化的脚本
 */

import typescript from '@rollup/plugin-typescript';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import swc from '@rollup/plugin-swc';
import json from '@rollup/plugin-json';

export default {
  input: ['./src/utils/script-server/ivm2/ivm2-script-entry.ts'],
  external: ['debug'], // isolate 中缺少 node 相关的 tty 和 util 模块，需要换成 log 往 server 上输出
  output: [
    // 给开发时使用
    {
      dir: 'src/assets/isolate',
      indent: false,
      format: 'iife',
      globals: {
        debug: "() => (...args) => {globalThis.log('debug', ...args)}",
      },
    },
    // 实际部署后使用，因为开发时是直接 resolve 的文件，所以不会跟着代码一起构建出来，需要在这里单独构建
    {
      dir: 'dist/src/assets/isolate',
      indent: false,
      format: 'iife',
      globals: {
        debug: "() => (...args) => {globalThis.log('debug', ...args)}",
      },
    },
  ],
  plugins: [
    json(),
    // 解析所有引入的模块

    // 仅处理 TS 以及引入的 TS 模块为 ES Module
    typescript({
      tsconfig: './scripts/script-server/tsconfig.json',
      noEmit: true,
    }),
    // 统一根据所有 ES Module 的 Target 进行处理
    swc({
      swc: {
        module: {
          type: 'es6',
        },
      },
    }),
    nodeResolve({
      preferBuiltins: true,
      exportConditions: ['node'],
    }),
    // 仅处理外部引入的 CommonJS 模块，转为 ES Module
    commonjs({
      extensions: ['.js', '.ts'],
    }),
  ],
};
