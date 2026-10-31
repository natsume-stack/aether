import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
// TODO 加依赖？
// import { rimrafSync } from 'rimraf';

const TEMP_DIR = path.join(__dirname, 'assets/llm_temp');
const OUTPUT_FILE = path.join(
  __dirname,
  '../../../services/game-server/src/edit/ai/llm-context.d.ts',
);

// Ensure temp dir is clean
// if (fs.existsSync(TEMP_DIR)) {
//   rimrafSync(TEMP_DIR);
// }
fs.mkdirSync(TEMP_DIR, { recursive: true });

function runTsc(tsconfig: string, outDir: string) {
  console.log(`Compiling ${tsconfig} to ${outDir}...`);
  const result = spawnSync(
    'tsc',
    [
      '-p',
      tsconfig,
      '--outDir',
      outDir,
      '--declaration',
      '--emitDeclarationOnly',
    ],
    {
      cwd: path.join(__dirname, '..'),
      stdio: 'inherit',
      shell: true,
    },
  );

  if (result.error || result.status !== 0) {
    console.error(`Failed to compile ${tsconfig}`);
    process.exit(1);
  }
}

// 1. Compile directly to temp directory
runTsc('tsconfig.llm-api.json', path.join(TEMP_DIR, 'api'));
// runTsc('client-api-tsconfig.json', path.join(TEMP_DIR, 'client_api'));

function stripExportImport(text: string) {
  return text
    .split('\n')
    .map((line) => {
      if (/^import /.test(line)) {
        return '';
      }
      return line.replace(/^export /, '').replace(/import\(["'].+["']\)\./, '');
    })
    .join('\n');
}

function getAllFiles(dirPath: string, arrayOfFiles: string[] = []) {
  if (!fs.existsSync(dirPath)) {
    return arrayOfFiles;
  }

  const files = fs.readdirSync(dirPath);

  files.forEach(function (file) {
    const fullPath = path.join(dirPath, file);
    if (fs.statSync(fullPath).isDirectory()) {
      arrayOfFiles = getAllFiles(fullPath, arrayOfFiles);
    } else {
      if (file.endsWith('.d.ts')) {
        arrayOfFiles.push(fullPath);
      }
    }
  });

  return arrayOfFiles;
}

function concatFiles(outputFile: string) {
  let content = '';
  const files = getAllFiles(TEMP_DIR);

  // Sort files to ensure deterministic output
  files.sort();

  files.forEach((file) => {
    console.log(`  Processing ${path.relative(TEMP_DIR, file)}`);
    content += `// File: ${path.relative(TEMP_DIR, file)}\n`;
    const fileContent = fs.readFileSync(file, 'utf8');
    // Apply the strip logic here
    content += stripExportImport(fileContent);
    content += '\n\n';
  });

  fs.writeFileSync(outputFile, content);
  console.log(`\nSuccessfully generated ${outputFile}`);
}

// 2. Process and concat
concatFiles(OUTPUT_FILE);

// 3. Cleanup
fs.rmSync(TEMP_DIR, { recursive: true, force: true });
