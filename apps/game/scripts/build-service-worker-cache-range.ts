import fs from 'fs'
import path from 'path'
import ts from 'typescript'

const sourcePath = path.resolve(__dirname, '../src/service-worker/cache-range.ts')
const outputPath = path.resolve(__dirname, '../public/box-resource-cache-range.js')
const source = fs.readFileSync(sourcePath, 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
  },
}).outputText

fs.writeFileSync(outputPath, [
  '"use strict";',
  'self.__BOX3_CACHE_RANGE__ = (() => {',
  'const exports = {};',
  compiled,
  'return exports;',
  '})();',
  '',
].join('\n'))
