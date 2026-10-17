// A realistic-shaped author script: class + closure + Promise + hot tick loop.
// ~5 KB, the shape a BOX3 map author would actually write.
export const AUTHOR_SCRIPT = `
'use strict';
const TICK_MS = 50;
const _entities = new Map();
let _nextId = 1;
let _tick = 0;

class Vector3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  add(o) { return new Vector3(this.x + o.x, this.y + o.y, this.z + o.z); }
  scale(s) { return new Vector3(this.x * s, this.y * s, this.z * s); }
  lengthSq() { return this.x * this.x + this.y * this.y + this.z * this.z; }
  normalized() {
    const len = Math.sqrt(this.lengthSq()) || 1;
    return new Vector3(this.x / len, this.y / len, this.z / len);
  }
  toArray() { return [this.x, this.y, this.z]; }
}

class Entity {
  constructor(name, pos) {
    this.id = _nextId++;
    this.name = name;
    this.pos = pos;
    this.vel = new Vector3();
    this.inventory = [];
    this.handlers = [];
    _entities.set(this.id, this);
  }
  on(event, fn) { this.handlers.push({ event, fn }); return this; }
  emit(event, payload) {
    for (const h of this.handlers) if (h.event === event) h.fn(this, payload);
  }
  integrate(dt) {
    this.pos = this.pos.add(this.vel.scale(dt));
    return this.pos;
  }
  toJSON() { return { id: this.id, name: this.name, pos: this.pos.toArray() }; }
}

function makeInventorySystem(gravity) {
  const dropped = [];
  return {
    drop(entity, item) {
      const clone = Object.assign({}, item, { owner: entity.id, at: entity.pos.toArray() });
      dropped.push(clone);
      return clone;
    },
    sweep(dt) {
      let grounded = 0;
      for (const d of dropped) {
        if (d.at[1] <= 0.05) { grounded++; } else { d.at[1] -= gravity * dt; }
      }
      return grounded;
    },
    count() { return dropped.length; },
  };
}

const inventory = makeInventorySystem(9.81);

function spawnWave(count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const e = new Entity('mob-' + i, new Vector3(i % 16, 10 + (i >> 4), (i * 7) % 32));
    e.vel = new Vector3(Math.sin(i) * 0.4, 0, Math.cos(i) * 0.4);
    e.on('hit', (self, dmg) => { self.vel = self.vel.scale(1 - Math.min(1, dmg / 100)); });
    e.on('death', (self) => { inventory.drop(self, { kind: 'coin', n: 1 + (self.id % 5) }); });
    out.push(e);
  }
  return out;
}

const roster = spawnWave(64);

function runSimulationSteps(steps, dt) {
  let moved = 0;
  for (let s = 0; s < steps; s++) {
    _tick++;
    for (const e of roster) {
      e.integrate(dt);
      if (e.pos.y < 0) { e.emit('hit', e, 12); e.pos = new Vector3(e.pos.x, 10, e.pos.z); }
      moved++;
    }
    inventory.sweep(dt);
  }
  return moved;
}

function deferredWork(n) {
  const waiters = [];
  for (let i = 0; i < n; i++) {
    waiters.push(new Promise((resolve) => {
      Promise.resolve().then(() => resolve(i * i)).then((v) => v + 1);
    }));
  }
  return Promise.all(waiters).then((arr) => arr.reduce((a, b) => a + b, 0));
}

// The exported shell shape the engine calls into via apply()/call() with a timeout.
const shell = {
  name: 'w7-poc-author-script',
  version: 3,
  onTick(payload) {
    const moved = runSimulationSteps(payload.steps, payload.dt);
    inventory.drop(roster[payload.i % roster.length], { kind: 'wood', n: 3 });
    return { tick: _tick, moved, dropped: inventory.count() };
  },
  onJoin(sessionId) {
    const e = new Entity('player-' + sessionId, new Vector3(0, 20, 0));
    e.emit('hit', e, 30);
    return e.toJSON();
  },
  async ping(x) {
    const sum = await deferredWork(48);
    return { sum, echo: x, entities: _entities.size };
  },
  gcProbe(bytes) {
    const chunks = [];
    for (let i = 0; i < bytes; i += 4096) chunks.push(new Uint8Array(4096).fill(i & 0xff));
    return chunks.length;
  },
};
// Engine pattern: the shell is handed back to the host, and the host calls
// methods on it with { timeout }. We also expose one global entrypoint so the
// harness can drive a tick across the isolate boundary.
globalThis.__pocShell = shell;
globalThis.__pocTick = (payload) => shell.onTick(payload);
globalThis.__pocJoin = (sid) => shell.onJoin(sid);
shell;
`;
