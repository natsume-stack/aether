import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AnticheatScript } from '../src/anticheat/anticheat-script';
import { ClientWorld } from '@box/script-api';
import { AnticheatProtocol } from '../src/anticheat/anticheat-protocol';
import { permittedCorrections } from '../src/anticheat/net-movement';

function fixture() {
  let tick = 10;
  const api = new (AnticheatScript as any)({ protocol: () => ({ configure() {}, server: { message: {
    listen() {}, listenMessages() {}, initialized() {},
  } } }) }, () => undefined, () => {}, () => undefined, () => tick);
  return { api, alice: {} as any, bob: {} as any, tick: (value: number) => { tick = value; } };
}

test('map-owned history uses server time, independent players and bounded immutable snapshots', () => {
  const f = fixture(), tracker = f.api.createTracker({ historySize: 2 });
  const data = { position: { x: 1 }, clientTick: 99999 };
  const first = tracker.record(f.alice, data); data.position.x = 999;
  assert.equal(first.data.position.x, 1, 'records must not retain mutable caller data');
  f.tick(11); tracker.record(f.alice, { position: { x: 2 } });
  f.tick(12); tracker.record(f.alice, { position: { x: 3 } });
  assert.deepEqual(tracker.getHistory(f.alice), [
    { serverTick: 11, data: { position: { x: 2 } } }, { serverTick: 12, data: { position: { x: 3 } } },
  ]);
  assert.deepEqual(tracker.getHistory(f.bob), []);
  const history = tracker.getHistory(f.alice);
  assert.ok(Object.isFrozen(history));
  assert.throws(() => { history[0].data.position.x = 42; }, TypeError);
  assert.throws(() => { history.push(history[0]); }, TypeError);
  const other = f.api.createTracker({ historySize: 2 });
  assert.deepEqual(other.getHistory(f.alice), [], 'rules must not share player state');
});

test('rule clearing and script initialization discard history, scores and exemption markers', () => {
  const f = fixture(), tracker = f.api.createTracker();
  for (const player of [f.alice, f.bob]) {
    tracker.record(player, { attempt: 1 }); tracker.addScore(player, 3);
    tracker.exempt(player, { ticks: 10, reason: 'test' });
  }
  tracker.clear(f.alice);
  assert.deepEqual(tracker.getHistory(f.alice), []);
  assert.equal(tracker.getScore(f.alice), 0);
  assert.equal(tracker.isExempt(f.alice), false);
  assert.equal(tracker.getScore(f.bob), 3, 'one player clear must not clear another');
  f.api.initialize();
  assert.deepEqual(tracker.getHistory(f.bob), []);
  assert.equal(tracker.getScore(f.bob), 0);
  assert.equal(tracker.isExempt(f.bob), false);
});

test('bad configuration and unbounded/non-JSON evidence fail explicitly without corrupting prior state', () => {
  const f = fixture();
  for (const options of [{ historySize: 0 }, { historySize: 257 }, { historySize: 1.5 },
    { decayPerTick: -1 }, { decayPerTick: Infinity }]) assert.throws(() => f.api.createTracker(options));
  const tracker = f.api.createTracker(); tracker.record(f.alice, { good: true });
  const cyclic: any = {}; cyclic.self = cyclic;
  let getterCalls = 0;
  const arrayGetter = [0];
  Object.defineProperty(arrayGetter, 0, { get() { getterCalls++; return 1; } });
  for (const data of [cyclic, { value: Infinity }, { run() {} }, new Date(),
    { get hidden() { getterCalls++; return 1; } }, arrayGetter, new Array(2), 'x'.repeat(16385)]) {
    assert.throws(() => tracker.record(f.alice, data));
  }
  assert.equal(getterCalls, 0);
  assert.equal(tracker.getHistory(f.alice).length, 1);
  for (const amount of [-1, Infinity, NaN]) assert.throws(() => tracker.addScore(f.alice, amount));
  for (const ticks of [0, -1, Infinity, 1.5]) assert.throws(() => tracker.exempt(f.alice, { ticks }));
  assert.equal(tracker.getScore(f.alice), 0);
  assert.equal(tracker.isExempt(f.alice), false);
});

