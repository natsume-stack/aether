import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { test } from 'node:test';
import { AnticheatScript } from '../src/anticheat/anticheat-script';

const source = fs.readFileSync(path.resolve(__dirname, './fixtures/anticheat/anticheat-policy.js'), 'utf8');
class Vector { constructor(public x: number, public y: number, public z: number) {} }
// Keep the rule and real tracker in the same realm, as in the script isolate.
const helpers = vm.runInThisContext('(function(GameVector3){' + source + '\nreturn {installMapAnticheat,validateAnticheatRay};})')(Vector);

function fixture(observeOnly = false) {
  let handlers: any;
  let tick = 60;
  const replies: any[] = [], errors: unknown[] = [];
  const players = [{}, {}];
  const actor = { id: 'actor', player: players[0], position: { x: 0, y: 0, z: 0 } };
  const target = { id: 'target', player: players[1], position: { x: 3, y: 0, z: 0 } };
  const api = new AnticheatScript({ protocol: () => ({
    configure: (config: any) => { handlers = config.message; },
    server: { message: { listen() {}, listenMessages() {}, initialized() {},
      decision: (reply: any) => replies.push(reply), messageDecision: (reply: any) => replies.push(reply) } },
  }) } as any, id => players[id - 1] as any, error => errors.push(error),
  id => id === 1 ? actor as any : id === 2 ? target as any : undefined, () => tick);
  api.initialize();
  let rayHit: any = { hit: false, distance: -1 };
  let raySpec: any;
  const token = () => ({ cancel() {} });
  const world = { anticheat: api, onPlayerJoin: token, onPlayerLeave: token,
    raycast(origin: any, direction: any, options: any) { raySpec = { origin, direction, options }; return rayHit; } };
  const options = {
    observeOnly, entities: [actor, target],
    movement: { limits: () => ({ positionError: 1, horizontalSpeed: 0.6, riseSpeed: 1, fallSpeed: 20,
      horizontalVelocityError: 0.6, verticalVelocityError: 0.2 }) },
    action: { originRadius: 2, maxPresses: 1, cooldownTicks: { action0: 6, action1: 6 },
      validate: (event: any, action: any) => helpers.validateAnticheatRay(world, action, {
        origin: event.serverPosition, maxDistance: 6, ignoreSelector: '#actor',
      }) },
  };
  let policy = helpers.installMapAnticheat(world, options);
  const zero = () => ({ x: 0, y: 0, z: 0 });
  function movement(to = zero(), velocity = zero(), fromVelocity = zero(), elapsedMs = 16) {
    handlers.movement({ handle: replies.length, playerId: 1, payload: JSON.stringify({
      playerId: 1, from: zero(), to, velocity: { from: fromVelocity, to: velocity },
      elapsedMs, inputTick: 999999, serverTick: 999999, mode: 'play',
    }) });
    return replies.at(-1).allow;
  }
  const click = (targetId = 0) => ({ tick: 999999, buttonState: 1, prevButtonState: 0,
    position: [0, 0, 0], rayOrigin: [0, 0, 0], rayDirection: [2, 0, 0],
    rayHitNormal: [0, 1, 0], rayTime: targetId ? 3 : -1, rayHitEntity: targetId,
    rayHitVoxelX: 0, rayHitVoxelY: 0, rayHitVoxelZ: 0 });
  function action(events = [click()], playerId = 1) {
    handlers.clientMessage({ handle: replies.length, playerId, payload: JSON.stringify({
      protocol: 'game-net', message: 'input', serverTick: 999999, mode: 'play', unreliable: false,
      data: { tick: 999999, input: { inputState: 0, bodies: [] }, events },
    }) });
    return replies.at(-1).allow;
  }
  return { movement, action, click, actor, target, options, world, errors,
    policy: () => policy, setTick: (value: number) => { tick = value; },
    setHit: (value: any) => { rayHit = value; }, raySpec: () => raySpec,
    reinstall: () => { policy.dispose(); policy = helpers.installMapAnticheat(world, options); } };
}

test('normal running, predicted jump, falling, collision tolerance and small correction pass', () => {
  const f = fixture();
  assert.equal(f.movement({ x: 0.25, y: 0, z: 0 }, { x: 0.4, y: 0, z: 0 }), true);
  assert.equal(f.movement(undefined, { x: 0, y: 1, z: 0 }, { x: 0, y: 0.96, z: 0 }), true);
  assert.equal(f.movement(undefined, { x: 0, y: -3, z: 0 }, { x: 0, y: -3, z: 0 }), true);
  assert.equal(f.movement(undefined, { x: 0, y: 0, z: 0 }, { x: 0.1, y: -0.1, z: 0 }), true);
});

