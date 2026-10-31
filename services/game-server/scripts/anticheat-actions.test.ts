import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AnticheatScript } from '../src/anticheat/anticheat-script';
import { NetInputEventBits as Bits } from '@box/schema/net/net-schema';
import { MuServer } from '@box/mudb/server';
import { MuClient } from '@box/mudb/client';
import { createLocalSocketServer, createLocalSocket } from '@box/mudb/socket/local';
import { NetInputEventSchema, TimestampedClientInputSchema, NetInputSchema, NetProtocolSchema, ClientScriptSrcSchema } from '@box/schema/net/net-schema';
import { NetServerStateSchema } from '../src/net/net-server-state';
import { GameConnectionSchema, GameConnectionState } from '../src/game-server-schema';
import { NetServer } from '../src/net/net-server-controller';
import { AnticheatHost } from '../src/anticheat/anticheat-host';
import { AnticheatProtocol } from '../src/anticheat/anticheat-protocol';

function fixture() {
  let receive: (message: any) => void;
  const replies: any[] = [], masks: number[] = [], errors: unknown[] = [];
  const actor = { position: { x: 1, y: 2, z: 3 } };
  const target = { id: 'target', position: { x: 4, y: 2, z: 3 } };
  const api = new AnticheatScript({ protocol: () => ({
    configure: (value: any) => { receive = value.message.clientMessage; },
    server: { message: { listenMessages: (mask: number) => masks.push(mask),
      messageDecision: (reply: any) => replies.push(reply) } },
  }) } as any, () => ({ name: 'sender' }) as any, error => errors.push(error), id => id === 1 ? actor as any : id === 2 ? target as any : undefined);
  const send = (events: any[]) => {
    receive!({ handle: replies.length, playerId: 1, payload: JSON.stringify({
      protocol: 'game-net', message: 'input', serverTick: 42, mode: 'play', unreliable: false,
      data: { tick: 999, input: { inputState: 0 }, events },
    }) });
    return replies.at(-1).allow;
  };
  const click = () => ({ tick: 999, buttonState: Bits.ACTION0, prevButtonState: 0,
    position: [900, 900, 900], rayOrigin: [900, 900, 900], rayDirection: [1, 0, 0],
    rayHitNormal: [0, 1, 0], rayTime: 0, rayHitEntity: 2,
    rayHitVoxelX: 5, rayHitVoxelY: 6, rayHitVoxelZ: 7 });
  return { api, send, click, actor, target, masks, errors };
}

test('action target resolves only through the server entity registry', () => {
  const f = fixture();
  const resolved: unknown[] = [];
  f.api.onAction(event => { resolved.push(event.actions[0].target); });
  assert.equal(f.send([f.click()]), true);
  assert.equal(resolved[0], f.target);
  const unknown = f.click(); unknown.rayHitEntity = 999;
  assert.equal(f.send([unknown]), true);
  assert.equal(resolved[1], undefined);
});

test('forged ray origin is observable independently of continuous input flags', () => {
  const f = fixture();
  (f.api as any).onAction((event: any) => {
    assert.deepEqual(event.serverPosition, { x: 1, y: 2, z: 3 });
    assert.equal(event.context.serverTick, 42);
    assert.equal(event.actions[0].targetId, 2);
    assert.equal(event.actions[0].ray.origin.x, 900);
    assert.equal(event.actions[0].button, 'action0');
    assert.equal(event.actions[0].pressed, true);
    assert.ok(Object.isFrozen(event.actions[0].ray.origin));
    event.context.reject();
  });
  assert.equal(f.send([f.click()]), false);
  assert.deepEqual(f.masks, [64]);
  assert.deepEqual(f.errors, [], 'callback assertions must not be mistaken for successful rejection');
});

test('stacked attack events reach the owner rule rather than disappearing into button flags', () => {
  const f = fixture();
  (f.api as any).onAction(({ actions, context }: any) => {
    if (actions.filter((action: any) => action.pressed).length > 1) context.reject();
  });
  assert.equal(f.send([f.click(), f.click(), f.click()]), false);
  assert.equal(f.send([f.click()]), true, 'engine must not impose a fixed weapon range/cooldown');
});

test('malformed action data cannot skip its listener and cannot alter server position', () => {
  const f = fixture(); let calls = 0;
  (f.api as any).onAction(() => { calls++; });
  assert.equal(f.send([{ ...f.click(), rayOrigin: [0, 0] }]), false);
  assert.equal(calls, 0);
  assert.deepEqual(f.actor.position, { x: 1, y: 2, z: 3 });
});

