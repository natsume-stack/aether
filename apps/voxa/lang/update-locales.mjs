import { readFile, writeFile } from 'fs/promises';

const enPath = new URL('./src/en.json', import.meta.url);
const jsonPath = new URL('./src/zh-Hans.json', import.meta.url);

Promise.all([readFile(enPath), readFile(jsonPath)]).then(([enData, data]) => {
  const en = JSON.parse(enData);
  const msgs = JSON.parse(data);
  const keys = Object.keys(en);
  const nextMessages = Object.fromEntries(
    keys.map((key) => [key, msgs[key] || en[key]]),
  );
  writeFile(jsonPath, `${JSON.stringify(nextMessages, null, 2)}\n`);
});
