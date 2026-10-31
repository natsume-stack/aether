import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MuServer } from '@box/mudb/server';
import { MuClient } from '@box/mudb/client';
import { createLocalSocketServer, createLocalSocket } from '@box/mudb/socket/local';
import { GUIProtocol } from '@box/schema/gui/gui-protocol';
import { GUIScriptProtocol } from '../src/gui/gui-script-protocol';
import { GUIServer } from '../src/gui/gui-server';
import { AnticheatHost } from '../src/anticheat/anticheat-host';
import { AnticheatScript } from '../src/anticheat/anticheat-script';
import { GameConnectionState } from '../src/game-server-schema';
import { AnticheatProtocol } from '../src/anticheat/anticheat-protocol';

async function waitFor(condition: () => boolean) {
  const deadline = Date.now() + 1500;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Bridge condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

test('real player transport -> host -> script API rejects before the actual GUI server applies a message', { timeout: 5000 }, async () => {
  const publicSockets = createLocalSocketServer();
  const privateSockets = createLocalSocketServer();
  const game = new MuServer(publicSockets, undefined, true);
  const scripts = new MuServer(privateSockets, undefined, true);
  const alice: any = { name: 'Alice' };
  const bob: any = { name: 'Bob' };
  const state: any = { connections: { alice: { id: 1, state: GameConnectionState.CONNECTED, sessionData: { user: { id: 'A' } } } }, clock: { tick: 1 } };
  new GUIServer({ server: game, scriptServer: scripts, state });
  const applied: any[] = [];
  const observed: any[] = [];
  const audit: any[] = [];
  const host = new AnticheatHost(scripts, game, state, (id) => id === 'trusted-script', (id) => id === 'trusted-script', value => audit.push(value));
  const script = new MuClient(createLocalSocket({ sessionId: 'trusted-script', server: privateSockets }), undefined, true);
  script.protocol(GUIScriptProtocol).configure({ message: { return() {}, throw() {}, sendMessage: (value) => applied.push({ ...value }) } });
  const api = new AnticheatScript(script, (id) => id === 1 ? alice : id === 2 ? bob : undefined, (error) => { throw error; });
  const player = new MuClient(createLocalSocket({ sessionId: 'alice', server: publicSockets }), undefined, true);
  const protocol = player.protocol(GUIProtocol);
  protocol.configure({ message: Object.fromEntries(Object.keys(GUIProtocol.client).map((key) => [key, () => {}])) as any });
  try {
    await new Promise<void>((resolve, reject) => scripts.start({ ready: () => script.start({ ready: (error) => error ? reject(new Error(error)) : resolve() }) }));
    api.initialize();
    api.onUIEvent((event) => {
      observed.push({ name: event.name, player: event.player });
      if (event.name === 'blocked') event.context.reject('blocked-ui');
    });
    api.finishInitialization();
    await waitFor(() => !!game.messageGuard);
    await new Promise<void>((resolve, reject) => game.start({ ready: () => player.start({ ready: (error) => error ? reject(new Error(error)) : resolve() }) }));
    assert.ok(!game.protocols.some((entry) => entry.schema === AnticheatProtocol), 'private decision protocol must not be exposed on player transport');
    protocol.server.message.sendMessage({ name: 'blocked', payload: JSON.stringify({ playerId: 2, userId: 'B' }) });
    await waitFor(() => observed.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(applied.length, 0);
    assert.equal(observed[0].player, alice, 'body-supplied identity cannot replace the transport owner');
    assert.equal(audit.length, 1);
    assert.equal(audit[0].userId, 'A');
    assert.equal(audit[0].reason, 'blocked-ui');
    assert.equal(audit[0].classification, 'suspected-anomaly');
    protocol.server.message.sendMessage({ name: 'allowed', payload: '{}' });
    await waitFor(() => applied.length === 1);
    assert.equal(applied[0].id, 1);
    script.destroy();
    await waitFor(() => scripts.protocols.every((entry) => !entry.clients['trusted-script']));
    protocol.server.message.sendMessage({ name: 'allowed', payload: '{}' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(applied.length, 1, 'worker loss must not open the guarded operation');
  } finally {
    host.reset();
    if (player.running) player.destroy();
    if (script.running) script.destroy();
    if (game.running) game.destroy();
    if (scripts.running) scripts.destroy();
  }
});
