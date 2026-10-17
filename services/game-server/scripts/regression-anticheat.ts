import assert from 'node:assert/strict';
import { MovementGate } from '../src/anticheat/movement-gate';
import { permittedCorrections } from '../src/anticheat/net-movement';
import { AnticheatScript } from '../src/anticheat/anticheat-script';
import { MessageGate } from '../src/anticheat/message-gate';
import { MessageInspector } from '../src/anticheat/message-inspector';
import { MuServer } from '@box/mudb/server';
import { MuStruct, MuUTF8 } from '@box/mudb/schema';
import { GameConnectionState } from '../src/game-server-schema';
import { MuClient } from '@box/mudb/client';
import { MuUint32 } from '@box/mudb/schema';
import { createLocalSocketServer, createLocalSocket } from '@box/mudb/socket/local';

async function main() {
  const sample = { playerId: 1, from: { x: 0, y: 0, z: 0 }, to: { x: 4, y: 0, z: 0 }, velocity: { from: { x: 0, y: 0, z: 0 }, to: { x: 1, y: 0, z: 0 } }, elapsedMs: 64, inputTick: 1, serverTick: 1, mode: 'play' as const };
  let handle = 0;
  const decisions: boolean[] = [];
  const gate = new MovementGate((id) => { handle = id; }, 10);
  gate.submit(sample, (allow) => decisions.push(allow));
  gate.decide(handle, 2, true);
  assert.equal(decisions.length, 0, 'cannot approve another player');
  gate.submit(sample, (allow) => decisions.push(allow));
  assert.deepEqual(decisions, [false], 'one pending correction per player');
  gate.decide(handle, 1, false);
  gate.decide(handle, 1, true);
  assert.deepEqual(decisions, [false, false], 'late decisions cannot revive rejected requests');
  gate.submit(sample, (allow) => decisions.push(allow));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(decisions.at(-1), false, 'timeout rejects correction');

  const position = { px: 0, py: 0, pz: 0, vx: 0, vy: 0, vz: 0 };
  assert.deepEqual(permittedCorrections([
    { ...position, id: 1 }, { ...position, id: 2 }, { ...position, id: 3 }, { ...position, id: 4, px: NaN },
  ], 1).map((body) => body.id), [1]);

  let movement: (message: any) => void = () => {};
  const subscriptions: boolean[] = [];
  const replies: any[] = [];
  const errors: unknown[] = [];
  let clientMessage: (message: any) => void = () => {};
  const client = { protocol: () => ({
    configure: (handlers: any) => { movement = handlers.message.movement; clientMessage = handlers.message.clientMessage; },
    server: { message: { listen: (enabled: boolean) => subscriptions.push(enabled), listenMessages() {}, decision: (reply: any) => replies.push(reply), messageDecision: (reply: any) => replies.push(reply) } },
  }) };
  const api = new AnticheatScript(client as any, (id) => id === 1 ? {} as any : undefined, (error) => errors.push(error));
  let savedReject = () => {};
  const token = api.onMovement((event) => {
    assert.ok(Object.isFrozen(event.from));
    assert.equal(event.context.source, 'client-correction');
    savedReject = event.context.reject;
    event.context.reject();
  });
  movement({ handle: 12, playerId: 1, payload: JSON.stringify(sample) });
  assert.equal(replies.at(-1).allow, false);

  token.cancel();
  assert.equal(token.active(), false);
  token.resume();
  assert.equal(token.active(), true);
  token.cancel();
  api.onMovement(() => {});
  movement({ handle: 13, playerId: 1, payload: JSON.stringify(sample) });
  savedReject();
  assert.equal(replies.at(-1).allow, true, 'reject only works during its own callback');
  api.onMovement(async () => {});
  movement({ handle: 14, playerId: 1, payload: JSON.stringify(sample) });
  assert.equal(replies.at(-1).allow, false, 'async listeners are not silently approved');
  assert.equal(errors.length, 1);
  assert.deepEqual(subscriptions.slice(0, 4), [true, false, true, false]);
  api.onMessage((event) => {
    assert.equal(event.message, 'chat');
    assert.ok(Object.isFrozen(event.data));
    event.context.reject();
  });
  clientMessage({ handle: 15, playerId: 1, payload: JSON.stringify({ protocol: 'chat', message: 'chat', data: { content: 'test' }, serverTick: 1, mode: 'play', unreliable: false }) });
  assert.equal(replies.at(-1).allow, false);

  const order: number[] = [];
  const target: any = { id: 'target' };
  const classified = new AnticheatScript(client as any, () => ({} as any), (error) => { throw error; }, (id) => id === 42 ? target : undefined);
  let inputs = 0; let keys = 0; let interactions = 0; let custom = 0; let ui = 0;
  classified.onInput((event) => { inputs++; assert.equal(event.buttons.fly, true); event.context.reject(); });
  classified.onKeyboard((event) => { keys++; assert.deepEqual(event.pressed, [68]); assert.deepEqual(event.released, [65]); });
  classified.onInteract((event) => { interactions++; assert.equal(event.target, target); });
  classified.onCustomEvent((event) => { custom++; assert.deepEqual(event.data, { action: 'test' }); assert.ok(Object.isFrozen(event.data)); });
  classified.onUIEvent((event) => { ui++; assert.equal(event.name, 'button'); assert.deepEqual(event.data, { value: 1 }); event.context.reject(); });
  const emit = (protocol: string, message: string, data: unknown) => clientMessage({ handle: 20, playerId: 1,
    payload: JSON.stringify({ protocol, message, data, serverTick: 2, mode: 'play', unreliable: false }) });
  emit('game-net', 'input', { tick: 1, input: { inputState: 128 } });
  assert.equal(replies.at(-1).allow, false);
  emit('game-net', 'sendKeyBoardEvent', { tick: 1, keyDownState: [68], prevKeyDownState: [65] });
  emit('entity-interact', 'interact', { tick: 1, id: 42 });
  emit('remote-channel', 'sendServerEvent', { tick: 1, args: JSON.stringify({ action: 'test' }) });
  emit('game-net', 'acknowledge', 1);
  emit('gui', 'sendMessage', { name: 'button', payload: '{"value":1}' });
  assert.equal(replies.at(-1).allow, false);
  assert.deepEqual([inputs, keys, interactions, custom], [1, 1, 1, 1]);
  assert.equal(ui, 1);
  emit('remote-channel', 'sendServerEvent', { tick: 1, args: 'not JSON' });
  assert.equal(replies.at(-1).allow, false);
  const ordered = new MessageGate();
  let first = 0; let second = 0;
  ordered.submit(1, (id) => { first = id; }, (allow) => { if (allow) order.push(1); });
  ordered.submit(1, (id) => { second = id; }, (allow) => { if (allow) order.push(2); });
  ordered.decide(second, 1, true);
  assert.equal(order.length, 0);
  ordered.decide(first, 1, true);
  assert.deepEqual(order, [1, 2]);

  const mu = new MuServer({} as any);
  const schema = new MuStruct({ content: new MuUTF8() });
  let finish: (allow: boolean) => void = () => {};
  let dispatched = '';
  mu.messageGuard = (_event, complete) => { finish = complete; };
  const original = schema.clone({ content: 'original' });
  (mu as any)._guardMessage({ sessionId: 'peer', protocol: 'chat', message: 'chat', data: original, unreliable: false }, schema,
    (data: any) => { dispatched = data.content; });
  original.content = 'changed';
  schema.free(original);
  finish(true);
  finish(false);
  assert.equal(dispatched, 'original', 'guard retains a private clone across decode-buffer reuse');
  let called = false;
  (mu as any)._guardMessage({ sessionId: 'peer', protocol: 'chat', message: 'chat', data: { content: 'reject' }, unreliable: false }, schema, () => { called = true; });
  finish(false);
  assert.equal(called, false);

  const connection = { id: 1, state: GameConnectionState.CONNECTED };
  const state: any = { connections: { peer: connection }, clock: { tick: 1 } };
  const inspector = new MessageInspector(mu, state);
  let request = 0; let payload = '';
  inspector.listen((id, _playerId, data) => { request = id; payload = data; });
  mu.messageGuard!({ sessionId: 'peer', protocol: 'custom', message: 'event', data: { value: 3, secret: 'hidden' }, unreliable: false }, (allow) => { called = allow; });
  assert.equal(JSON.parse(payload).data.secret, '[redacted]');
  state.connections.peer = { ...connection };
  inspector.decide(request, 1, true);
  assert.equal(called, false, 'stale replies cannot apply to a replaced connection');
  inspector.listen();
  assert.equal(mu.messageGuard, undefined);
  await wireRegression();
  console.log('Anticheat regression passed: bounded decisions, rejection, timeout, cancellation, ownership and synchronous listeners');
}

