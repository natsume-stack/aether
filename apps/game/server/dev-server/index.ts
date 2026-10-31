/**
 * @file HTTPS Dev Server
 * 使用前需要自行对 certificates 目录下的 crt 进行签名
 */
import http from 'http';
import { parse } from 'url';
import next from 'next';

const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev });
const handle = app.getRequestHandler();
const argv = require('minimist')(process.argv.slice(2));

// help flags
if (argv.help) {
  console.log(`
    --http                  run http server
  `);
  process.exit(0);
}

const isHttps = !argv['http'];
const port = argv['port'] || 3000;
const host = argv['host'] || process.env.BOX_WEB_HOST || '127.0.0.1';

app.prepare().then(() => {
  const requestListener = (req, res) => {
    const parsedUrl = parse(req.url!, true);

    handle(req, res, parsedUrl).catch((err) => {
      console.error(err);
    });
  };

  let server = http.createServer({}, requestListener);
  const upgradeHandler = app.getUpgradeHandler();
  server.on('upgrade', (req, socket, head) => {
    upgradeHandler(req, socket, head);
  });

  server.listen(port, host, (err?: Error) => {
    if (err) {
      throw err;
    }
    console.log(`> Server started on ${host}:${port}`);
  });
});