test('velocity-only air boost, flight and cancellation of server knockback are rejected', () => {
  const f = fixture();
  assert.equal(f.movement(undefined, { x: 0, y: 0.5, z: 0 }), false);
  assert.equal(f.movement(undefined, { x: 2.5, y: 1.25, z: 0 }), false);
  assert.equal(f.movement(undefined, { x: 0, y: 0, z: 0 }, { x: 5, y: 0, z: 0 }), false);
  const ordinary = f.options.movement.limits();
  f.options.movement.limits = () => ({ ...ordinary, horizontalSpeed: 6 }); // server-authorized impulse profile
  assert.equal(f.movement(undefined, { x: 5, y: 0, z: 0 }, { x: 5, y: 0, z: 0 }), true);
});

test('previous accepted velocity cannot ratchet up the speed limit', () => {
  const f = fixture();
  assert.equal(f.movement(undefined, { x: 0.5, y: 0, z: 0 }), true);
  assert.equal(f.movement(undefined, { x: 0.9, y: 0, z: 0 }, { x: 0.5, y: 0, z: 0 }), false);
  assert.equal(f.movement(undefined, { x: 0, y: 1.1, z: 0 }, { x: 0, y: 0.95, z: 0 }), false);
});

test('long receipt gap cannot authorize teleport; ordinary bounded jitter still passes', () => {
  const f = fixture();
  assert.equal(f.movement({ x: 1000, y: 0, z: 0 }, undefined, undefined, 1e9), false);
  assert.equal(f.movement({ x: 0.5, y: 0, z: 0 }, undefined, undefined, 500), true);
});

test('trusted movement exemption expires on server clock and never exempts attacks', () => {
  const f = fixture(); f.policy().exemptMovement(f.actor.player, 2, 'server teleport');
  assert.equal(f.movement({ x: 1000, y: 0, z: 0 }), true);
  assert.equal(f.action([f.click(), f.click()]), false);
  f.setTick(62);
  assert.equal(f.movement({ x: 1000, y: 0, z: 0 }), false);
});

test('cross-message cooldown uses server time, ignores release and isolates players', () => {
  const f = fixture();
  assert.equal(f.action(), true);
  assert.equal(f.action([{ ...f.click(), buttonState: 0, prevButtonState: 1 }]), true);
  assert.equal(f.action(), false);
  assert.equal(f.action([{ ...f.click(), rayOrigin: [3, 0, 0] }], 2), true);
  f.setTick(66); assert.equal(f.action(), true);
});

test('rejected stacked or invalid-origin packet does not consume normal attack cooldown', () => {
  const f = fixture();
  assert.equal(f.action([f.click(), f.click()]), false);
  assert.equal(f.action([{ ...f.click(), rayOrigin: [1000, 0, 0] }]), false);
  assert.equal(f.action(), true);
});

test('server ray verifies resolved target and ignores forged ray distance', () => {
  const f = fixture();
  f.setHit({ hit: true, hitEntity: f.target, distance: 3 });
  assert.equal(f.action([{ ...f.click(2), rayTime: 0 }]), true);
  assert.equal(f.raySpec().origin.x, 0);
  assert.equal(f.raySpec().direction.x, 1);
  assert.equal(f.raySpec().options.maxDistance, 6);
  f.setTick(66); assert.equal(f.action([f.click(999)]), false);
});

test('occlusion, out-of-range target and mismatched voxel hit are rejected', () => {
  const f = fixture();
  f.setHit({ hit: true, hitEntity: null, hitVoxel: 1, distance: 1, voxelIndex: { x: 1, y: 0, z: 0 } });
  assert.equal(f.action([f.click(2)]), false);
  f.setHit({ hit: true, hitEntity: f.target, distance: 10 });
  assert.equal(f.action([f.click(2)]), false);
  f.setHit({ hit: true, hitEntity: null, hitVoxel: 1, distance: 1, voxelIndex: { x: 1, y: 0, z: 0 } });
  assert.equal(f.action([{ ...f.click(), rayTime: 1, rayHitVoxelX: 999 }]), false);
  assert.equal(f.action([{ ...f.click(), rayTime: 1, rayHitVoxelX: 1 }]), true);
});

test('observe mode records anomalies without rejection; invalid async validators fail closed', () => {
  const f = fixture(true);
  assert.equal(f.movement(undefined, { x: 0, y: 0.5, z: 0 }), true);
  assert.equal(f.policy().movementTracker.getScore(f.actor.player), 1);
  assert.equal(f.policy().movementTracker.getHistory(f.actor.player)[0].data.rejected, false);
  f.options.action.validate = (() => Promise.resolve(null)) as any; f.reinstall();
  assert.equal(f.action(), false);
  assert.equal(f.errors.length, 1);
});

test('reinstall cleans per-player cooldown and old subscriptions', () => {
  const f = fixture(); assert.equal(f.action(), true); f.reinstall();
  assert.equal(f.action(), true);
  assert.equal(f.policy().actionTracker.getHistory(f.actor.player).length, 1);
});
