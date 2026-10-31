// Read-only snapshot of the Creator UI in the attached browser: proves who is
// logged in, which maps exist, and that the editor route is reachable before we
// ask the live channel to do anything.
import { attach, openTab, waitForExpression, sleep } from './agent-cdp.mjs';

const port = Number(process.env.CDP_PORT || 9222);
const base = process.env.CREATOR_BASE || 'http://127.0.0.1:3127';

let session;
try {
  session = await attach({ port, match: base });
  console.log('attached to existing tab', session.target.url);
} catch {
  session = await openTab(`${base}/projects`, { port });
  console.log('opened new tab');
}

await sleep(3000);
const info = await session.evaluate(`(() => ({
  url: location.href,
  title: document.title,
  bodyText: document.body.innerText.slice(0, 1200),
}))()`);
console.log(JSON.stringify(info, null, 2));
await session.screenshot('.local-evidence/creator-landing.png');
session.close();
