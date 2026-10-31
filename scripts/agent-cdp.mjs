// Minimal Chrome DevTools Protocol client, Node standard library only.
//
// The verification harness for the live agent needs a real browser: "the AI
// moved the camera" is only true if a rendered frame shows it. Playwright is
// not installable in this environment (npm registry proxy is dead), and the
// host already runs Edge with CDP on 9222, so a ~200 line client is the
// cheapest honest option.
//
// Node 22+ ships a global WebSocket, which is all CDP needs.

let nextId = 1;

export class CdpSession {
  constructor(socket) {
    this.socket = socket;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;
    socket.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
      } catch {
        return;
      }
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(`${message.error.message} (${message.error.code})`));
        else resolve(message.result);
        return;
      }
      if (message.method) {
        for (const listener of this.listeners.get(message.method) || []) {
          listener(message.params);
        }
      }
    });
    socket.addEventListener('close', () => {
      this.closed = true;
      for (const { reject } of this.pending.values()) {
        reject(new Error('CDP socket closed'));
      }
      this.pending.clear();
    });
  }

  send(method, params = {}, timeoutMs = 30_000) {
    if (this.closed) return Promise.reject(new Error('CDP socket closed'));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, listener) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(listener);
    return () => this.listeners.get(method)?.delete(listener);
  }

  waitFor(method, timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`timed out waiting for ${method}`));
      }, timeoutMs);
      const off = this.on(method, (params) => {
        clearTimeout(timer);
        off();
        resolve(params);
      });
    });
  }

  async evaluate(expression, { awaitPromise = true, timeoutMs = 30_000 } = {}) {
    const result = await this.send(
      'Runtime.evaluate',
      {
        expression,
        awaitPromise,
        returnByValue: true,
        userGesture: true,
      },
      timeoutMs,
    );
    if (result.exceptionDetails) {
      const description =
        result.exceptionDetails.exception?.description ||
        result.exceptionDetails.text ||
        'evaluation failed';
      throw new Error(description);
    }
    return result.result?.value;
  }

  async screenshot(filePath, { format = 'png', quality } = {}) {
    // A background/occluded tab produces no frames and captureScreenshot then
    // waits forever. Activate the target and force a frame first.
    try {
      if (this.target?.id) {
        await this.send('Target.activateTarget', { targetId: this.target.id }, 5_000).catch(() => undefined);
      }
      await this.send('Page.bringToFront', {}, 5_000).catch(() => undefined);
    } catch {
      // best effort only
    }
    const params = { format, captureBeyondViewport: false };
    if (format === 'jpeg' && quality) params.quality = quality;
    const { data } = await this.send('Page.captureScreenshot', params, 60_000);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(filePath, Buffer.from(data, 'base64'));
    return filePath;
  }

  close() {
    try {
      this.socket.close();
    } catch {
      // already gone
    }
  }
}

async function fetchJson(url, timeoutMs = 5_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function listTargets(port = 9222) {
  return fetchJson(`http://127.0.0.1:${port}/json/list`);
}

/**
 * Attach to a page target. When `match` is a string it is matched against the
 * URL; when it is a RegExp it must match. Without a match the first `page`
 * target is used.
 */
export async function attach({ port = 9222, match, timeoutMs = 15_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let targets = [];
  while (Date.now() < deadline) {
    targets = await listTargets(port).catch(() => []);
    const pages = targets.filter((target) => target.type === 'page');
    const found = match
      ? pages.find((page) =>
          typeof match === 'string' ? page.url.includes(match) : match.test(page.url),
        )
      : pages[0];
    if (found) {
      const socket = new WebSocket(found.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        socket.addEventListener('open', resolve, { once: true });
        socket.addEventListener('error', () => reject(new Error('CDP websocket error')), {
          once: true,
        });
      });
      const session = new CdpSession(socket);
      session.target = found;
      await session.send('Page.enable');
      await session.send('Runtime.enable');
      return session;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(
    `no CDP page target matched ${String(match)}; open pages: ${targets
      .filter((target) => target.type === 'page')
      .map((target) => target.url)
      .join(' | ')}`,
  );
}

/** Open a new tab through the browser endpoint and attach to it. */
export async function openTab(url, { port = 9222, timeoutMs = 30_000 } = {}) {
  const version = await fetchJson(`http://127.0.0.1:${port}/json/version`);
  const socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('browser CDP websocket error')), {
      once: true,
    });
  });
  const browser = new CdpSession(socket);
  // A background tab never produces frames, and `Page.captureScreenshot` then
  // waits forever. Activating it at creation is the difference between a
  // rendered PNG and a 60 s timeout.
  const { targetId } = await browser.send('Target.createTarget', { url, background: false });
  await browser.send('Target.activateTarget', { targetId }).catch(() => undefined);
  browser.close();

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const targets = await listTargets(port).catch(() => []);
    const found = targets.find((target) => target.id === targetId);
    if (found?.webSocketDebuggerUrl) {
      const pageSocket = new WebSocket(found.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        pageSocket.addEventListener('open', resolve, { once: true });
        pageSocket.addEventListener('error', () => reject(new Error('CDP websocket error')), {
          once: true,
        });
      });
      const session = new CdpSession(pageSocket);
      session.target = found;
      await session.send('Page.enable');
      await session.send('Runtime.enable');
      await session.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => undefined);
      return session;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error('created tab never appeared in /json/list');
}

export async function navigate(session, url, { timeoutMs = 60_000, waitUntil = 'load' } = {}) {
  const loaded = waitUntil === 'load' ? session.waitFor('Page.loadEventFired', timeoutMs) : null;
  await session.send('Page.navigate', { url }, timeoutMs);
  if (loaded) await loaded.catch(() => undefined);
  return session;
}

/** Poll an in-page expression until it returns a truthy value. */
export async function waitForExpression(session, expression, { timeoutMs = 60_000, intervalMs = 400 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await session.evaluate(expression);
      if (last) return last;
    } catch (error) {
      last = String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`expression never became truthy: ${expression} (last: ${JSON.stringify(last)})`);
}

export async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
