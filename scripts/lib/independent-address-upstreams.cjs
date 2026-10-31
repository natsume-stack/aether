'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
for (const [service, port] of [
    ['play', 3121],
    ['creator', 3127],
    ['voxa', 3123],
    ['player-service', 3124],
    ['player-auth-portal', 3125],
]) {
    const server = http.createServer((request, response) => {
        response.setHeader('content-type', 'application/json');
        response.end(
            JSON.stringify({
                service,
                path: request.url,
                host: request.headers.host,
                protocol: request.headers['x-forwarded-proto'],
            }),
        );
    });
    server.on('upgrade', (request, socket) => {
        const accept = crypto
            .createHash('sha1')
            .update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
            .digest('base64');
        socket.write(
            `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
        );
        setTimeout(() => socket.end(), 250);
    });
    server.listen(port, '127.0.0.1');
}