test('clock rollback cannot increase scores or revive an expired exemption', () => {
  const f = fixture(), tracker = f.api.createTracker({ decayPerTick: 1 });
  tracker.addScore(f.alice, 10); tracker.exempt(f.alice, { ticks: 2 });
  f.tick(15); assert.equal(tracker.getScore(f.alice), 5); assert.equal(tracker.isExempt(f.alice), false);
  f.tick(1); assert.equal(tracker.getScore(f.alice), 5); assert.equal(tracker.isExempt(f.alice), false);
  assert.equal(tracker.serverTick, 15);
});

test('history metadata cannot pollute prototypes and cannot spoof stored server time', () => {
  const f = fixture(), tracker = f.api.createTracker();
  const data = JSON.parse('{"__proto__":{"polluted":true},"serverTick":999999}');
  const entry = tracker.record(f.alice, data);
  assert.equal(entry.serverTick, 10);
  assert.equal(({} as any).polluted, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(entry.data, '__proto__'), true);
});

test('creating or exempting a tracker neither exposes client APIs nor bypasses core ownership checks', () => {
  const client = new ClientWorld({ get: () => true, set() {} });
  assert.equal('anticheat' in client, false);
  assert.equal('createTracker' in client, false);
  assert.ok(!('createTracker' in AnticheatProtocol.server));
  assert.ok(!('exempt' in AnticheatProtocol.server));
  const f = fixture(), tracker = f.api.createTracker();
  tracker.exempt(f.alice, { ticks: 100 });
  const body = { id: 2, px: 999, py: 0, pz: 0, vx: 0, vy: 0, vz: 0 };
  assert.deepEqual(permittedCorrections([body], 1), [], 'map exemption must never grant another player correction authority');
});

test('helper capacity is bounded and script initialization releases the factory capacity', () => {
  const f = fixture();
  for (let i = 0; i < 64; i++) f.api.createTracker();
  assert.throws(() => f.api.createTracker(), /64/);
  f.api.initialize();
  assert.doesNotThrow(() => f.api.createTracker());
});

test('temporary exemptions are scoped to one rule/player and expire only on server ticks', () => {
  const f = fixture(), movement = f.api.createTracker(), combat = f.api.createTracker();
  movement.exempt(f.alice, { ticks: 5, reason: 'map dash' });
  assert.deepEqual(movement.getExemption(f.alice), { untilTick: 15, reason: 'map dash' });
  assert.ok(Object.isFrozen(movement.getExemption(f.alice)));
  assert.equal(movement.isExempt(f.alice), true);
  assert.equal(combat.isExempt(f.alice), false);
  assert.equal(movement.isExempt(f.bob), false);
  f.tick(14); assert.equal(movement.isExempt(f.alice), true);
  f.tick(15); assert.equal(movement.isExempt(f.alice), false);
  assert.equal(movement.getExemption(f.alice), undefined);
  movement.exempt(f.alice, { ticks: 5, reason: 'vehicle' });
  movement.clearExemption(f.alice); assert.equal(movement.isExempt(f.alice), false);
});

test('scores decay by the map-selected rate on server ticks, without deciding punishment', () => {
  const f = fixture(), tracker = f.api.createTracker({ decayPerTick: 0.5 });
  assert.equal(tracker.addScore(f.alice, 5), 5);
  f.tick(14); assert.equal(tracker.getScore(f.alice), 3);
  assert.equal(tracker.addScore(f.alice, 2), 5);
  f.tick(100); assert.equal(tracker.getScore(f.alice), 0);
  assert.equal(tracker.getScore(f.bob), 0);
  const manual = f.api.createTracker();
  manual.addScore(f.alice, 7); f.tick(200);
  assert.equal(manual.getScore(f.alice), 7, 'default must not silently impose a decay policy');
  manual.resetScore(f.alice); assert.equal(manual.getScore(f.alice), 0);
});
