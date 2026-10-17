const fs = require('fs');
const glob = require('glob');

function stripExportImport(text) {
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

glob(process.argv[2], (err, files) => {
  for (const name of files) {
    const str = fs.readFileSync(name).toString();
    const convertedStr = stripExportImport(str);
    fs.writeFileSync(name, convertedStr);
  }
});