async function wireRegression() {
  const sockets = createLocalSocketServer();
  const socket = createLocalSocket({ sessionId: 'trusted-sender', server: sockets });
  const server = new MuServer(sockets, undefined, true);
  const client = new MuClient(socket, undefined, true);
  const protocolSchema = { name: 'test-game', server: { chat: new MuStruct({ content: new MuUTF8() }), press: new MuUint32() }, client: {} };
  const accepted: string[] = [];
  const receiver = server.protocol(protocolSchema);
  receiver.configure({ message: { chat: (_peer, value) => accepted.push(value.content), press: () => accepted.push('press') }, raw: () => accepted.push('raw') });
  const sender = client.protocol(protocolSchema);
  sender.configure({ message: {} });
  try {
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('Wire regression timed out')), 1500);
      let count = 0;
      server.messageGuard = (event, complete) => {
        assert.equal(event.sessionId, 'trusted-sender');
        assert.equal(event.protocol, 'test-game');
        setTimeout(() => {
          complete(event.message === 'chat');
          if (++count === 3) { clearTimeout(deadline); resolve(); }
        }, 5);
      };
      server.start({ ready: () => client.start({ ready: () => {
        sender.server.message.chat({ content: 'allowed' });
        sender.server.message.press(1);
        sender.server.sendRaw(new Uint8Array([1, 2, 3]));
      } }) });
    });
    assert.deepEqual(accepted, ['allowed'], 'typed and raw messages are intercepted before business handlers');
  } finally {
    if (client.running) client.destroy();
    if (server.running) server.destroy();
  }
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