test('owner can reject repeated attacks across messages using server ticks rather than forged client ticks', () => {
  const f = fixture(); let previous: number | undefined;
  f.api.onAction(({ context }) => {
    if (previous !== undefined && context.serverTick - previous < 4) context.reject();
    else previous = context.serverTick;
  });
  assert.equal(f.send([f.click()]), true);
  assert.equal(f.send([{ ...f.click(), tick: 100000 }]), false);
  assert.deepEqual(f.errors, []);
});

test('action rejection crosses real public/private transports before the engine queues gameplay events', { timeout: 5000 }, async () => {
  const publicSockets = createLocalSocketServer(), privateSockets = createLocalSocketServer();
  const game = new MuServer(publicSockets, undefined, true), scripts = new MuServer(privateSockets, undefined, true);
  const connection = GameConnectionSchema.alloc();
  connection.id = 1; connection.state = GameConnectionState.CONNECTED; connection.sessionData.user.id = 'A';
  connection.net.statePaused = false;
  const net = NetServerStateSchema.alloc(); net.inputs.push(NetInputSchema.alloc());
  const logs: string[] = [];
  const logger: any = { create: () => logger, info() {}, log() {}, warn: (text: string) => logs.push(text), error: (text: string) => logs.push(text) };
  const state: any = { connections: { alice: connection }, net, logger, settings: { playerLimit: 10 },
    clock: { tick: 0 }, scriptSrc: { clientSrc: ClientScriptSrcSchema.alloc() },
    players: [], bodies: [], events: { net: [], join: [] } };
  new NetServer({ server: game, state, connect: async () => true, disconnect() {}, hotProject: {} as any });
  const host = new AnticheatHost(scripts, game, state, id => id === 'script');
  const script = new MuClient(createLocalSocket({ sessionId: 'script', server: privateSockets }), undefined, true);
  let observed = 0, reject = true;
  const api = new AnticheatScript(script, () => ({ name: 'Alice' }) as any, error => { throw error; },
    () => ({ position: { x: 0, y: 0, z: 0 } }) as any);
  const player = new MuClient(createLocalSocket({ sessionId: 'alice', server: publicSockets }), undefined, true);
  const protocol = player.protocol(NetProtocolSchema);
  protocol.configure({ message: Object.fromEntries(Object.keys(NetProtocolSchema.client).map(key => [key, () => {}])) as any });
  async function waitFor(condition: () => boolean, stage: string) {
    const deadline = Date.now() + 1500;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error(`Action bridge timeout: ${stage}; observed=${observed}; logs=${logs.join(',')}`);
      await new Promise(resolve => setTimeout(resolve, 2));
    }
  }
  try {
    await new Promise<void>((resolve, fail) => scripts.start({ ready: () => script.start({ ready: error => error ? fail(new Error(error)) : resolve() }) }));
    api.initialize();
    const tracker = api.createTracker();
    api.onAction(event => {
      tracker.exempt(event.player, { ticks: 100, reason: 'one map rule only' });
      assert.equal(tracker.isExempt(event.player), true);
    });
    api.onAction(event => { observed++; if (reject) event.context.reject(); });
    api.finishInitialization();
    await waitFor(() => !!game.messageGuard, 'subscription');
    await new Promise<void>((resolve, fail) => game.start({ ready: () => player.start({ ready: error => error ? fail(new Error(error)) : resolve() }) }));
    await new Promise(resolve => setTimeout(resolve, 10));
    connection.net.statePaused = false;
    assert.ok(!game.protocols.some(entry => entry.schema === AnticheatProtocol));
    const packet = TimestampedClientInputSchema.alloc();
    const click = NetInputEventSchema.alloc(); click.tick = 1; click.buttonState = Bits.ACTION0; click.rayHitEntity = 2;
    packet.events.push(click);
    protocol.server.message.input(packet);
    await waitFor(() => observed === 1, 'rejection');
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(state.events.net.length, 0, 'a tracker exemption cannot override another listener rejection or actual engine dispatch');
    reject = false;
    protocol.server.message.input(packet);
    await waitFor(() => state.events.net.length === 1, 'approval');
    assert.equal(state.events.net[0].id, 1);
    TimestampedClientInputSchema.free(packet);
  } finally {
    host.reset();
    if (player.running) player.destroy();
    if (script.running) script.destroy();
    if (game.running) game.destroy();
    if (scripts.running) scripts.destroy();
  }
});
