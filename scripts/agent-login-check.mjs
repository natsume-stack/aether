// Real-browser login + editor verification for the live channel.
//
// Uses the actual login portal (not a forged cookie) so the whole chain is
// proven: portal register → creator session → editor tab → live attach.
import { attach, openTab, navigate, waitForExpression, sleep } from './agent-cdp.mjs';

const PORTAL = 'http://127.0.0.1:3125';
const CREATOR = 'http://127.0.0.1:3127';
const VOXA = 'http://127.0.0.1:3123';
const USERNAME = process.env.BOX_TEST_USER || 'agentdemo';
const PASSWORD = process.env.BOX_TEST_PASS || 'agentdemo123';

async function shot(page, name) {
  await page.screenshot(`.local-evidence/${name}.png`);
  console.log('evidence:', `.local-evidence/${name}.png`);
}

// 1. Register (idempotent: an "already exists" answer is fine, we then log in).
//
// The portal's real routes are /api/auth/register and /api/auth/login
// (apps/player-auth-portal/server/auth.ts); register also requires displayName.
async function ensureAccount(page) {
  await navigate(page, `${PORTAL}/`, { timeoutMs: 60_000 });
  await sleep(2500);
  const result = await page.evaluate(`(async () => {
    const post = async (path, body) => {
      const r = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });
      const text = await r.text();
      let parsed = null;
      try { parsed = JSON.parse(text); } catch { parsed = text.slice(0, 200); }
      return { status: r.status, body: parsed };
    };
    const username = ${JSON.stringify(USERNAME)};
    const password = ${JSON.stringify(PASSWORD)};
    const register = await post('/api/auth/register', {
      username,
      displayName: username,
      password,
    });
    const login = await post('/api/auth/login', { username, password });
    return { register, login };
  })()`);
  console.log('register:', result.register.status, JSON.stringify(result.register.body).slice(0, 200));
  console.log('login:', result.login.status, JSON.stringify(result.login.body).slice(0, 200));
  return result.login.status === 200 || result.login.status === 201;
}

const start = `${CREATOR}/`;
let page;
try {
  page = await attach({ port: 9222, match: '127.0.0.1:3125' });
} catch {
  page = await openTab(`${PORTAL}/`, { port: 9222 });
}
await sleep(1500);
console.log('portal page:', await page.evaluate('location.href'));

const loggedIn = await ensureAccount(page);
await shot(page, 'login-01-portal');
if (!loggedIn) {
  console.log('LOGIN FAILED — stopping here rather than claiming success');
  process.exit(1);
}

// 2. Follow the creator login chain into creator, which should now be a session.
await navigate(page, `${CREATOR}/`, { timeoutMs: 90_000 });
await sleep(4000);
const creatorState = await page.evaluate(`(async () => {
  const r = await fetch('/api/creator/v1/session', { credentials: 'include' });
  const t = await r.text();
  return { status: r.status, url: location.href, body: t.slice(0, 300) };
})()`);
console.log('creator session:', JSON.stringify(creatorState).slice(0, 400));
await shot(page, 'login-02-creator');

// 3. VOXA in the same profile should also be authenticated.
await navigate(page, `${VOXA}/`, { timeoutMs: 90_000 });
await sleep(5000);
const voxaState = await page.evaluate(`(async () => {
  const r = await fetch('/api/agent/v1/state', { cache: 'no-store' });
  const t = await r.text();
  let parsed = null;
  try { parsed = JSON.parse(t); } catch { parsed = null; }
  return {
    status: r.status,
    url: location.href,
    code: parsed && parsed.code,
    hasEditor: Boolean(window.editor),
    live: !!(parsed && parsed.ok === undefined && parsed.code && parsed.code.startsWith('VOX-')),
  };
})()`);
console.log('voxa state:', JSON.stringify(voxaState));
await shot(page, 'login-03-voxa');
page.close();
